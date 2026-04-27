// Migration: redirect "Jubelio Sync Item*" entries to their proper product
// items, then mark the generics inactive.
//
// Why redirect instead of rename:
//   QBO Item.Name is unique. The proper product name is often already taken
//   by another Item (created earlier by integration retries or set up manually
//   as Inventory). Trying to rename a generic to the proper name fails with
//   "Duplicate Name Exists". Redirecting invoice line ItemRefs to the existing
//   proper item is more robust and works for all cases (single-product,
//   ambiguous multi-product, and unused).
//
// Process per generic item:
//   1. Find every Invoice line whose SalesItemLineDetail.ItemRef references it
//   2. For each line, resolve the proper item by line.Description:
//        - Match existing QBO Item by Name (Service / Inventory / NonInventory)
//        - If not found, create new Service item with that name
//        - If create hits "Duplicate Name", parse the existing Id from the
//          error and use that
//   3. Update the Invoice with the line's ItemRef swapped to the proper item
//      (sparse update, full Line array; falls back gracefully on AST errors)
//   4. After ALL lines successfully redirected, mark the generic Active=false
//      (or skip if any line failed — leaves generic alone for retry)
//
// Dry-run by default — set apply=true to actually mutate QBO.

const CTRL_RE = new RegExp('[\\u0000-\\u001F]', 'g');
const sanitizeItemName = (raw) => {
    const cleaned = String(raw || '')
        .replace(/:/g, '-')
        .replace(CTRL_RE, '')
        .replace(/\s+/g, ' ')
        .replace(/'/g, '')
        .trim();
    return cleaned.substring(0, 100);
};

const SAFE_ITEM_TYPES = new Set(['Service', 'Inventory', 'NonInventory']);

const qboBaseUrl = (qbo) => {
    const host = qbo.useSandbox ? 'sandbox-quickbooks.api.intuit.com' : 'quickbooks.api.intuit.com';
    return `https://${host}/v3/company/${qbo.realmId}`;
};

const qboFetch = async (qbo, path, opts = {}) => {
    const url = `${qboBaseUrl(qbo)}${path}${path.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
    const res = await fetch(url, {
        ...opts,
        headers: {
            Authorization: `Bearer ${qbo.token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(opts.headers || {}),
        },
    });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) {
        const err = new Error(`QBO ${opts.method || 'GET'} ${path} (${res.status}): ${JSON.stringify(body).slice(0, 400)}`);
        err.status = res.status;
        err.body = body;
        throw err;
    }
    return body;
};

// Resolve an income account id (for creating new Service items). Caches.
let _incomeAccountId = null;
const getIncomeAccountId = async (qbo) => {
    if (process.env.QBO_INCOME_ACCOUNT_ID) return process.env.QBO_INCOME_ACCOUNT_ID;
    if (_incomeAccountId) return _incomeAccountId;
    const q = `SELECT Id, Name FROM Account WHERE AccountType = 'Income'`;
    const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
    const accounts = body?.QueryResponse?.Account || [];
    if (accounts.length === 0) return null;
    const sales = accounts.find(a => /sales|revenue|pendapatan|penjualan/i.test(a.Name)) || accounts[0];
    _incomeAccountId = String(sales.Id);
    return _incomeAccountId;
};

// 1) Find all "Jubelio Sync Item*" entries
const findGenericItems = async (qbo) => {
    const out = [];
    const PAGE = 200;
    for (let startPosition = 1; startPosition < 5000; startPosition += PAGE) {
        const q = `SELECT Id, Name, Type, Sku, Description, Active, SyncToken FROM Item WHERE Name LIKE 'Jubelio Sync Item%' STARTPOSITION ${startPosition} MAXRESULTS ${PAGE}`;
        const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const items = body?.QueryResponse?.Item || [];
        if (items.length === 0) break;
        out.push(...items);
        if (items.length < PAGE) break;
    }
    return out;
};

