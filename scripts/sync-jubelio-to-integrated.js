// Sync all Jubelio invoices in QBO to reference only [Integrated]-tagged
// canonical items.
//
// Discovery: query QBO Items, treat any item whose Description starts with
// "[Integrated]" as canonical. Build SKU→item lookup (Inventory > Group >
// Service > NonInventory).
//
// Redirect logic per line:
//   1. ItemRef already on a canonical [Integrated] item → skip.
//   2. Current item has SKU that matches a canonical SKU → swap ItemRef.
//   3. No SKU (e.g., "Sales" id=1, generic "Jubelio Sync Item" id=54) →
//      description+price match against canonical names.
//   4. Target is a Bundle (Type=Group) → expand to per-component
//      SalesItemLineDetail rows + DiscountLineDetail balancing back to the
//      original line Amount.
//
// Safety:
//   - Preserve TaxCodeRef per line (Indonesian QBO AST rejects updates
//     without it on lines, quirk #3).
//   - Preserve invoice TotalAmt exactly (line Amount stays equal pre/post),
//     so existing payment links stay valid.
//   - Skip lines that are SubTotalLineDetail / DiscountLineDetail /
//     GroupLineDetail (already canonical, would-be-rebuilt by QBO).
//   - Bounded run: --limit=N · deadline 240s.
//
// Usage:
//   node scripts/sync-jubelio-to-integrated.js                # dry-run all
//   node scripts/sync-jubelio-to-integrated.js --limit=50     # dry-run first 50
//   node scripts/sync-jubelio-to-integrated.js --apply        # apply
//   node scripts/sync-jubelio-to-integrated.js --apply --limit=100

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const { getQboInstance } = require('../services/qboService');
const { getBundleComposition, isBundleSku, CANONICAL_BUNDLES } = require('../services/bundleService');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limit = (() => {
    const a = args.find(x => x.startsWith('--limit='));
    return a ? Number(a.split('=')[1]) : Infinity;
})();
const deadlineMs = 240_000;

const TAG = '[Integrated]';
const SAFE_ITEM_TYPES = new Set(['Service', 'Inventory', 'NonInventory', 'Group']);
const TYPE_RANK = { Inventory: 0, Group: 1, NonInventory: 2, Service: 3 };

// Utility items the integration relies on or that finance asked to preserve —
// don't try to redirect lines pointing to these and don't flag as unresolved.
// (Memory: Sales=1 redirected, Hours=2/Shipping Charge=7/Shopify connector=10/
// Categories=12/Samples=39,40 dipertahankan; Bundle Discount=64 added by Phase 3.)
const UTILITY_KEEP_IDS = new Set(['2', '7', '10', '12', '39', '40', '64']);

