// Migration Preview — generates a full action plan for QBO ↔ Jubelio canonical sync.
// Read-only. Outputs migration-plan.json + migration-preview.md.
//
// Strategy reflects user's choices (2026-04-28):
//   - Historical invoices: redirect ke Inventory baru (Pilihan B)
//   - Skip 3 archived Jubelio SKU
//   - Bundle pricing: bundle line price = sum komponen + diskon line if cheaper
//   - Stock opening = Jubelio current available_qty
//   - Bamboo-Whisk: create new Inventory
//   - Bundle Jubelio → QBO Group item dengan komponen Inventory canonical
//   - Sample (id 39, 40) keep
//   - "Sales", "Hours" (QBO defaults), "Shipping Charge", Shopify connector items: keep
//   - Selain itu, inactivate kalau tidak match Jubelio canonical

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');

const QBO_AUDIT = JSON.parse(fs.readFileSync('qbo-items-audit.json', 'utf8'));
const JUB_PRODUCTS = JSON.parse(fs.readFileSync('jubelio-products.json', 'utf8'));
const JUB_BUNDLES = JSON.parse(fs.readFileSync('jubelio-bundle-composition.json', 'utf8'));

// ── QBO REST helper ────────────────────────────────────────────────────────
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
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(`QBO ${path} (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
    return body;
};

// ── Build canonical target state ──────────────────────────────────────────
const stripBrand = (s) => String(s || '').replace(/^\s*TREELOGY\b[\s|,\-]*/i, '').trim();
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

const buildTargetState = () => {
    const targetSatuan = []; // canonical Inventory items
    for (const g of JUB_PRODUCTS.active) {
        for (const v of g.variants || []) {
            const variation = (v.variation_values || []).map(vv => vv.value).join(' / ');
            const desiredName = variation
                ? `${g.item_name} (${variation})`.substring(0, 100)
                : g.item_name.substring(0, 100);
            targetSatuan.push({
                sku: v.item_code,
                desiredName,
                groupName: g.item_name,
                variationLabel: variation,
                sellPrice: v.sell_price,
                stockOpening: v.available_qty || 0,
                jubelioItemId: v.item_id,
            });
        }
    }
    const targetBundles = JUB_BUNDLES.map(b => {
        const components = (b._raw?.bundles || []).map(c => ({
            sku: c.item_code,
            qty: Number(c.qty || 1),
            sellPrice: Number(c.sell_price || 0),
            itemName: c.item_name,
        }));
        const componentSum = components.reduce((s, c) => s + (c.sellPrice * c.qty), 0);
        const bundlePrice = Number(b.bundle_price || 0);
        return {
            sku: b.bundle_sku,
            desiredName: b.bundle_name.substring(0, 100),
            bundlePrice,
            components,
            componentSum,
            discount: bundlePrice < componentSum ? (componentSum - bundlePrice) : 0,
        };
    });
    return { targetSatuan, targetBundles };
};

// ── Match QBO items to canonical targets ───────────────────────────────────
// Hand-curated mapping (verified against QBO audit + Jubelio data).
// Excludes Consignment variants since those are separate accounting buckets.
const SKU_TO_QBO_ID = {
    'OMP-45-001':   { id: '22', name: 'Moringa Dried Leaf Powder - 45grams' },
    'OMP-90-001':   { id: '9',  name: 'Moringa Dried Leaf Powder - 90grams' },
    'OMP-180-001':  { id: '6',  name: 'Moringa Dried Leaf Powder 180grams' },
    'OMC-90-001':   { id: '18', name: 'Moringa Capsules-90Pcs' },
    'OMC-180-001':  { id: '20', name: 'Moringa Capsules-180Pcs' },
    'OMO-30-001':   { id: '15', name: 'Moringa Seed Oil - 30ml' },
    'OMO-60-001':   { id: '16', name: 'Moringa Seed Oil - 60ml' },
    'MRS-001':      { id: '13', name: 'Moringa Ritual Set (currently has Sku=MRS-002 — typo to fix)' },
    'Bamboo-Scoop': { id: '24', name: 'Bamboo Scoop (already correct)' },
    'Bamboo-Whisk': null, // create new
};

const matchInventoryToSatuan = (target) => {
    const mapping = SKU_TO_QBO_ID[target.sku];
    if (mapping === undefined) return null;
    if (mapping === null) return null; // create new
    const candidate = QBO_AUDIT.items.find(i => i.id === mapping.id);
    if (!candidate) return null;
    return { match: candidate, by: 'manual map' };
};

// ── Identify Service items dari integrasi (untuk redirect + inactivate) ────
const findIntegrationServiceItems = () => {
    return QBO_AUDIT.items.filter(i =>
        i.type === 'Service'
        && i.active
        && i.bucket !== 'CATEGORY'
        && (i.bucket === 'JUBELIO_INTEGRATION' || i.bucket === 'JUBELIO_GENERIC_FALLBACK'
            || i.bucket === 'AMBIGUOUS_SERVICE')
        // Excludes default QBO ("Sales", "Hours") and Shopify items and SAMPLE
        && !/^(Sales|Hours|SAMPLE)$/i.test(i.name)
        && !/^Shopify\s/i.test(i.name)
        && !/^Shipping Charge$/i.test(i.name)
    );
};

// ── Identify orphan legacy Inventory (untuk inactivate) ────────────────────
const findOrphanLegacyInventory = (matchedIds) => {
    return QBO_AUDIT.items.filter(i =>
        i.type === 'Inventory'
        && i.active
        && !matchedIds.has(i.id)
    );
};

// ── Fetch invoice references per item ──────────────────────────────────────
const buildInvoiceIndex = async (qbo, targetItemIds) => {
    const targetSet = new Set(targetItemIds.map(String));
    const index = new Map();
    for (const id of targetSet) index.set(id, []);

    const PAGE = 200;
    let scanned = 0;
    for (let start = 1; start < 5000; start += PAGE) {
        const q = `SELECT * FROM Invoice STARTPOSITION ${start} MAXRESULTS ${PAGE}`;
        const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const invs = body?.QueryResponse?.Invoice || [];
        if (invs.length === 0) break;
        scanned += invs.length;
        for (const inv of invs) {
            for (const l of inv.Line || []) {
                if (l.DetailType !== 'SalesItemLineDetail') continue;
                const refId = String(l.SalesItemLineDetail?.ItemRef?.value || '');
                if (!targetSet.has(refId)) continue;
                index.get(refId).push({
                    invoiceId: inv.Id,
                    docNumber: inv.DocNumber,
                    txnDate: inv.TxnDate,
                    lineId: l.Id,
                    qty: l.SalesItemLineDetail?.Qty || 0,
                    amount: l.Amount,
                    description: l.Description,
                });
            }
        }
        if (invs.length < PAGE) break;
    }
    console.log(`  📊 Scanned ${scanned} invoices`);
    return index;
};

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set');
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    console.log(`🔌 QBO realm ${qbo.realmId}\n`);

    const { targetSatuan, targetBundles } = buildTargetState();
    console.log(`🎯 Target: ${targetSatuan.length} Inventory satuan + ${targetBundles.length} Group/Bundle\n`);

    // Phase 1+2: rename / create Inventory satuan
    const phase1 = []; // RENAME+SETSKU
    const phase2 = []; // CREATE new
    const matchedQboIds = new Set();
    const skuToCanonicalQboMatch = new Map(); // future Inventory id (or 'NEW:xxx')

    for (const t of targetSatuan) {
        const m = matchInventoryToSatuan(t);
        if (m) {
            matchedQboIds.add(m.match.id);
            const desiredSku = t.sku;
            const desiredName = t.desiredName;
            const needsRename = norm(m.match.name) !== norm(desiredName);
            const needsSku = (m.match.sku || '').trim() !== desiredSku;
            if (needsRename || needsSku) {
                phase1.push({
                    qboId: m.match.id,
                    currentName: m.match.name,
                    currentSku: m.match.sku || '',
                    desiredName,
                    desiredSku,
                    matchBy: m.by,
                    target: t,
                });
            } else {
                phase1.push({
                    qboId: m.match.id,
                    currentName: m.match.name,
                    currentSku: m.match.sku || '',
                    desiredName,
                    desiredSku,
                    matchBy: m.by,
                    target: t,
                    skip: 'already correct',
                });
            }
            skuToCanonicalQboMatch.set(t.sku, m.match.id);
        } else {
            phase2.push({
                desiredName: t.desiredName,
                desiredSku: t.sku,
                stockOpening: t.stockOpening,
                sellPrice: t.sellPrice,
                target: t,
            });
            skuToCanonicalQboMatch.set(t.sku, `NEW:${t.sku}`);
        }
    }

    // Phase 3: redirect Service satuan invoice lines
    const integrationServices = findIntegrationServiceItems();
    const serviceIds = integrationServices.map(s => s.id);
    console.log('📊 Building invoice index for Service items...');
    const invIndex = await buildInvoiceIndex(qbo, serviceIds);

    // Map each Service item to its canonical destination (Inventory or Bundle)
    const serviceTargetMap = new Map();
    for (const svc of integrationServices) {
        const sku = (svc.sku || '').trim();
        const sname = norm(svc.name);
        // Special: Jubelio Sync Item generic — use existing migrate-items service (redirects by line description)
        if (/^jubelio sync item/i.test(svc.name)) {
            serviceTargetMap.set(svc.id, { kind: 'generic-fallback', target: 'BY_DESCRIPTION', note: 'Pakai runItemMigration existing service untuk redirect per-line description' });
            continue;
        }
        // SKU match → satuan
        if (skuToCanonicalQboMatch.has(sku)) {
            serviceTargetMap.set(svc.id, { kind: 'inventory', target: skuToCanonicalQboMatch.get(sku) });
            continue;
        }
        // SKU match → bundle
        const bundle = targetBundles.find(b => b.sku === sku);
        if (bundle) {
            serviceTargetMap.set(svc.id, { kind: 'bundle', target: `NEW:bundle:${bundle.sku}` });
            continue;
        }
        // Name match → bundle (Discovery Pack / Movement & Relief variants tanpa SKU)
        if (/discovery\s*pack/i.test(svc.name)) {
            serviceTargetMap.set(svc.id, { kind: 'bundle', target: 'NEW:bundle:Discovery-Pack', by: 'name match Discovery Pack' });
            continue;
        }
        if (/movement\s*&?\s*relief/i.test(svc.name)) {
            serviceTargetMap.set(svc.id, { kind: 'bundle', target: 'NEW:bundle:The-Movement-&-Relief', by: 'name match Movement & Relief' });
            continue;
        }
        if (/inside\s*out\s*moringa\s*protocol/i.test(svc.name)) {
            serviceTargetMap.set(svc.id, { kind: 'bundle', target: 'NEW:bundle:Inside-Out-Protocol', by: 'name match Inside Out' });
            continue;
        }
        // Name match → satuan (Ritual Set without SKU)
        if (/ritual\s*set/i.test(svc.name) && !/\+\s*powder/i.test(svc.name)) {
            serviceTargetMap.set(svc.id, { kind: 'inventory', target: skuToCanonicalQboMatch.get('MRS-001'), by: 'name match Ritual Set' });
            continue;
        }
        serviceTargetMap.set(svc.id, { kind: 'unknown' });
    }

    // Phase 5: orphan legacy Inventory yang tidak match Jubelio
    const orphanInventory = findOrphanLegacyInventory(matchedQboIds);

    // Build redirect plan
    const redirectPlan = [];
    let totalRedirectLines = 0;
    for (const svc of integrationServices) {
        const dest = serviceTargetMap.get(svc.id);
        const invoices = invIndex.get(String(svc.id)) || [];
        totalRedirectLines += invoices.length;
        redirectPlan.push({
            serviceId: svc.id,
            serviceName: svc.name,
            serviceSku: svc.sku || '',
            destination: dest,
            invoiceCount: invoices.length,
            invoices: invoices.slice(0, 5).map(i => ({ docNumber: i.docNumber, txnDate: i.txnDate, qty: i.qty, amount: i.amount })),
            totalQtyToRedirect: invoices.reduce((s, i) => s + Number(i.qty || 0), 0),
            totalAmount: invoices.reduce((s, i) => s + Number(i.amount || 0), 0),
        });
    }

    // Final plan object
    const plan = {
        generatedAt: new Date().toISOString(),
        decisions: {
            historicalInvoiceStrategy: 'REDIRECT_TO_INVENTORY (user choice — riskier but clean)',
            archivedJubelioSkus: 'SKIP',
            bundleDiscountStrategy: 'BUNDLE_LINE_AT_FULL + DISCOUNT_LINE_IF_CHEAPER',
            stockOpening: 'COPY_FROM_JUBELIO_AVAILABLE_QTY',
            preserve: ['SAMPLE (id 39, 40)', 'Sales (id 1)', 'Hours (id 2)', 'Shipping Charge (id 7)', 'Shopify connector items (10)', 'Categories (12)'],
        },
        phase1_renameLegacyInventory: phase1,
        phase2_createNewInventory: phase2,
        phase3_redirectServiceLines: redirectPlan,
        phase4_createGroupBundles: targetBundles.map(b => ({
            desiredSku: b.sku,
            desiredName: b.desiredName,
            bundlePrice: b.bundlePrice,
            componentSum: b.componentSum,
            discount: b.discount,
            members: b.components.map(c => ({
                sku: c.sku,
                qty: c.qty,
                sellPrice: c.sellPrice,
                itemName: c.itemName,
                qboInventoryId: skuToCanonicalQboMatch.get(c.sku) || 'NOT_RESOLVED',
            })),
        })),
        phase5_inactivateServiceItems: integrationServices.map(s => ({
            qboId: s.id,
            name: s.name,
            sku: s.sku || '',
            destination: serviceTargetMap.get(s.id),
        })),
        phase6_inactivateOrphanInventory: orphanInventory.map(i => ({
            qboId: i.id,
            name: i.name,
            sku: i.sku || '',
            reason: 'Tidak match Jubelio canonical',
        })),
        phase7_adjustStockToJubelio: targetSatuan.map(t => ({
            sku: t.sku,
            jubelioCurrentQty: t.stockOpening,
            qboCanonicalId: skuToCanonicalQboMatch.get(t.sku) || 'NEW',
        })),
        summary: {
            totalQboItemsBeforeMigration: QBO_AUDIT.total,
            renameLegacyInventory: phase1.filter(p => !p.skip).length,
            alreadyCorrect: phase1.filter(p => p.skip).length,
            createNewInventory: phase2.length,
            redirectServiceItems: redirectPlan.length,
            redirectInvoiceLines: totalRedirectLines,
            createGroupBundles: targetBundles.length,
            inactivateServiceItems: integrationServices.length,
            inactivateOrphanInventory: orphanInventory.length,
            preserveAsIs: 27, // Sample x2, defaults x2, shipping x1, shopify x10, categories x12
        },
    };

    fs.writeFileSync('migration-plan.json', JSON.stringify(plan, null, 2));
    console.log('💾 migration-plan.json written\n');

    // ── Generate readable Markdown ─────────────────────────────────────────
    const md = [];
    md.push('# Migration Preview: QBO ↔ Jubelio Canonical Sync\n');
    md.push(`**Generated:** ${new Date().toISOString().slice(0, 19).replace('T', ' ')}\n`);
    md.push(`**Status:** PREVIEW — belum ada perubahan ke QBO. Review file ini, kalau OK kasih tau saya untuk apply.\n\n`);

    md.push('## Keputusan Anda yang Saya Pakai\n');
    md.push('- ✅ Nota lama juga di-update pakai produk baru (riskier path, dengan mitigasi stock adjustment)');
    md.push('- ✅ Skip 3 produk Jubelio yang sudah arsip');
    md.push('- ✅ Bundle: bundle line di sum komponen, plus diskon line kalau bundle lebih murah');
    md.push('- ✅ Stok awal copy dari Jubelio current `available_qty`');
    md.push('- ✅ Bamboo Whisk dibuat baru sebagai Inventory');
    md.push('- ✅ 6 Bundle Jubelio jadi QBO Group items dengan komponen Inventory canonical');
    md.push('- ✅ Sample (id 39, 40) dipertahankan');
    md.push('- ✅ "Sales", "Hours", "Shipping Charge", Shopify items, Categories juga dipertahankan (sistem)\n');

    md.push('## Ringkasan Angka\n');
    md.push('| Operasi | Jumlah |');
    md.push('|---|---|');
    md.push(`| Rename + set SKU produk legacy Inventory | **${plan.summary.renameLegacyInventory}** |`);
    md.push(`| Sudah benar (skip) | ${plan.summary.alreadyCorrect} |`);
    md.push(`| Buat Inventory baru | **${plan.summary.createNewInventory}** |`);
    md.push(`| Service items dari integrasi → redirect lalu inactivate | **${plan.summary.redirectServiceItems}** |`);
    md.push(`| Total nota line yang ke-redirect | ${plan.summary.redirectInvoiceLines} |`);
    md.push(`| Buat Group/Bundle items | **${plan.summary.createGroupBundles}** |`);
    md.push(`| Orphan legacy Inventory yang di-inactivate | ${plan.summary.inactivateOrphanInventory} |`);
    md.push(`| Items yang dipertahankan | ${plan.summary.preserveAsIs} |`);
    md.push('');

    // FASE 1
    md.push('## FASE 1 — Rename + Set SKU Legacy Inventory\n');
    md.push('Yang sudah ada di QBO sebagai Inventory legacy, tinggal di-rename + set SKU = match Jubelio.\n');
    md.push('| QBO id | Nama Sekarang | Nama Baru | SKU Baru | Match by | Status |');
    md.push('|---|---|---|---|---|---|');
    for (const p of phase1) {
        md.push(`| ${p.qboId} | ${p.currentName.slice(0, 40)} | ${p.desiredName.slice(0, 50)} | \`${p.desiredSku}\` | ${p.matchBy} | ${p.skip ? '✅ skip' : '🔧 patch'} |`);
    }
    md.push('');

    // FASE 2
    md.push('## FASE 2 — Buat Inventory Baru\n');
    if (phase2.length === 0) {
        md.push('_Tidak ada._\n');
    } else {
        md.push('| Nama | SKU | Stok Awal | Harga Jual |');
        md.push('|---|---|---|---|');
        for (const p of phase2) {
            md.push(`| ${p.desiredName} | \`${p.desiredSku}\` | ${p.stockOpening} | Rp ${(p.sellPrice || 0).toLocaleString('id-ID')} |`);
        }
        md.push('');
    }

    // FASE 3
    md.push('## FASE 3 — Redirect Nota Lama dari Service ke Inventory/Bundle\n');
    md.push('Setiap line invoice yang reference Service item dari integrasi → di-redirect ke Inventory/Bundle yang benar.\n');
    md.push('| Service ID | Nama | SKU | Tujuan | # Nota | Total Qty | Total Rp |');
    md.push('|---|---|---|---|---|---|---|');
    for (const r of redirectPlan) {
        const dest = r.destination;
        const destStr = dest.kind === 'inventory'
            ? `Inventory ${dest.target}`
            : dest.kind === 'bundle'
                ? `Bundle ${String(dest.target).replace('NEW:bundle:', '')}`
                : '⚠️ TIDAK KETEMU';
        md.push(`| ${r.serviceId} | ${r.serviceName.slice(0, 40)} | \`${r.serviceSku || '—'}\` | ${destStr} | ${r.invoiceCount} | ${r.totalQtyToRedirect} | ${(r.totalAmount || 0).toLocaleString('id-ID')} |`);
    }
    md.push('');

    // FASE 4
    md.push('## FASE 4 — Buat Group/Bundle Items di QBO\n');
    md.push('Setiap bundle Jubelio dibuat sebagai QBO Group item dengan komponen Inventory canonical.\n');
    for (const b of plan.phase4_createGroupBundles) {
        md.push(`### \`${b.desiredSku}\` — ${b.desiredName}`);
        md.push(`- Harga bundle: **Rp ${(b.bundlePrice || 0).toLocaleString('id-ID')}**`);
        md.push(`- Sum komponen: Rp ${(b.componentSum || 0).toLocaleString('id-ID')}`);
        if (b.discount > 0) {
            md.push(`- 🟢 Diskon: **Rp ${b.discount.toLocaleString('id-ID')}** (akan jadi baris "Bundle Discount" di nota)`);
        } else {
            md.push(`- ✅ Tidak ada diskon (bundle = sum komponen)`);
        }
        md.push('- Komponen:');
        for (const m of b.members) {
            const idStr = String(m.qboInventoryId).startsWith('NEW') ? `🆕 ${m.qboInventoryId}` : `id=${m.qboInventoryId}`;
            md.push(`  - \`${m.sku}\` × ${m.qty} (Rp ${(m.sellPrice || 0).toLocaleString('id-ID')}) → ${idStr}`);
        }
        md.push('');
    }

    // FASE 5
    md.push('## FASE 5 — Inactivate Service Items Lama (setelah redirect)\n');
    md.push(`${integrationServices.length} Service items akan di-inactivate karena sudah di-replace oleh Inventory/Group items.\n`);
    md.push('| QBO id | Nama | SKU | Bucket |');
    md.push('|---|---|---|---|');
    for (const s of plan.phase5_inactivateServiceItems) {
        const svcInfo = integrationServices.find(x => x.id === s.qboId);
        md.push(`| ${s.qboId} | ${s.name.slice(0, 50)} | \`${s.sku || '—'}\` | ${svcInfo?.bucket || '—'} |`);
    }
    md.push('');

    // FASE 6
    md.push('## FASE 6 — Inactivate Orphan Legacy Inventory\n');
    md.push('Inventory legacy yang tidak match Jubelio canonical (kemungkinan barang lama / consignment yang sudah tidak dijual).\n');
    if (orphanInventory.length === 0) {
        md.push('_Tidak ada (semua legacy Inventory ke-pakai sebagai canonical)._\n');
    } else {
        md.push('| QBO id | Nama | SKU |');
        md.push('|---|---|---|');
        for (const o of plan.phase6_inactivateOrphanInventory) {
            md.push(`| ${o.qboId} | ${o.name.slice(0, 60)} | \`${o.sku || '—'}\` |`);
        }
        md.push('');
    }

    // FASE 7
    md.push('## FASE 7 — Stock Adjustment ke Angka Jubelio Current\n');
    md.push('Setelah semua selesai, stok per Inventory di-adjust supaya match `available_qty` Jubelio.\n');
    md.push('| SKU | Target QtyOnHand (Jubelio) | QBO id |');
    md.push('|---|---|---|');
    for (const a of plan.phase7_adjustStockToJubelio) {
        md.push(`| \`${a.sku}\` | ${a.jubelioCurrentQty} | ${a.qboCanonicalId} |`);
    }
    md.push('');

    // Risks & mitigations
    md.push('## ⚠️ Risiko & Mitigasi\n');
    md.push('| Risiko | Mitigasi |');
    md.push('|---|---|');
    md.push('| Cross-type redirect (Service→Inventory) bikin stok periode lampau distort | Set InvStartDate ke awal periode + opening qty cukup tinggi, lalu Stock Adjustment di akhir untuk match Jubelio current |');
    md.push('| Nota lama gagal di-update karena tax / business validation error | Per-line try/catch, skip yang gagal + flag di audit log; tidak rollback batch |');
    md.push('| Bundle pricing dengan diskon menghasilkan invoice total beda | Bundle line + discount line dengan tag yang sama supaya jelas kelihatan di nota |');
    md.push('| QBO API rate limit (500 req/min) | Sequential dengan jeda; total ~200-300 calls untuk full migration |');
    md.push('| Backup hilang | Snapshot QBO state full ke file JSON sebelum apply (qbo-snapshot-pre-migration-{ts}.json) |');
    md.push('| Mid-migration failure → state inkonsisten | Setiap fase di-checkpoint; bisa resume dari fase mana saja |');
    md.push('');

    md.push('## ✋ Sebelum Apply\n');
    md.push('1. Review file ini secara penuh');
    md.push('2. Pastikan QBO realm ID benar (production, bukan sandbox)');
    md.push('3. Backup QBO export Excel via UI sebagai cadangan tambahan');
    md.push('4. Pilih waktu apply yang minim aktivitas (mis. malam hari WIB)');
    md.push('5. Konfirmasi ke saya untuk lanjut → saya bikin script apply per-fase');
    md.push('');

    fs.writeFileSync('migration-preview.md', md.join('\n'));
    console.log('💾 migration-preview.md written');
    console.log('\n📋 Summary:');
    for (const [k, v] of Object.entries(plan.summary)) {
        console.log(`  ${k.padEnd(35)} ${v}`);
    }

    await mongoose.disconnect();
})().catch(e => {
    console.error('❌', e.message);
    console.error(e.stack);
    process.exit(1);
});