// Scan ALL invoices once, building a map: itemId → [{invoice}]. Far cheaper
// than re-scanning per generic when there are several to migrate.
const buildItemRefIndex = async (qbo, targetItemIds) => {
    const targetSet = new Set(targetItemIds.map(String));
    const index = new Map(); // itemId(string) → array of { invoiceId, docNumber, ..., lines, rawInvoice }
    for (const id of targetSet) index.set(id, []);

    const PAGE = 200;
    let scanned = 0;
    for (let startPosition = 1; startPosition < 5000; startPosition += PAGE) {
        const q = `SELECT * FROM Invoice STARTPOSITION ${startPosition} MAXRESULTS ${PAGE}`;
        const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const invoices = body?.QueryResponse?.Invoice || [];
        if (invoices.length === 0) break;
        scanned += invoices.length;
        for (const inv of invoices) {
            // Group lines by ItemRef so each invoice contributes once per item.
            const linesByItem = new Map();
            for (const l of inv.Line || []) {
                if (l.DetailType !== 'SalesItemLineDetail') continue;
                const refId = String(l.SalesItemLineDetail?.ItemRef?.value || '');
                if (!targetSet.has(refId)) continue;
                if (!linesByItem.has(refId)) linesByItem.set(refId, []);
                linesByItem.get(refId).push(l);
            }
            for (const [refId, matchedLines] of linesByItem) {
                index.get(refId).push({
                    invoiceId: inv.Id,
                    docNumber: inv.DocNumber,
                    txnDate: inv.TxnDate,
                    syncToken: inv.SyncToken,
                    lines: matchedLines,
                    rawInvoice: inv,
                });
            }
        }
        if (invoices.length < PAGE) break;
    }
    console.log(`  📊 Scanned ${scanned} invoices, indexed ${[...index.entries()].map(([k, v]) => `${k}=${v.length}`).join(' ')}`);
    return index;
};

// Strip integration-added suffixes from line description.
const cleanDescription = (desc) =>
    String(desc || '').replace(/\s*\[@Rp[^\]]*\]\s*$/, '').trim();

// 3) Resolve target Item by Description. Returns { id, name, created } or null.
const findOrCreateItemByDescription = async (qbo, desc, incomeAccountId, cache) => {
    const name = sanitizeItemName(desc);
    if (!name) return null;
    if (cache.has(name)) return cache.get(name);

    // Match existing
    const q = `SELECT Id, Name, Type FROM Item WHERE Name = '${name.replace(/'/g, "\\'")}'`;
    const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
    const items = body?.QueryResponse?.Item || [];
    const usable = items.find(i => SAFE_ITEM_TYPES.has(i.Type));
    if (usable) {
        const result = { id: String(usable.Id), name: usable.Name, type: usable.Type, created: false };
        cache.set(name, result);
        return result;
    }
    if (items.some(i => i.Type === 'Category')) {
        // Category collision — try suffix variant
        const variant = sanitizeItemName(`${name} (Service)`);
        if (variant !== name) {
            const r = await findOrCreateItemByDescription(qbo, variant, incomeAccountId, cache);
            cache.set(name, r);
            return r;
        }
    }

    // Create new Service
    if (!incomeAccountId) {
        return null;
    }
    try {
        const created = await qboFetch(qbo, '/item', {
            method: 'POST',
            body: JSON.stringify({
                Name: name,
                Type: 'Service',
                IncomeAccountRef: { value: incomeAccountId },
                Description: desc.substring(0, 4000),
            }),
        });
        const item = created?.Item;
        if (item) {
            const result = { id: String(item.Id), name: item.Name, type: item.Type, created: true };
            cache.set(name, result);
            return result;
        }
    } catch (e) {
        // Duplicate-name → recover existing Id from error message
        const detail = JSON.stringify(e.body || {}).slice(0, 600);
        const idMatch = /Id=(\d+)/i.exec(detail);
        if (idMatch) {
            const existingId = idMatch[1];
            const got = await qboFetch(qbo, `/item/${existingId}`);
            const existing = got?.Item;
            if (existing && SAFE_ITEM_TYPES.has(existing.Type)) {
                const result = { id: String(existing.Id), name: existing.Name, type: existing.Type, created: false, recoveredFromDuplicate: true };
                cache.set(name, result);
                return result;
            }
        }
        if (/Duplicate Name Exists/i.test(detail)) {
            // Re-query — sometimes duplicate detector triggers on near-match
            const r2 = await qboFetch(qbo, `/query?query=${encodeURIComponent(`SELECT Id, Name, Type FROM Item WHERE Name = '${name.replace(/'/g, "\\'")}'`)}`);
            const list = r2?.QueryResponse?.Item || [];
            const ok = list.find(i => SAFE_ITEM_TYPES.has(i.Type));
            if (ok) {
                const result = { id: String(ok.Id), name: ok.Name, type: ok.Type, created: false, recoveredFromDuplicate: true };
                cache.set(name, result);
                return result;
            }
        }
        throw e;
    }
    return null;
};

