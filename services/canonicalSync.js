// canonicalSync.js — Apply QBO ↔ Jubelio canonical migration.
//
// Reads migration-plan.json and executes phase-by-phase:
//   Phase 0: Pre-flight QBO state snapshot (audit trail)
//   Phase 1: Rename + set SKU on legacy Inventory
//   Phase 2: Create new Inventory items (Bamboo-Whisk)
//   Phase 4: Create Group/Bundle items
//   Phase 3: Redirect Service invoice line ItemRefs to Inventory/Bundle
//   Phase 5: Inactivate Service items (after redirect)
//   Phase 6: Inactivate orphan legacy Inventory
//   Phase 7: Adjust QtyOnHand to Jubelio current
//
// Each phase has dryRun=true|false. Audit log per action written to migration-audit-{ts}.jsonl

const fs = require('fs');
const path = require('path');

// ── QBO REST helper ────────────────────────────────────────────────────────
const qboBaseUrl = (qbo) => {
    const host = qbo.useSandbox ? 'sandbox-quickbooks.api.intuit.com' : 'quickbooks.api.intuit.com';
    return `https://${host}/v3/company/${qbo.realmId}`;
};

const qboFetch = async (qbo, p, opts = {}) => {
    const url = `${qboBaseUrl(qbo)}${p}${p.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
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
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) {
        const err = new Error(`QBO ${opts.method || 'GET'} ${p} (${res.status}): ${JSON.stringify(body).slice(0, 400)}`);
        err.status = res.status;
        err.body = body;
        throw err;
    }
    return body;
};

// ── Audit logger ───────────────────────────────────────────────────────────
const makeAuditLogger = () => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `migration-audit-${ts}.jsonl`;
    const fullPath = path.resolve(filename);
    const stream = fs.createWriteStream(fullPath, { flags: 'a' });
    const log = (entry) => {
        stream.write(JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    };
    log.close = () => stream.end();
    log.path = fullPath;
    return log;
};

// ── Helpers for fetching current QBO entity (for SyncToken) ────────────────
const getItem = async (qbo, id) => {
    const body = await qboFetch(qbo, `/item/${id}`);
    return body?.Item;
};

const getInvoice = async (qbo, id) => {
    const body = await qboFetch(qbo, `/invoice/${id}`);
    return body?.Invoice;
};

const SAFE_DELAY_MS = 80; // ~750 req/min, well under QBO 500 req/min limit
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Phase 0: snapshot ──────────────────────────────────────────────────────
const snapshotQboState = async (qbo, log) => {
    console.log('📸 Phase 0: Snapshot QBO state...');
    const items = [];
    const PAGE = 200;
    for (let start = 1; start < 5000; start += PAGE) {
        const q = `SELECT * FROM Item STARTPOSITION ${start} MAXRESULTS ${PAGE}`;
        const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const list = body?.QueryResponse?.Item || [];
        if (list.length === 0) break;
        items.push(...list);
        if (list.length < PAGE) break;
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = `qbo-snapshot-pre-migration-${ts}.json`;
    fs.writeFileSync(file, JSON.stringify({ ts, realmId: qbo.realmId, itemCount: items.length, items }, null, 2));
    log({ phase: 0, action: 'snapshot', file, itemCount: items.length });
    console.log(`  💾 ${file} (${items.length} items)\n`);
    return items;
};

// ── Phase 1: rename + set SKU on legacy Inventory ──────────────────────────
const phase1RenameInventory = async (qbo, plan, log, { apply }) => {
    console.log(`🔧 Phase 1: Rename + set SKU on legacy Inventory (${plan.phase1_renameLegacyInventory.length} items)`);
    const results = [];
    for (const p of plan.phase1_renameLegacyInventory) {
        if (p.skip) {
            console.log(`  ⏭  id=${p.qboId} sudah benar`);
            results.push({ id: p.qboId, status: 'skip-already-correct' });
            continue;
        }
        try {
            const fresh = await getItem(qbo, p.qboId);
            const payload = {
                Id: p.qboId,
                SyncToken: fresh.SyncToken,
                sparse: true,
                Name: p.desiredName,
                Sku: p.desiredSku,
            };
            log({ phase: 1, action: 'rename+sku', id: p.qboId, before: { name: fresh.Name, sku: fresh.Sku }, after: { name: p.desiredName, sku: p.desiredSku }, dryRun: !apply });
            if (apply) {
                const updated = await qboFetch(qbo, '/item', { method: 'POST', body: JSON.stringify(payload) });
                console.log(`  ✅ id=${p.qboId} renamed → "${updated?.Item?.Name?.slice(0, 50)}" sku=${updated?.Item?.Sku}`);
                results.push({ id: p.qboId, status: 'applied', newName: updated?.Item?.Name, newSku: updated?.Item?.Sku });
            } else {
                console.log(`  📝 id=${p.qboId} would rename → "${p.desiredName.slice(0, 50)}" sku=${p.desiredSku}`);
                results.push({ id: p.qboId, status: 'dryrun' });
            }
            await sleep(SAFE_DELAY_MS);
        } catch (e) {
            console.error(`  ❌ id=${p.qboId}: ${e.message.slice(0, 200)}`);
            log({ phase: 1, action: 'rename+sku', id: p.qboId, error: e.message });
            results.push({ id: p.qboId, status: 'error', error: e.message });
        }
    }
    return results;
};

// ── Phase 2: create new Inventory items ────────────────────────────────────
// Resolve income/COGS/asset accounts. Strategy: probe existing Inventory items
// in QBO to learn what accounts are currently in use — most reliable signal.
const resolveInventoryAccounts = async (qbo) => {
    // 1) Probe existing Inventory for active asset/cogs accounts
    const itemsBody = await qboFetch(qbo, `/query?query=${encodeURIComponent("SELECT * FROM Item WHERE Type = 'Inventory' AND Active = true")}`);
    const existingInv = itemsBody?.QueryResponse?.Item || [];
    const tally = (key) => {
        const m = new Map();
        for (const i of existingInv) {
            const v = i[key]?.value;
            if (v) m.set(v, (m.get(v) || 0) + 1);
        }
        return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    };
    const assetId = tally('AssetAccountRef');
    const cogsId = tally('ExpenseAccountRef');

    // 2) Fall back to Account query for income (Channel sales = id 385 here)
    const accountsBody = await qboFetch(qbo, `/query?query=${encodeURIComponent("SELECT * FROM Account WHERE AccountType = 'Income'")}`);
    const incomeAccts = accountsBody?.QueryResponse?.Account || [];
    const incomeAcct = incomeAccts.find(a => /channel\s*sales/i.test(a.Name))
        || incomeAccts.find(a => /sales|penjualan/i.test(a.Name))
        || incomeAccts[0];

    // Fetch names for diagnostic display
    const assetName = existingInv.find(i => i.AssetAccountRef?.value === assetId)?.AssetAccountRef?.name;
    const cogsName = existingInv.find(i => i.ExpenseAccountRef?.value === cogsId)?.ExpenseAccountRef?.name;

    return {
        incomeId: incomeAcct?.Id,
        cogsId,
        assetId,
        incomeName: incomeAcct?.Name,
        cogsName,
        assetName,
    };
};

const phase2CreateInventory = async (qbo, plan, log, { apply, accounts }) => {
    console.log(`\n🆕 Phase 2: Create new Inventory items (${plan.phase2_createNewInventory.length} items)`);
    const results = [];
    // InvStartDate WAY before earliest invoice — historical redirects must fall after this date
    const invStartDate = '2024-01-01';
    for (const p of plan.phase2_createNewInventory) {
        try {
            // Opening qty = Jubelio current + buffer (1000) for historical redirects
            const openingQty = (p.stockOpening || 0) + 1000;
            const payload = {
                Name: p.desiredName,
                Sku: p.desiredSku,
                Type: 'Inventory',
                TrackQtyOnHand: true,
                QtyOnHand: openingQty,
                InvStartDate: invStartDate,
                IncomeAccountRef: { value: accounts.incomeId },
                ExpenseAccountRef: { value: accounts.cogsId },
                AssetAccountRef: { value: accounts.assetId },
                UnitPrice: p.sellPrice || 0,
            };
            log({ phase: 2, action: 'create-inventory', payload, dryRun: !apply });
            if (apply) {
                const created = await qboFetch(qbo, '/item', { method: 'POST', body: JSON.stringify(payload) });
                const item = created?.Item;
                console.log(`  ✅ Created Inventory id=${item?.Id} "${item?.Name?.slice(0, 50)}" sku=${item?.Sku}`);
                results.push({ desiredSku: p.desiredSku, status: 'applied', newId: item?.Id });
            } else {
                console.log(`  📝 Would create Inventory "${p.desiredName.slice(0, 50)}" sku=${p.desiredSku} qty=${openingQty}`);
                results.push({ desiredSku: p.desiredSku, status: 'dryrun' });
            }
            await sleep(SAFE_DELAY_MS);
        } catch (e) {
            console.error(`  ❌ ${p.desiredSku}: ${e.message.slice(0, 200)}`);
            log({ phase: 2, action: 'create-inventory', sku: p.desiredSku, error: e.message });
            results.push({ desiredSku: p.desiredSku, status: 'error', error: e.message });
        }
    }
    return results;
};

// ── Resolve canonical SKU → QBO item id (after Phase 1+2) ──────────────────
const buildSkuToIdMap = async (qbo) => {
    const map = new Map();
    const PAGE = 200;
    for (let start = 1; start < 5000; start += PAGE) {
        const q = `SELECT * FROM Item STARTPOSITION ${start} MAXRESULTS ${PAGE}`;
        const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const items = body?.QueryResponse?.Item || [];
        if (items.length === 0) break;
        for (const it of items) {
            const sku = (it.Sku || '').trim();
            if (sku && it.Active) {
                if (!map.has(sku) || it.Type === 'Inventory') {
                    // Prefer Inventory (canonical) over Service if duplicate SKU
                    map.set(sku, { id: it.Id, name: it.Name, type: it.Type });
                }
            }
        }
        if (items.length < PAGE) break;
    }
    return map;
};

// ── Phase 4: create Group/Bundle items ─────────────────────────────────────
const phase4CreateBundles = async (qbo, plan, log, { apply, skuMap }) => {
    console.log(`\n🎁 Phase 4: Create Group/Bundle items (${plan.phase4_createGroupBundles.length} bundles)`);
    const results = [];
    for (const b of plan.phase4_createGroupBundles) {
        try {
            const members = [];
            let allResolved = true;
            for (const m of b.members) {
                const target = skuMap.get(m.sku);
                if (!target) {
                    console.error(`  ⚠️  Bundle ${b.desiredSku}: member SKU ${m.sku} NOT FOUND in QBO — bundle creation aborted`);
                    allResolved = false;
                    break;
                }
                members.push({
                    Qty: m.qty,
                    ItemRef: { value: target.id, name: target.name },
                });
            }
            if (!allResolved) {
                results.push({ sku: b.desiredSku, status: 'error-member-missing' });
                continue;
            }

            const payload = {
                Name: b.desiredName,
                Sku: b.desiredSku,
                Type: 'Bundle',
                ItemGroupDetail: {
                    ItemGroupLine: members.map(m => ({
                        Qty: m.Qty,
                        ItemRef: m.ItemRef,
                    })),
                },
            };
            log({ phase: 4, action: 'create-bundle', sku: b.desiredSku, members, dryRun: !apply });
            if (apply) {
                const created = await qboFetch(qbo, '/item', { method: 'POST', body: JSON.stringify(payload) });
                const item = created?.Item;
                console.log(`  ✅ Created Bundle id=${item?.Id} "${item?.Name?.slice(0, 50)}" sku=${item?.Sku} (${members.length} members)`);
                results.push({ sku: b.desiredSku, status: 'applied', newId: item?.Id });
            } else {
                console.log(`  📝 Would create Bundle "${b.desiredName.slice(0, 50)}" sku=${b.desiredSku} (${members.length} members)`);
                results.push({ sku: b.desiredSku, status: 'dryrun' });
            }
            await sleep(SAFE_DELAY_MS);
        } catch (e) {
            console.error(`  ❌ ${b.desiredSku}: ${e.message.slice(0, 200)}`);
            log({ phase: 4, action: 'create-bundle', sku: b.desiredSku, error: e.message });
            results.push({ sku: b.desiredSku, status: 'error', error: e.message });
        }
    }
    return results;
};

// ── Phase 3: redirect Service invoice line ItemRefs ────────────────────────
// NOTE: cross-type Service→Inventory redirect distorts stock at historical
// invoice date. Mitigation: Phase 2/Phase 1 prepared opening qty + Phase 7
// adjusts QtyOnHand to Jubelio current. Phase 1 legacy Inventory retains
// historical purchase records; opening qty already implicit in their state.
//
// For each Service item, scan all invoices that reference it, swap the
// ItemRef on each line to the canonical destination.
const phase3RedirectInvoices = async (qbo, plan, log, { apply, skuMap, bundleSkuMap }) => {
    console.log(`\n🔄 Phase 3: Redirect Service invoice lines`);
    const results = [];
    let totalRedirected = 0, totalErrors = 0, totalSkipped = 0;

    // Build invoice index for all relevant Service ids
    const serviceIds = plan.phase3_redirectServiceLines.map(r => r.serviceId);
    const invIndex = new Map();
    for (const id of serviceIds) invIndex.set(String(id), []);

    const PAGE = 200;
    let scanned = 0;
    let lastBatchSize = 0;
    for (let start = 1; start < 5000; start += PAGE) {
        const q = `SELECT * FROM Invoice STARTPOSITION ${start} MAXRESULTS ${PAGE}`;
        const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const invoices = body?.QueryResponse?.Invoice || [];
        lastBatchSize = invoices.length;
        if (invoices.length === 0) break;
        scanned += invoices.length;
        for (const inv of invoices) {
            const linesByService = new Map();
            for (const l of inv.Line || []) {
                if (l.DetailType !== 'SalesItemLineDetail') continue;
                const refId = String(l.SalesItemLineDetail?.ItemRef?.value || '');
                if (!invIndex.has(refId)) continue;
                if (!linesByService.has(refId)) linesByService.set(refId, []);
                linesByService.get(refId).push(l);
            }
            for (const [refId, lines] of linesByService) {
                invIndex.get(refId).push({ invoice: inv, lines });
            }
        }
        if (invoices.length < PAGE) break;
    }
    console.log(`  📊 Scanned ${scanned} invoices`);
    // Cap-hit warning: full last batch + reached cap = there are more invoices
    // we never scanned, so phase 3 redirect may silently miss recent ones.
    if (scanned >= 4500 && lastBatchSize === PAGE) {
        console.warn(`⚠️  HIGH-WATER: canonicalSync phase3 invoice scan hit ${scanned}/5000 with full last batch — additional invoices may exist beyond the cap. Add a date filter or raise the cap before relying on this sweep.`);
    }

    for (const r of plan.phase3_redirectServiceLines) {
        const dest = r.destination;

        // Resolve target QBO id
        let targetId = null, targetName = null, targetKind = null;
        if (dest.kind === 'inventory') {
            const t = String(dest.target);
            if (t.startsWith('NEW:')) {
                const sku = t.replace('NEW:', '');
                const m = skuMap.get(sku);
                if (m) { targetId = m.id; targetName = m.name; targetKind = 'Inventory'; }
            } else {
                targetId = t;
                const m = await getItem(qbo, t).catch(() => null);
                targetName = m?.Name || '';
                targetKind = m?.Type || 'Inventory';
            }
        } else if (dest.kind === 'bundle') {
            const sku = String(dest.target).replace('NEW:bundle:', '');
            const m = bundleSkuMap.get(sku);
            if (m) { targetId = m.id; targetName = m.name; targetKind = 'Group'; }
        } else if (dest.kind === 'generic-fallback') {
            console.log(`  ⏭  Service id=${r.serviceId} (Jubelio Sync Item) — handled by separate runItemMigration step`);
            results.push({ serviceId: r.serviceId, status: 'deferred-to-runItemMigration' });
            continue;
        }

        if (!targetId) {
            console.log(`  ⚠️  Service id=${r.serviceId} ${r.serviceSku || '—'}: target not resolved (${dest.kind}/${dest.target}) — skip`);
            log({ phase: 3, action: 'redirect', serviceId: r.serviceId, error: 'target not resolved', dest });
            results.push({ serviceId: r.serviceId, status: 'error-target-not-resolved' });
            continue;
        }

        const invList = invIndex.get(String(r.serviceId)) || [];
        console.log(`\n  ▸ Service id=${r.serviceId} "${r.serviceName.slice(0, 40)}" → ${targetKind} ${targetId} (${invList.length} invoices)`);

        for (const { invoice, lines } of invList) {
            try {
                let inv = invoice;
                for (const line of lines) {
                    const newLines = (inv.Line || []).map(l => {
                        if (String(l.Id) === String(line.Id) && l.DetailType === 'SalesItemLineDetail') {
                            return {
                                ...l,
                                SalesItemLineDetail: {
                                    ...l.SalesItemLineDetail,
                                    ItemRef: { value: String(targetId), name: targetName || undefined },
                                },
                            };
                        }
                        return l;
                    });
                    log({ phase: 3, action: 'redirect-line', serviceId: r.serviceId, invoice: inv.DocNumber, invoiceId: inv.Id, lineId: line.Id, fromItemId: r.serviceId, toItemId: targetId, dryRun: !apply });
                    if (apply) {
                        const payload = {
                            Id: inv.Id,
                            SyncToken: inv.SyncToken,
                            sparse: true,
                            Line: newLines,
                        };
                        const updated = await qboFetch(qbo, '/invoice', { method: 'POST', body: JSON.stringify(payload) });
                        inv = updated?.Invoice || inv;
                        totalRedirected++;
                    } else {
                        totalSkipped++;
                    }
                    await sleep(SAFE_DELAY_MS);
                }
            } catch (e) {
                totalErrors++;
                console.error(`    ❌ inv=${invoice.DocNumber} line=${lines.map(l => l.Id).join(',')}: ${e.message.slice(0, 200)}`);
                log({ phase: 3, action: 'redirect-line', serviceId: r.serviceId, invoice: invoice.DocNumber, error: e.message });
            }
        }
        results.push({ serviceId: r.serviceId, invoices: invList.length, lines: invList.reduce((s, x) => s + x.lines.length, 0) });
    }

    console.log(`\n  📊 Phase 3 done · redirected=${totalRedirected} dryrun=${totalSkipped} errors=${totalErrors}`);
    return { results, totalRedirected, totalErrors };
};

// ── Phase 5: inactivate Service items ──────────────────────────────────────
const phase5InactivateServices = async (qbo, plan, log, { apply }) => {
    console.log(`\n🚫 Phase 5: Inactivate Service items (${plan.phase5_inactivateServiceItems.length} items)`);
    const results = [];
    for (const s of plan.phase5_inactivateServiceItems) {
        try {
            const fresh = await getItem(qbo, s.qboId);
            log({ phase: 5, action: 'inactivate', id: s.qboId, name: fresh.Name, dryRun: !apply });
            if (apply) {
                await qboFetch(qbo, '/item', {
                    method: 'POST',
                    body: JSON.stringify({ Id: s.qboId, SyncToken: fresh.SyncToken, sparse: true, Active: false }),
                });
                console.log(`  ✅ Inactivated id=${s.qboId} "${fresh.Name.slice(0, 50)}"`);
                results.push({ id: s.qboId, status: 'applied' });
            } else {
                console.log(`  📝 Would inactivate id=${s.qboId} "${fresh.Name.slice(0, 50)}"`);
                results.push({ id: s.qboId, status: 'dryrun' });
            }
            await sleep(SAFE_DELAY_MS);
        } catch (e) {
            console.error(`  ❌ id=${s.qboId}: ${e.message.slice(0, 200)}`);
            log({ phase: 5, action: 'inactivate', id: s.qboId, error: e.message });
            results.push({ id: s.qboId, status: 'error', error: e.message });
        }
    }
    return results;
};

// ── Phase 6: inactivate orphan legacy Inventory ────────────────────────────
const phase6InactivateOrphans = async (qbo, plan, log, { apply }) => {
    console.log(`\n🚫 Phase 6: Inactivate orphan legacy Inventory (${plan.phase6_inactivateOrphanInventory.length} items)`);
    const results = [];
    for (const o of plan.phase6_inactivateOrphanInventory) {
        try {
            const fresh = await getItem(qbo, o.qboId);
            log({ phase: 6, action: 'inactivate-orphan', id: o.qboId, name: fresh.Name, dryRun: !apply });
            if (apply) {
                await qboFetch(qbo, '/item', {
                    method: 'POST',
                    body: JSON.stringify({ Id: o.qboId, SyncToken: fresh.SyncToken, sparse: true, Active: false }),
                });
                console.log(`  ✅ Inactivated id=${o.qboId} "${fresh.Name.slice(0, 50)}"`);
                results.push({ id: o.qboId, status: 'applied' });
            } else {
                console.log(`  📝 Would inactivate id=${o.qboId} "${fresh.Name.slice(0, 50)}"`);
                results.push({ id: o.qboId, status: 'dryrun' });
            }
            await sleep(SAFE_DELAY_MS);
        } catch (e) {
            console.error(`  ❌ id=${o.qboId}: ${e.message.slice(0, 200)}`);
            log({ phase: 6, action: 'inactivate-orphan', id: o.qboId, error: e.message });
            results.push({ id: o.qboId, status: 'error', error: e.message });
        }
    }
    return results;
};

// ── Phase 7: stock adjustment to Jubelio current ───────────────────────────
// QBO Inventory Adjustment via /inventoryadjustment endpoint. Uses a built-in
// "Inventory Shrinkage" / "Stock Reconciliation" account or asks user. Simpler:
// patch QtyOnHand directly via item update — QBO accepts this and creates an
// implicit adjustment internally.
const phase7AdjustStock = async (qbo, plan, log, { apply, skuMap }) => {
    console.log(`\n📊 Phase 7: Adjust QtyOnHand to Jubelio current (${plan.phase7_adjustStockToJubelio.length} items)`);
    const results = [];
    for (const a of plan.phase7_adjustStockToJubelio) {
        try {
            const target = skuMap.get(a.sku);
            if (!target) {
                console.error(`  ⚠️  ${a.sku}: not found in skuMap`);
                results.push({ sku: a.sku, status: 'error-not-found' });
                continue;
            }
            if (String(target.id).startsWith('SIM:')) {
                // Dry-run: simulated id, skip qty fetch
                console.log(`  📝 ${a.sku} (SIM) would set qty → ${a.jubelioCurrentQty}`);
                results.push({ sku: a.sku, status: 'dryrun-simulated' });
                continue;
            }
            const fresh = await getItem(qbo, target.id);
            const currentQty = Number(fresh.QtyOnHand || 0);
            const targetQty = Number(a.jubelioCurrentQty || 0);
            if (currentQty === targetQty) {
                console.log(`  ⏭  ${a.sku} (id=${target.id}) already at qty=${targetQty}`);
                results.push({ sku: a.sku, status: 'skip-already-correct' });
                continue;
            }
            log({ phase: 7, action: 'adjust-qty', id: target.id, sku: a.sku, before: currentQty, after: targetQty, dryRun: !apply });
            if (apply) {
                await qboFetch(qbo, '/item', {
                    method: 'POST',
                    body: JSON.stringify({
                        Id: target.id,
                        SyncToken: fresh.SyncToken,
                        sparse: true,
                        QtyOnHand: targetQty,
                        InvStartDate: fresh.InvStartDate || '2024-01-01',
                    }),
                });
                console.log(`  ✅ ${a.sku} (id=${target.id}) qty ${currentQty} → ${targetQty}`);
                results.push({ sku: a.sku, status: 'applied', before: currentQty, after: targetQty });
            } else {
                console.log(`  📝 ${a.sku} (id=${target.id}) qty ${currentQty} → ${targetQty}`);
                results.push({ sku: a.sku, status: 'dryrun', before: currentQty, after: targetQty });
            }
            await sleep(SAFE_DELAY_MS);
        } catch (e) {
            console.error(`  ❌ ${a.sku}: ${e.message.slice(0, 200)}`);
            log({ phase: 7, action: 'adjust-qty', sku: a.sku, error: e.message });
            results.push({ sku: a.sku, status: 'error', error: e.message });
        }
    }
    return results;
};

// ── Orchestrator ───────────────────────────────────────────────────────────
const runCanonicalSync = async ({ qbo, apply = false, phases = ['0', '1', '2', '4', '3', '5', '6', '7'] }) => {
    const planFile = path.resolve('migration-plan.json');
    if (!fs.existsSync(planFile)) {
        throw new Error('migration-plan.json not found. Run: node scripts/migration-preview.js first.');
    }
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    const log = makeAuditLogger();
    const summary = {};

    console.log(`\n🚀 Canonical Sync · mode=${apply ? 'APPLY' : 'DRY-RUN'} · phases=${phases.join(',')}\n`);
    console.log(`📝 Audit log: ${log.path}\n`);

    if (phases.includes('0')) {
        await snapshotQboState(qbo, log);
    }

    if (phases.includes('1')) {
        summary.phase1 = await phase1RenameInventory(qbo, plan, log, { apply });
    }

    let accounts = null;
    if (phases.includes('2') || phases.includes('4')) {
        accounts = await resolveInventoryAccounts(qbo);
        console.log(`\n💼 Accounts: income=${accounts.incomeName} cogs=${accounts.cogsName} asset=${accounts.assetName}`);
        log({ phase: 'pre-2', action: 'resolve-accounts', accounts });
    }

    if (phases.includes('2')) {
        summary.phase2 = await phase2CreateInventory(qbo, plan, log, { apply, accounts });
    }

    let skuMap = null, bundleSkuMap = null;
    if (phases.includes('4') || phases.includes('3') || phases.includes('7')) {
        const fullMap = await buildSkuToIdMap(qbo);
        skuMap = fullMap;
        bundleSkuMap = new Map();
        for (const [sku, item] of fullMap) {
            if (item.type === 'Group') bundleSkuMap.set(sku, item);
        }
        // In dry-run, simulate Phase 1+2 results so Phase 4+ can preview
        if (!apply) {
            for (const p of plan.phase1_renameLegacyInventory) {
                if (p.skip || !p.desiredSku) continue;
                skuMap.set(p.desiredSku, { id: p.qboId, name: p.desiredName, type: 'Inventory', simulated: true });
            }
            for (const p of plan.phase2_createNewInventory) {
                skuMap.set(p.desiredSku, { id: `SIM:${p.desiredSku}`, name: p.desiredName, type: 'Inventory', simulated: true });
            }
        }
    }

    if (phases.includes('4')) {
        summary.phase4 = await phase4CreateBundles(qbo, plan, log, { apply, skuMap });
        // Refresh skuMap after bundle creation
        if (apply) {
            const fullMap = await buildSkuToIdMap(qbo);
            skuMap = fullMap;
            bundleSkuMap = new Map();
            for (const [sku, item] of fullMap) {
                if (item.type === 'Group') bundleSkuMap.set(sku, item);
            }
        } else {
            // Simulate bundle creation in dry-run for Phase 3 preview
            for (const b of plan.phase4_createGroupBundles) {
                bundleSkuMap.set(b.desiredSku, { id: `SIM:bundle:${b.desiredSku}`, name: b.desiredName, type: 'Group', simulated: true });
                skuMap.set(b.desiredSku, { id: `SIM:bundle:${b.desiredSku}`, name: b.desiredName, type: 'Group', simulated: true });
            }
        }
    }

    if (phases.includes('3')) {
        summary.phase3 = await phase3RedirectInvoices(qbo, plan, log, { apply, skuMap, bundleSkuMap });
    }

    if (phases.includes('5')) {
        summary.phase5 = await phase5InactivateServices(qbo, plan, log, { apply });
    }

    if (phases.includes('6')) {
        summary.phase6 = await phase6InactivateOrphans(qbo, plan, log, { apply });
    }

    if (phases.includes('7')) {
        summary.phase7 = await phase7AdjustStock(qbo, plan, log, { apply, skuMap });
    }

    log({ phase: 'done', summary: JSON.stringify(summary).slice(0, 4000) });
    log.close();
    console.log(`\n✅ Done · audit: ${log.path}`);
    return { summary, auditLog: log.path };
};

module.exports = { runCanonicalSync };
