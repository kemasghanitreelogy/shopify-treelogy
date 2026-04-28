// Verify QBO Bundle items match Jubelio canonical state.
//
// Reads all QBO Items (Active + Inactive), filters Type=Group, then compares
// each expected Jubelio bundle against the QBO entry by SKU (preferred) or
// Name. Reports per-field diff: SKU, Name presence, UnitPrice, component lines
// (SKU + Qty), and PrintGroupedItems flag.
//
// Read-only. Usage: node scripts/audit-bundles.js

require('dotenv').config();
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');

const qboBaseUrl = (qbo) => {
    const host = qbo.useSandbox ? 'sandbox-quickbooks.api.intuit.com' : 'quickbooks.api.intuit.com';
    return `https://${host}/v3/company/${qbo.realmId}`;
};

const qboFetch = async (qbo, path) => {
    const url = `${qboBaseUrl(qbo)}${path}${path.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' },
    });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(`QBO ${path} (${res.status}): ${JSON.stringify(body).slice(0, 400)}`);
    return body;
};

const fetchAllItems = async (qbo) => {
    const out = [];
    const PAGE = 200;
    for (let startPosition = 1; startPosition < 10000; startPosition += PAGE) {
        const q = `SELECT * FROM Item STARTPOSITION ${startPosition} MAXRESULTS ${PAGE}`;
        const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const items = body?.QueryResponse?.Item || [];
        if (!items.length) break;
        out.push(...items);
        if (items.length < PAGE) break;
    }
    return out;
};

// Canonical Jubelio bundles (from jubelio-products.json + jubelio-bundle-composition.json
// + memory project_canonical_sync_migration.md for MRS-003 components).
const CANONICAL = [
    {
        sku: 'MRS-002', name: 'TREELOGY Moringa Ritual Set + Powder 45gr (Ritual Starter Bundle)',
        price: 1290000,
        components: [
            { sku: 'MRS-001', qty: 1, price: 1090000 },
            { sku: 'OMP-45-001', qty: 1, price: 320000 },
        ],
    },
    {
        sku: 'MRS-003', name: 'TREELOGY Moringa Ritual Set + Powder 90gr (Daily Wellness Bundle)',
        price: 1450000,
        components: [
            { sku: 'MRS-001', qty: 1, price: 1090000 },
            { sku: 'OMP-90-001', qty: 1, price: 540000 },
        ],
    },
    {
        sku: 'MRS-004', name: 'TREELOGY Moringa Ritual Set + Powder 180gr (The Complete Ritual Bundle)',
        price: 1780000,
        components: [
            { sku: 'MRS-001', qty: 1, price: 1090000 },
            { sku: 'OMP-180-001', qty: 1, price: 990000 },
        ],
    },
    {
        sku: 'Discovery-Pack', name: 'Treelogy The Discovery Pack',
        price: 1180000,
        components: [
            { sku: 'OMP-45-001', qty: 1, price: 320000 },
            { sku: 'OMO-30-001', qty: 1, price: 470000 },
            { sku: 'OMC-90-001', qty: 1, price: 390000 },
        ],
    },
    {
        sku: 'Inside-Out-Protocol', name: 'Inside Out Moringa Protocol (Capsule 90 + Oil 30ml)',
        price: 690000,
        components: [
            { sku: 'OMC-90-001', qty: 1, price: 390000 },
            { sku: 'OMO-30-001', qty: 1, price: 470000 },
        ],
    },
    {
        sku: 'The-Movement-&-Relief', name: 'TREELOGY The Movement & Relief',
        price: 1450000,
        components: [
            { sku: 'OMC-180-001', qty: 1, price: 690000 },
            { sku: 'OMO-60-001', qty: 1, price: 790000 },
        ],
    },
];

const idx = (key, value, allItems) => allItems.find(i => String(i[key] || '').trim().toLowerCase() === String(value || '').trim().toLowerCase());

const findQboBundle = (canonical, allItems) => {
    // Priority: SKU match → Name match (exact) → Name match (loose contains)
    const bySku = idx('Sku', canonical.sku, allItems);
    if (bySku) return { match: bySku, by: 'sku' };
    const byName = idx('Name', canonical.name, allItems);
    if (byName) return { match: byName, by: 'name (exact)' };
    const byNameLoose = allItems.find(i => {
        const n = String(i.Name || '').toLowerCase();
        const c = canonical.name.toLowerCase().split(/[(|]/)[0].trim();
        return n.includes(c) || (canonical.sku && n.includes(canonical.sku.toLowerCase()));
    });
    if (byNameLoose) return { match: byNameLoose, by: 'name (loose)' };
    return null;
};

const fmtIDR = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID')}`;

(async () => {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('🔍 Fetching QBO items…');
    const qbo = await getQboInstance();
    const all = await fetchAllItems(qbo);
    const groups = all.filter(i => i.Type === 'Group');
    const groupsActive = groups.filter(i => i.Active);
    console.log(`   Total items: ${all.length}`);
    console.log(`   Type=Group:  ${groups.length} (active: ${groupsActive.length})\n`);

    if (groups.length === 0) {
        console.log('⚠️  Tidak ada Item Type=Group di QBO. Bundle belum ke-create atau ke-create dengan Type lain.');
        return;
    }

    console.log('📦 Group items found di QBO:');
    for (const g of groups) {
        const compCount = g.ItemGroupDetail?.ItemGroupLine?.length || 0;
        console.log(`   • id=${g.Id} Sku="${g.Sku || '∅'}" Name="${g.Name}" Active=${g.Active} components=${compCount} UnitPrice=${g.UnitPrice ?? '∅'}`);
    }
    console.log();

    // Build SKU→item lookup so we can resolve component refs
    const itemById = new Map(all.map(i => [String(i.Id), i]));

    let okCount = 0, mismatchCount = 0, missingCount = 0;

    for (const c of CANONICAL) {
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        console.log(`🎯 ${c.sku}  (expected: "${c.name}")`);

        const found = findQboBundle(c, groups);
        if (!found) {
            console.log(`   ❌ NOT FOUND di QBO Group items.`);
            missingCount++;
            console.log();
            continue;
        }

        const q = found.match;
        const issues = [];
        console.log(`   ✓ Match by ${found.by} → QBO id=${q.Id} Name="${q.Name}" Sku="${q.Sku || '∅'}"`);

        // SKU
        if (!q.Sku || q.Sku.trim() !== c.sku) {
            issues.push(`SKU: QBO="${q.Sku || '∅'}" vs canonical="${c.sku}"`);
        }

        // Active
        if (q.Active === false) issues.push(`Active=false`);

        // Type
        if (q.Type !== 'Group') issues.push(`Type=${q.Type} (expected Group)`);

        // PrintGroupedItems flag (must be true for invoice to print components)
        const printFlag = q.ItemGroupDetail?.PrintGroupedItems;
        if (printFlag !== true) {
            issues.push(`PrintGroupedItems=${printFlag} — should be true ("Display bundle components when printing or sending transactions")`);
        }

        // UnitPrice — QBO Group items typically don't carry UnitPrice (price comes from member items),
        // but some merchants set it manually. Don't fail on absence; warn on mismatch only.
        if (q.UnitPrice != null && Math.round(Number(q.UnitPrice)) !== Math.round(c.price)) {
            issues.push(`UnitPrice: QBO=${fmtIDR(q.UnitPrice)} vs canonical=${fmtIDR(c.price)}`);
        }

        // Components
        const lines = q.ItemGroupDetail?.ItemGroupLine || [];
        if (lines.length !== c.components.length) {
            issues.push(`Component count: QBO=${lines.length} vs canonical=${c.components.length}`);
        }

        const compReport = [];
        for (const want of c.components) {
            // Find QBO line whose ItemRef→Item.Sku matches want.sku
            const matchedLine = lines.find(l => {
                const refId = l.ItemRef?.value;
                const itm = refId ? itemById.get(String(refId)) : null;
                return itm && String(itm.Sku || '').trim() === want.sku;
            });
            if (!matchedLine) {
                // Try to match by name fallback
                const byName = lines.find(l => {
                    const refId = l.ItemRef?.value;
                    const itm = refId ? itemById.get(String(refId)) : null;
                    return itm && String(itm.Name || '').toLowerCase().includes(want.sku.toLowerCase());
                });
                if (byName) {
                    const refId = byName.ItemRef?.value;
                    const itm = itemById.get(String(refId));
                    compReport.push(`     ⚠ ${want.sku} — found by NAME not SKU (QBO id=${refId} Name="${itm?.Name}" Sku="${itm?.Sku || '∅'}")`);
                    issues.push(`Component ${want.sku} child item missing/wrong SKU`);
                } else {
                    compReport.push(`     ❌ ${want.sku} x${want.qty} — MISSING from bundle`);
                    issues.push(`Component ${want.sku} not in bundle lines`);
                }
                continue;
            }
            const refId = matchedLine.ItemRef?.value;
            const itm = itemById.get(String(refId));
            const gotQty = Number(matchedLine.Qty || 0);
            const qtyOk = gotQty === want.qty;
            compReport.push(`     ${qtyOk ? '✓' : '⚠'} ${want.sku} x${gotQty}${qtyOk ? '' : ` (expected x${want.qty})`} → QBO id=${refId} Name="${itm?.Name}"`);
            if (!qtyOk) issues.push(`Component ${want.sku} qty=${gotQty} (expected ${want.qty})`);
        }

        // Detect EXTRA components in QBO that aren't in canonical
        const extras = lines.filter(l => {
            const refId = l.ItemRef?.value;
            const itm = refId ? itemById.get(String(refId)) : null;
            const sku = itm ? String(itm.Sku || '').trim() : '';
            return !c.components.some(cc => cc.sku === sku);
        });
        for (const ex of extras) {
            const refId = ex.ItemRef?.value;
            const itm = itemById.get(String(refId));
            compReport.push(`     ⚠ EXTRA: id=${refId} Sku="${itm?.Sku || '∅'}" Name="${itm?.Name}" qty=${ex.Qty}`);
            issues.push(`Extra component in bundle: ${itm?.Sku || itm?.Name || refId}`);
        }

        console.log(`   Components (${lines.length}):`);
        compReport.forEach(l => console.log(l));

        if (issues.length === 0) {
            console.log(`   ✅ MATCH — semua field sesuai canonical.`);
            okCount++;
        } else {
            console.log(`   ⚠ ${issues.length} issue(s):`);
            issues.forEach(i => console.log(`      - ${i}`));
            mismatchCount++;
        }
        console.log();
    }

    console.log('═════════════════════════════════════════════════════');
    console.log(`Summary: ${okCount} OK / ${mismatchCount} mismatch / ${missingCount} missing  (of ${CANONICAL.length} canonical)`);
    await mongoose.disconnect();
})()
.catch(async err => { console.error('FATAL:', err); try { await mongoose.disconnect(); } catch {} process.exit(1); });