// 4) Update one invoice's line ItemRef. Sparse update with full current Line array.
const redirectLineItemRef = async (qbo, invoice, targetLineId, newItemId) => {
    const newLines = (invoice.rawInvoice.Line || []).map(l => {
        if (String(l.Id) === String(targetLineId) && l.DetailType === 'SalesItemLineDetail') {
            return {
                ...l,
                SalesItemLineDetail: {
                    ...l.SalesItemLineDetail,
                    ItemRef: { value: String(newItemId) },
                },
            };
        }
        return l;
    });
    return qboFetch(qbo, '/invoice', {
        method: 'POST',
        body: JSON.stringify({
            Id: invoice.invoiceId,
            SyncToken: invoice.syncToken,
            sparse: true,
            Line: newLines,
        }),
    });
};

// 5) Mark item inactive (sparse Active=false).
const markItemInactive = async (qbo, item) => {
    return qboFetch(qbo, '/item', {
        method: 'POST',
        body: JSON.stringify({
            Id: item.Id,
            SyncToken: item.SyncToken,
            sparse: true,
            Active: false,
        }),
    });
};

const runItemMigration = async ({ qbo, apply = false }) => {
    const t0 = Date.now();
    const mode = apply ? 'APPLY' : 'DRY-RUN';
    console.log(`\n🔧 Item migration v2 (${mode})\n`);

    const generics = await findGenericItems(qbo);
    console.log(`Found ${generics.length} "Jubelio Sync Item*" entries`);

    const incomeAccountId = await getIncomeAccountId(qbo);
    const itemCache = new Map(); // name → resolved item

    // Single QBO invoice scan that indexes all generic-item references at once.
    const refIndex = await buildItemRefIndex(qbo, generics.map(g => g.Id));

    const report = {
        apply,
        mode,
        runMs: 0,
        totalGeneric: generics.length,
        perItem: [],
        summary: {
            redirectedLines: 0,
            inactivated: 0,
            errors: 0,
            skipped: 0,
        },
    };

    for (const item of generics) {
        const itemReport = {
            itemId: item.Id,
            currentName: item.Name,
            type: item.Type,
            invoicesScanned: 0,
            linesRedirected: [],
            errors: [],
            inactivated: false,
        };

        try {
            const invoices = refIndex.get(String(item.Id)) || [];
            itemReport.invoicesScanned = invoices.length;

            if (invoices.length === 0) {
                // Unused — safe to mark inactive
                itemReport.action = 'mark-inactive (no references)';
                if (apply) {
                    try {
                        await markItemInactive(qbo, item);
                        itemReport.inactivated = true;
                        report.summary.inactivated++;
                        console.log(`  ✅ Inactivated unused ${item.Id} "${item.Name}"`);
                    } catch (e) {
                        itemReport.errors.push({ stage: 'mark-inactive', error: e.message });
                        report.summary.errors++;
                    }
                } else {
                    console.log(`  📝 Would inactivate unused ${item.Id} "${item.Name}"`);
                }
                report.perItem.push(itemReport);
                continue;
            }

            itemReport.action = `redirect-${invoices.reduce((n, inv) => n + inv.lines.length, 0)}-lines`;

            // Redirect each line
            for (const inv of invoices) {
                for (const line of inv.lines) {
                    const desc = cleanDescription(line.Description);
                    if (!desc) {
                        itemReport.errors.push({ stage: 'resolve', invoice: inv.docNumber, lineId: line.Id, error: 'empty description' });
                        continue;
                    }
                    try {
                        const target = await findOrCreateItemByDescription(qbo, desc, incomeAccountId, itemCache);
                        if (!target || !target.id) {
                            itemReport.errors.push({ stage: 'resolve', invoice: inv.docNumber, lineId: line.Id, desc, error: 'no target resolved' });
                            continue;
                        }
                        if (target.id === String(item.Id)) {
                            // Self-reference — would loop. Skip.
                            itemReport.errors.push({ stage: 'resolve', invoice: inv.docNumber, lineId: line.Id, error: 'target = source' });
                            continue;
                        }

                        const action = {
                            invoice: inv.docNumber,
                            invoiceId: inv.invoiceId,
                            lineId: line.Id,
                            fromItemId: String(item.Id),
                            toItemId: target.id,
                            toName: target.name,
                            description: desc,
                            targetCreated: target.created || false,
                        };

                        if (apply) {
                            try {
                                const updated = await redirectLineItemRef(qbo, inv, line.Id, target.id);
                                action.applied = true;
                                action.newSyncToken = updated?.Invoice?.SyncToken;
                                // Update local invoice copy for next-line iteration
                                inv.syncToken = updated?.Invoice?.SyncToken || inv.syncToken;
                                inv.rawInvoice = updated?.Invoice || inv.rawInvoice;
                                itemReport.linesRedirected.push(action);
                                report.summary.redirectedLines++;
                                console.log(`  ✅ ${inv.docNumber} line=${line.Id}: ${item.Id} → ${target.id} (${target.name.substring(0, 40)})`);
                            } catch (e) {
                                action.applied = false;
                                action.error = e.message;
                                const isAst = /sales tax rate|Business Validation/i.test(e.message);
                                itemReport.errors.push({
                                    stage: 'redirect',
                                    invoice: inv.docNumber,
                                    lineId: line.Id,
                                    isAst,
                                    error: e.message.slice(0, 300),
                                });
                                report.summary.errors++;
                                console.log(`  ❌ ${inv.docNumber} line=${line.Id}: ${e.message.slice(0, 120)}`);
                            }
                        } else {
                            console.log(`  📝 ${inv.docNumber} line=${line.Id}: would redirect ${item.Id} → ${target.id} "${target.name.substring(0, 40)}" ${target.created ? '(NEW)' : ''}`);
                            itemReport.linesRedirected.push({ ...action, applied: false });
                        }
                    } catch (e) {
                        itemReport.errors.push({ stage: 'resolve', invoice: inv.docNumber, lineId: line.Id, desc, error: e.message.slice(0, 300) });
                        report.summary.errors++;
                    }
                }
            }

            // Mark inactive only if ALL lines successfully redirected
            const allLinesOk = itemReport.errors.length === 0 && itemReport.linesRedirected.length > 0;
            if (apply && allLinesOk) {
                try {
                    // Re-fetch item to get fresh SyncToken
                    const fresh = await qboFetch(qbo, `/item/${item.Id}`);
                    await markItemInactive(qbo, fresh.Item);
                    itemReport.inactivated = true;
                    report.summary.inactivated++;
                    console.log(`  🗑️  Inactivated ${item.Id} "${item.Name}" (all lines redirected)`);
                } catch (e) {
                    itemReport.errors.push({ stage: 'mark-inactive', error: e.message });
                    report.summary.errors++;
                }
            } else if (apply) {
                console.log(`  ⏭  ${item.Id} "${item.Name}" left active (errors=${itemReport.errors.length})`);
                report.summary.skipped++;
            }
        } catch (e) {
            itemReport.errors.push({ stage: 'scan', error: e.message });
            report.summary.errors++;
            console.error(`  💥 ${item.Id} "${item.Name}": ${e.message}`);
        }

        report.perItem.push(itemReport);
    }

    report.runMs = Date.now() - t0;
    console.log(`\n✅ ${mode} done in ${report.runMs}ms · redirected=${report.summary.redirectedLines} inactivated=${report.summary.inactivated} errors=${report.summary.errors}`);
    return report;
};