const qboBaseUrl = (qbo) => `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
const qboFetch = async (qbo, p, opts = {}) => {
    const url = `${qboBaseUrl(qbo)}${p}${p.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
    const res = await fetch(url, {
        ...opts,
        headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(`QBO ${opts.method || 'GET'} ${p} (${res.status}): ${JSON.stringify(body).slice(0, 500)}`);
    return body;
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const fetchAllItems = async (qbo) => {
    const out = []; const PAGE = 200;
    for (let s = 1; s < 10000; s += PAGE) {
        const q = `SELECT * FROM Item STARTPOSITION ${s} MAXRESULTS ${PAGE}`;
        const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const items = body?.QueryResponse?.Item || []; if (!items.length) break;
        out.push(...items); if (items.length < PAGE) break;
    }
    return out;
};

// Build SKU → canonical item; multiple [Integrated] items can share a SKU
// (shouldn't happen but defense in depth) — keep the highest-ranked Type.
const buildCanonicalMaps = (allItems) => {
    const integrated = allItems.filter(i => /\[integrated\]/i.test(String(i.Description || '')));
    const integratedIds = new Set(integrated.map(i => String(i.Id)));
    const bySku = new Map();   // SKU(lowercase) → item
    const byName = new Map();  // Name(lowercase) → item

    const consider = (m, key, item) => {
        if (!key) return;
        const k = String(key).trim().toLowerCase();
        if (!k) return;
        const cur = m.get(k);
        if (!cur) { m.set(k, item); return; }
        if ((TYPE_RANK[item.Type] ?? 9) < (TYPE_RANK[cur.Type] ?? 9)) m.set(k, item);
    };
    for (const it of integrated) {
        consider(bySku, it.Sku, it);
        consider(byName, it.Name, it);
    }
    return { integrated, integratedIds, bySku, byName };
};

// Description+price hint → bundle SKU or canonical SKU. Same heuristic family
// as scripts/redirect-specific-invoices.js but extended to handle bundle hints.
const matchByDescAndPrice = (description, unitPrice) => {
    const d = String(description || '').toLowerCase();
    const p = Number(unitPrice || 0);
    // Bundle keywords
    if (/discovery\s*pack/.test(d)) return { sku: 'Discovery-Pack', kind: 'bundle' };
    if (/inside[-\s]*out/.test(d)) return { sku: 'Inside-Out-Protocol', kind: 'bundle' };
    if (/movement\s*&?\s*relief/.test(d)) return { sku: 'The-Movement-&-Relief', kind: 'bundle' };
    if (/ritual\s*set.*180\s*gr|180\s*gr.*ritual/.test(d)) return { sku: 'MRS-004', kind: 'bundle' };
    if (/ritual\s*set.*90\s*gr|90\s*gr.*ritual/.test(d)) return { sku: 'MRS-003', kind: 'bundle' };
    if (/ritual\s*set.*45\s*gr|45\s*gr.*ritual|starter/.test(d)) return { sku: 'MRS-002', kind: 'bundle' };
    // Single canonicals
    if (/powder|bubuk/.test(d)) {
        if (p >= 850000 || /180\s*gr/.test(d)) return { sku: 'OMP-180-001', kind: 'inventory' };
        if (p >= 450000 || /90\s*gr/.test(d)) return { sku: 'OMP-90-001', kind: 'inventory' };
        return { sku: 'OMP-45-001', kind: 'inventory' };
    }
    if (/capsule|caps|kapsul/.test(d)) {
        if (p >= 600000 || /180\s*c/.test(d)) return { sku: 'OMC-180-001', kind: 'inventory' };
        return { sku: 'OMC-90-001', kind: 'inventory' };
    }
    if (/oil|minyak/.test(d)) {
        if (p >= 700000 || /60\s*ml/.test(d)) return { sku: 'OMO-60-001', kind: 'inventory' };
        return { sku: 'OMO-30-001', kind: 'inventory' };
    }
    if (/ritual\s*set/.test(d)) return { sku: 'MRS-001', kind: 'inventory' };
    if (/bamboo\s*scoop/.test(d)) return { sku: 'Bamboo-Scoop', kind: 'inventory' };
    if (/bamboo\s*whisk/.test(d)) return { sku: 'Bamboo-Whisk', kind: 'inventory' };
    return null;
};

// Determine redirect target for a line.
// Returns { skip, target, reason } where target is { itemId, isBundle, bundleSku }
const resolveRedirect = (line, currentItem, canonical) => {
    if (line.DetailType !== 'SalesItemLineDetail') return { skip: true, reason: `keep ${line.DetailType}` };
    if (!currentItem) return { skip: true, reason: 'item not in catalog (orphan)' };

    const refId = String(currentItem.Id);
    if (canonical.integratedIds.has(refId)) return { skip: true, reason: 'already canonical' };
    if (UTILITY_KEEP_IDS.has(refId)) return { skip: true, reason: `utility item id=${refId} preserved` };

    // Strategy 1: SKU match
    const curSku = String(currentItem.Sku || '').trim();
    if (curSku && canonical.bySku.has(curSku.toLowerCase())) {
        const tgt = canonical.bySku.get(curSku.toLowerCase());
        return {
            target: { itemId: tgt.Id, isBundle: tgt.Type === 'Group', sku: tgt.Sku, name: tgt.Name },
            reason: `SKU "${curSku}" → ${tgt.Type} id=${tgt.Id}`,
        };
    }

    // Strategy 2: Name exact match
    const curName = String(currentItem.Name || '').trim().toLowerCase();
    if (curName && canonical.byName.has(curName)) {
        const tgt = canonical.byName.get(curName);
        return {
            target: { itemId: tgt.Id, isBundle: tgt.Type === 'Group', sku: tgt.Sku, name: tgt.Name },
            reason: `Name match → ${tgt.Type} id=${tgt.Id}`,
        };
    }

    // Strategy 3: Description+price match (handles "Sales" id=1 + generic Jubelio Sync Item id=54)
    const desc = line.Description || currentItem.Name || '';
    const lineAmount = Number(line.Amount || 0);
    const m = matchByDescAndPrice(desc, line.SalesItemLineDetail?.UnitPrice ?? line.Amount);
    if (m && canonical.bySku.has(m.sku.toLowerCase())) {
        const tgt = canonical.bySku.get(m.sku.toLowerCase());
        // Sanity: if target is a bundle and its componentSum is LESS than the
        // line Amount, redirecting would require a negative discount line which
        // QBO rejects → invoice total would silently drop. Refuse the match
        // and surface for manual review.
        if (tgt.Type === 'Group') {
            const composition = getBundleComposition(tgt.Sku);
            const lineQty = Number(line.SalesItemLineDetail?.Qty || 1);
            const componentSum = composition
                ? composition.components.reduce((s, c) => s + c.unitPrice * c.qty * lineQty, 0)
                : 0;
            if (componentSum > 0 && componentSum < lineAmount) {
                return {
                    skip: true,
                    unresolved: true,
                    reason: `desc match "${m.sku}" rejected: componentSum=${componentSum} < lineAmount=${lineAmount} (would require negative discount)`,
                };
            }
        }
        return {
            target: { itemId: tgt.Id, isBundle: tgt.Type === 'Group', sku: tgt.Sku, name: tgt.Name },
            reason: `desc match "${m.sku}" → ${tgt.Type} id=${tgt.Id}`,
        };
    }

    return { skip: true, unresolved: true, reason: `cannot resolve (refId=${refId} sku="${curSku}" name="${(currentItem.Name || '').slice(0, 40)}")` };
};

// Build new lines array for an invoice given resolution decisions.
// For bundle targets: replace 1 line with N component SalesItemLineDetail rows
// + DiscountLineDetail balancing to original Amount.
// For non-bundle: in-place ItemRef swap, preserve everything else.
const buildNewLines = (oldLines, resolutions, allItemsById, integratedIdsBySku) => {
    const out = [];
    let modified = false;

    for (let i = 0; i < oldLines.length; i++) {
        const l = oldLines[i];
        const r = resolutions[i];

        if (!r || r.skip) {
            // Drop SubTotalLineDetail (QBO regenerates) — keep everything else.
            if (l.DetailType !== 'SubTotalLineDetail') out.push(l);
            continue;
        }

        // Redirect
        const detail = l.SalesItemLineDetail || {};
        const taxCodeId = detail.TaxCodeRef?.value;
        const serviceDate = detail.ServiceDate;

        if (!r.target.isBundle) {
            // Simple ItemRef swap
            const newDetail = { ...detail, ItemRef: { value: r.target.itemId } };
            out.push({ ...l, SalesItemLineDetail: newDetail });
            modified = true;
            continue;
        }

        // Bundle expansion
        const composition = getBundleComposition(r.target.sku);
        if (!composition) {
            // Unknown bundle — keep as-is, log
            out.push(l);
            continue;
        }
        const lineAmount = Number(l.Amount || 0);
        const lineQty = Number(detail.Qty || 1);
        const componentSum = composition.components.reduce((s, c) => s + c.unitPrice * c.qty * lineQty, 0);

        for (const c of composition.components) {
            const compQty = c.qty * lineQty;
            const compAmount = Math.round(c.unitPrice * compQty * 100) / 100;
            const compItemId = integratedIdsBySku.get(c.sku.toLowerCase());
            if (!compItemId) {
                // Component canonical missing — abort this bundle redirect, keep original line
                out.length = out.length;  // no-op, caller will see modified=false for this line
                console.log(`    ⚠️  bundle ${r.target.sku} component ${c.sku} missing canonical → keeping original line`);
                out.push(l);
                modified = false;
                break;
            }
            const compDetail = { Qty: compQty, UnitPrice: c.unitPrice, ItemRef: { value: compItemId } };
            if (taxCodeId) compDetail.TaxCodeRef = { value: taxCodeId };
            if (serviceDate) compDetail.ServiceDate = serviceDate;
            out.push({
                Description: `[${r.target.sku}] ${c.sku}`.substring(0, 4000),
                Amount: compAmount,
                DetailType: 'SalesItemLineDetail',
                SalesItemLineDetail: compDetail,
            });
        }
        const discount = Math.round((componentSum - lineAmount) * 100) / 100;
        if (discount > 0) {
            out.push({
                Description: `${r.target.sku} bundle discount (channel/promo)`,
                Amount: discount,
                DetailType: 'DiscountLineDetail',
                DiscountLineDetail: { PercentBased: false },
            });
        }
        modified = true;
    }
    return { lines: out, modified };
};

(async () => {
    const start = Date.now();
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const auditFile = `sync-integrated-audit-${ts}.jsonl`;
    const audit = (e) => fs.appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');

    console.log(`\n🚀 Sync Jubelio invoices to [Integrated] items · mode=${apply ? 'APPLY' : 'DRY-RUN'} · limit=${limit === Infinity ? '∞' : limit}`);
    console.log(`📝 ${auditFile}\n`);

    console.log('🔍 Loading QBO catalog…');
    const allItems = await fetchAllItems(qbo);
    const itemById = new Map(allItems.map(i => [String(i.Id), i]));
    const canonical = buildCanonicalMaps(allItems);
    console.log(`   Total items: ${allItems.length}`);
    console.log(`   [Integrated] canonical: ${canonical.integrated.length}`);

    // SKU → integrated item id (string), used during bundle expansion
    const integratedIdsBySku = new Map();
    for (const [sku, it] of canonical.bySku.entries()) integratedIdsBySku.set(sku, it.Id);

    // Sanity: ensure all bundle components are mapped
    for (const [bSku, comp] of Object.entries(CANONICAL_BUNDLES)) {
        for (const c of comp.components) {
            if (!integratedIdsBySku.has(c.sku.toLowerCase())) {
                console.log(`⚠️  bundle ${bSku} component ${c.sku} missing in [Integrated] map — bundle redirect will be skipped if this comes up`);
            }
        }
    }

    console.log('\n🔍 Loading Jubelio order map…');
    const maps = await JubelioOrderMap.find({ qbo_invoice_id: { $exists: true, $ne: null } }).lean();
    console.log(`   ${maps.length} entries\n`);

    const stats = { total: maps.length, scanned: 0, modified: 0, applied: 0, errors: 0, unresolvedLines: 0, skippedAlreadyCanonical: 0, hitDeadline: false };
    const unresolvedDocs = []; // for reporting

    let processed = 0;
    for (const m of maps) {
        if (processed >= limit) break;
        if (Date.now() - start > deadlineMs) { stats.hitDeadline = true; break; }
        processed++;
        stats.scanned++;

        const sn = m.salesorder_no;
        try {
            const body = await qboFetch(qbo, `/invoice/${m.qbo_invoice_id}`);
            const inv = body?.Invoice;
            if (!inv) { audit({ sn, error: 'invoice not found' }); continue; }

            const oldLines = inv.Line || [];
            const resolutions = oldLines.map(l => {
                if (l.DetailType !== 'SalesItemLineDetail') return { skip: true, reason: 'non-product line' };
                const refId = String(l.SalesItemLineDetail?.ItemRef?.value || '');
                const item = itemById.get(refId);
                return resolveRedirect(l, item, canonical);
            });

            const lineSummary = [];
            let perInvoiceModified = false;
            let perInvoiceUnresolved = 0;
            for (let i = 0; i < oldLines.length; i++) {
                const r = resolutions[i];
                const l = oldLines[i];
                if (l.DetailType !== 'SalesItemLineDetail') continue;
                if (r.skip && r.reason === 'already canonical') {
                    stats.skippedAlreadyCanonical++;
                } else if (r.unresolved) {
                    perInvoiceUnresolved++;
                    stats.unresolvedLines++;
                    lineSummary.push(`UNRESOLVED ${r.reason}`);
                } else if (r.target) {
                    perInvoiceModified = true;
                    lineSummary.push(`${l.SalesItemLineDetail?.ItemRef?.value || '-'}→${r.target.itemId}${r.target.isBundle ? ` (bundle ${r.target.sku})` : ''}`);
                }
            }

            if (perInvoiceUnresolved && !perInvoiceModified) {
                console.log(`  ❓ ${sn} (id=${inv.Id}): ${perInvoiceUnresolved} unresolved line(s)`);
                unresolvedDocs.push({ sn, invoiceId: inv.Id, summary: lineSummary });
                audit({ sn, invoiceId: inv.Id, status: 'unresolved', summary: lineSummary });
                continue;
            }
            if (!perInvoiceModified) continue;  // nothing to do

            console.log(`  🔧 ${sn} (id=${inv.Id}, total=Rp ${(inv.TotalAmt || 0).toLocaleString('id-ID')}): ${lineSummary.join(' · ')}`);

            const { lines: newLines, modified } = buildNewLines(oldLines, resolutions, itemById, integratedIdsBySku);
            if (!modified) continue;
            stats.modified++;

            audit({ sn, invoiceId: inv.Id, plan: lineSummary, dryRun: !apply });

            if (!apply) continue;

            try {
                const updated = await qboFetch(qbo, '/invoice', {
                    method: 'POST',
                    body: JSON.stringify({ Id: inv.Id, SyncToken: inv.SyncToken, sparse: true, Line: newLines, TxnTaxDetail: {} }),
                });
                const newInv = updated?.Invoice;
                if (Math.abs(Number(newInv?.TotalAmt || 0) - Number(inv.TotalAmt || 0)) > 1) {
                    console.warn(`     ⚠️  total drift! before=${inv.TotalAmt} after=${newInv?.TotalAmt}`);
                }
                stats.applied++;
                audit({ sn, invoiceId: inv.Id, status: 'applied', newSyncToken: newInv?.SyncToken, newTotal: newInv?.TotalAmt });
                await sleep(120);
            } catch (e) {
                console.error(`     💥 update failed: ${e.message.slice(0, 200)}`);
                audit({ sn, invoiceId: inv.Id, status: 'error', error: e.message });
                stats.errors++;
            }
        } catch (e) {
            console.error(`  💥 ${sn}: ${e.message.slice(0, 200)}`);
            audit({ sn, error: e.message });
            stats.errors++;
        }
    }

    console.log(`\n📊 SUMMARY`);
    for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(28)} ${v}`);
    console.log(`  runMs                        ${Date.now() - start}`);
    console.log(`  remaining                    ${maps.length - processed}`);
    console.log(`\n📝 Audit: ${auditFile}`);
    if (unresolvedDocs.length) {
        console.log(`\n⚠️  ${unresolvedDocs.length} invoice(s) had only-unresolved lines (need manual investigation):`);
        for (const u of unresolvedDocs.slice(0, 20)) console.log(`  • ${u.sn} (qbo id=${u.invoiceId}) — ${u.summary.join(' / ')}`);
    }
    await mongoose.disconnect();
})().catch(async e => { console.error('💥 FATAL:', e); try { await mongoose.disconnect(); } catch {} process.exit(1); });