// ─── TREELOGY brand prefix migration ──────────────────────────────────────
// Find Items with Name starting with "TREELOGY" (case-insensitive) and rename
// to the stripped form. If the stripped name already exists as another usable
// Item, redirect invoice line refs to that existing Item and inactivate the
// old TREELOGY-prefixed one (same redirect-then-inactivate pattern as
// runItemMigration).

const stripBrandPrefix = (s) => String(s || '').replace(/^\s*TREELOGY\b[\s|,\-]*/i, '').trim();

const findTreelogyPrefixedItems = async (qbo) => {
    // QBO query parser does not accept OR in WHERE — issue 2 separate queries
    // and dedupe by Id. (Also some QBO editions are case-sensitive on LIKE.)
    const fetchByPrefix = async (prefix) => {
        const acc = [];
        const PAGE = 200;
        for (let startPosition = 1; startPosition < 5000; startPosition += PAGE) {
            const q = `SELECT Id, Name, Type, Sku, Description, Active, SyncToken FROM Item WHERE Name LIKE '${prefix}%' STARTPOSITION ${startPosition} MAXRESULTS ${PAGE}`;
            const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
            const items = body?.QueryResponse?.Item || [];
            if (items.length === 0) break;
            acc.push(...items);
            if (items.length < PAGE) break;
        }
        return acc;
    };
    const [upper, lower] = await Promise.all([
        fetchByPrefix('TREELOGY'),
        fetchByPrefix('Treelogy'),
    ]);
    const seen = new Set();
    const out = [];
    for (const it of [...upper, ...lower]) {
        const id = String(it.Id);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(it);
    }
    return out;
};

const findItemByExactName = async (qbo, name) => {
    const escaped = name.replace(/'/g, "\\'");
    const q = `SELECT Id, Name, Type FROM Item WHERE Name = '${escaped}'`;
    const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
    return body?.QueryResponse?.Item || [];
};

const renameItem = async (qbo, item, newName) => {
    return qboFetch(qbo, '/item', {
        method: 'POST',
        body: JSON.stringify({
            Id: item.Id,
            SyncToken: item.SyncToken,
            sparse: true,
            Name: newName,
        }),
    });
};

const runStripTreelogyMigration = async ({ qbo, apply = false }) => {
    const t0 = Date.now();
    const mode = apply ? 'APPLY' : 'DRY-RUN';
    console.log(`\n🏷️  Strip TREELOGY migration (${mode})\n`);

    const items = await findTreelogyPrefixedItems(qbo);
    console.log(`Found ${items.length} items with TREELOGY prefix`);

    const report = {
        apply, mode, runMs: 0,
        totalPrefixed: items.length,
        perItem: [],
        summary: {
            renamed: 0,
            redirectedLines: 0,
            inactivated: 0,
            errors: 0,
            skipped: 0,
        },
    };

    if (items.length === 0) {
        report.runMs = Date.now() - t0;
        return report;
    }

    // Pre-scan invoices once for all candidate ids — only needed for redirect path.
    const allIds = items.map(i => String(i.Id));
    const refIndex = await buildItemRefIndex(qbo, allIds);

    for (const item of items) {
        const itemReport = {
            itemId: item.Id,
            currentName: item.Name,
            type: item.Type,
            newName: null,
            existingTargetId: null,
            invoicesScanned: 0,
            linesRedirected: [],
            errors: [],
            renamed: false,
            inactivated: false,
        };

        try {
            const newName = stripBrandPrefix(item.Name).substring(0, 100);
            itemReport.newName = newName;

            if (!newName || newName === item.Name) {
                itemReport.action = 'no-op (nothing to strip)';
                report.summary.skipped++;
                report.perItem.push(itemReport);
                continue;
            }

            // Check if target name is already taken by another Item
            const existing = await findItemByExactName(qbo, newName);
            const usableExisting = existing.find(e => SAFE_ITEM_TYPES.has(e.Type) && String(e.Id) !== String(item.Id));

            if (!usableExisting) {
                // Simple rename path
                itemReport.action = 'rename';
                if (apply) {
                    try {
                        const updated = await renameItem(qbo, item, newName);
                        itemReport.renamed = true;
                        itemReport.appliedNewName = updated?.Item?.Name;
                        report.summary.renamed++;
                        console.log(`  ✅ Renamed ${item.Id}: "${item.Name}" → "${updated?.Item?.Name}"`);
                    } catch (e) {
                        // Rare race: another item with same name appeared between check and rename
                        const detail = JSON.stringify(e.body || {}).slice(0, 300);
                        if (/Duplicate Name Exists/i.test(detail)) {
                            console.log(`  ⚠️  ${item.Id} race: target appeared, falling to redirect`);
                            // fall through to redirect path
                        } else {
                            itemReport.errors.push({ stage: 'rename', error: e.message.slice(0, 300) });
                            report.summary.errors++;
                            report.perItem.push(itemReport);
                            continue;
                        }
                    }
                } else {
                    console.log(`  📝 Would rename ${item.Id}: "${item.Name}" → "${newName}"`);
                }
                if (itemReport.renamed || !apply) {
                    report.perItem.push(itemReport);
                    continue;
                }
            }

            // Redirect path: target already exists, redirect invoice lines + inactivate this one
            const targetCandidates = usableExisting
                ? [usableExisting]
                : (await findItemByExactName(qbo, newName)).filter(e => SAFE_ITEM_TYPES.has(e.Type));
            const target = targetCandidates.find(t => String(t.Id) !== String(item.Id));
            if (!target) {
                itemReport.errors.push({ stage: 'redirect', error: 'no target id resolved' });
                report.summary.errors++;
                report.perItem.push(itemReport);
                continue;
            }

            // SAFETY: cross-type redirect (Service ⇄ Inventory) would distort
            // QBO stock accounting because Inventory items decrement stock from
            // historical invoices when re-referenced. Skip such cases — leave
            // the item alone so the operator can resolve manually.
            if (target.Type !== item.Type) {
                itemReport.action = 'skip-cross-type-collision';
                itemReport.errors.push({
                    stage: 'safety',
                    error: `target id=${target.Id} is ${target.Type}, source is ${item.Type} — cross-type redirect could distort stock; leaving as-is for manual triage`,
                });
                console.log(`  ⏭  ${item.Id} "${item.Name}" → target ${target.Id} is ${target.Type} ≠ ${item.Type}, skip (manual triage)`);
                report.summary.skipped++;
                report.perItem.push(itemReport);
                continue;
            }

            const targetId = String(target.Id);
            itemReport.existingTargetId = targetId;
            itemReport.action = 'redirect-and-inactivate';

            const invoices = refIndex.get(String(item.Id)) || [];
            itemReport.invoicesScanned = invoices.length;

            for (const inv of invoices) {
                for (const line of inv.lines) {
                    const action = {
                        invoice: inv.docNumber,
                        invoiceId: inv.invoiceId,
                        lineId: line.Id,
                        fromItemId: String(item.Id),
                        toItemId: targetId,
                        toName: newName,
                    };
                    if (apply) {
                        try {
                            const updated = await redirectLineItemRef(qbo, inv, line.Id, targetId);
                            inv.syncToken = updated?.Invoice?.SyncToken || inv.syncToken;
                            inv.rawInvoice = updated?.Invoice || inv.rawInvoice;
                            action.applied = true;
                            itemReport.linesRedirected.push(action);
                            report.summary.redirectedLines++;
                            console.log(`  ✅ ${inv.docNumber} line=${line.Id}: ${item.Id} → ${targetId}`);
                        } catch (e) {
                            const isAst = /sales tax rate|Business Validation/i.test(e.message);
                            action.applied = false;
                            action.error = e.message.slice(0, 300);
                            action.isAst = isAst;
                            itemReport.errors.push({ stage: 'redirect', invoice: inv.docNumber, lineId: line.Id, isAst, error: e.message.slice(0, 300) });
                            report.summary.errors++;
                        }
                    } else {
                        console.log(`  📝 ${inv.docNumber} line=${line.Id}: would redirect ${item.Id} → ${targetId} ("${newName}")`);
                        itemReport.linesRedirected.push({ ...action, applied: false });
                    }
                }
            }

            const allLinesOk = apply && itemReport.errors.length === 0 && itemReport.linesRedirected.length === invoices.reduce((n, inv) => n + inv.lines.length, 0);
            if (apply && allLinesOk) {
                try {
                    const fresh = await qboFetch(qbo, `/item/${item.Id}`);
                    await markItemInactive(qbo, fresh.Item);
                    itemReport.inactivated = true;
                    report.summary.inactivated++;
                    console.log(`  🗑️  Inactivated ${item.Id} "${item.Name}"`);
                } catch (e) {
                    itemReport.errors.push({ stage: 'mark-inactive', error: e.message.slice(0, 300) });
                    report.summary.errors++;
                }
            } else if (apply && invoices.length === 0) {
                // No references — just inactivate the prefixed one (rare: orphan TREELOGY item)
                try {
                    const fresh = await qboFetch(qbo, `/item/${item.Id}`);
                    await markItemInactive(qbo, fresh.Item);
                    itemReport.inactivated = true;
                    report.summary.inactivated++;
                } catch (e) {
                    itemReport.errors.push({ stage: 'mark-inactive', error: e.message.slice(0, 300) });
                    report.summary.errors++;
                }
            } else if (apply) {
                report.summary.skipped++;
            }
        } catch (e) {
            itemReport.errors.push({ stage: 'top', error: e.message });
            report.summary.errors++;
        }

        report.perItem.push(itemReport);
    }

    report.runMs = Date.now() - t0;
    console.log(`\n✅ ${mode} done in ${report.runMs}ms · renamed=${report.summary.renamed} redirected=${report.summary.redirectedLines} inactivated=${report.summary.inactivated} errors=${report.summary.errors}`);
    return report;
};

// ─── SKU Backfill ──────────────────────────────────────────────────────────
// Walk JubelioPayloadLog (30-day rolling window of webhook payloads) to
// extract every (item_code, item_name) pair we've seen. For each QBO Item
// that matches a Jubelio product by name (after brand-prefix strip) AND has
// no Sku populated, set Sku = item_code so future webhook lookups can
// resolve via SKU directly — robust against item_name tweaks in Jubelio.
//
// Idempotent: only writes when Sku is empty AND the (name → item_code)
// mapping is unambiguous (no two products share a stripped name).
const JubelioPayloadLog = require('../models/JubelioPayloadLog');

const fetchAllQboItems = async (qbo) => {
    const out = [];
    const PAGE = 200;
    for (let startPosition = 1; startPosition < 5000; startPosition += PAGE) {
        const q = `SELECT Id, Name, Type, Sku, Active, SyncToken FROM Item STARTPOSITION ${startPosition} MAXRESULTS ${PAGE}`;
        const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const items = body?.QueryResponse?.Item || [];
        if (items.length === 0) break;
        out.push(...items);
        if (items.length < PAGE) break;
    }
    return out;
};

const updateItemSku = async (qbo, item, sku) => {
    return qboFetch(qbo, '/item', {
        method: 'POST',
        body: JSON.stringify({
            Id: String(item.Id),
            SyncToken: String(item.SyncToken),
            sparse: true,
            Sku: sku,
        }),
    });
};

const runSkuBackfillMigration = async ({ qbo, apply = false, days = 30 }) => {
    const t0 = Date.now();
    const mode = apply ? 'APPLY' : 'DRY-RUN';
    console.log(`\n🏷️  SKU backfill (${mode}, lookback ${days}d)\n`);

    // 1) Mine payload log: build map strippedName → Set<item_code>
    const since = new Date(Date.now() - days * 86400000);
    const logs = await JubelioPayloadLog.find({
        endpoint: 'pesanan',
        received_at: { $gte: since },
    }).select('payload.items').lean();

    const skuByName = new Map(); // strippedName → Set<item_code>
    let pairsExtracted = 0;
    for (const log of logs) {
        const items = log.payload?.items || [];
        for (const it of items) {
            const code = String(it.item_code || '').trim();
            const stripped = stripBrandPrefix(String(it.item_name || it.description || '')).trim();
            if (!code || !stripped) continue;
            if (!skuByName.has(stripped)) skuByName.set(stripped, new Set());
            skuByName.get(stripped).add(code);
            pairsExtracted++;
        }
    }
    console.log(`Mined ${pairsExtracted} item pairs from ${logs.length} payload logs · ${skuByName.size} unique stripped names`);

    // 2) Fetch all QBO Items
    const allItems = await fetchAllQboItems(qbo);
    console.log(`Fetched ${allItems.length} QBO Items`);

    const report = {
        apply, mode, runMs: 0, days,
        payloadLogsScanned: logs.length,
        pairsExtracted,
        uniqueStrippedNames: skuByName.size,
        qboItemsTotal: allItems.length,
        backfilled: [],     // { itemId, name, type, sku }
        skippedAlreadySet: 0,
        skippedNoMatch: 0,
        skippedAmbiguous: [],  // { itemId, name, candidates: [...] }
        errors: [],
    };

    for (const item of allItems) {
        if (item.Sku && String(item.Sku).trim()) {
            report.skippedAlreadySet++;
            continue;
        }
        const candidates = skuByName.get(item.Name);
        if (!candidates || candidates.size === 0) {
            report.skippedNoMatch++;
            continue;
        }
        if (candidates.size > 1) {
            report.skippedAmbiguous.push({
                itemId: item.Id,
                name: item.Name,
                type: item.Type,
                candidates: [...candidates],
            });
            continue;
        }
        const sku = [...candidates][0];
        const entry = { itemId: item.Id, name: item.Name, type: item.Type, sku };

        if (apply) {
            try {
                const updated = await updateItemSku(qbo, item, sku);
                entry.applied = true;
                entry.appliedSku = updated?.Item?.Sku;
                console.log(`  ✅ Item ${item.Id} "${item.Name.slice(0, 50)}" → Sku=${sku}`);
            } catch (e) {
                entry.applied = false;
                entry.error = e.message?.slice(0, 300);
                report.errors.push({ itemId: item.Id, name: item.Name, error: entry.error });
                console.log(`  ❌ Item ${item.Id}: ${entry.error}`);
                continue;
            }
        } else {
            console.log(`  📝 Would set Sku="${sku}" on Item ${item.Id} "${item.Name.slice(0, 50)}"`);
        }
        report.backfilled.push(entry);
    }

    report.runMs = Date.now() - t0;
    console.log(`\n✅ ${mode} done in ${report.runMs}ms · backfilled=${report.backfilled.length} alreadySet=${report.skippedAlreadySet} noMatch=${report.skippedNoMatch} ambiguous=${report.skippedAmbiguous.length} errors=${report.errors.length}`);
    return report;
};

module.exports = { runItemMigration, runStripTreelogyMigration, runSkuBackfillMigration };
