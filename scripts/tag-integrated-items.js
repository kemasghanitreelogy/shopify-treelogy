// Tag canonical Inventory items (yang ke-sync dari Jubelio) dengan
// "[Integrated]" di Sales Description supaya finance gampang identifikasi
// produk yang dimanage oleh integrasi Jubelio.
//
// Idempotent: skip kalau tag sudah ada.
//
// Usage:
//   node scripts/tag-integrated-items.js          # dry-run
//   node scripts/tag-integrated-items.js --apply

require('dotenv').config();
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');

const apply = process.argv.includes('--apply');

// Canonical Inventory + Bundle items + their target SKU (untuk verify).
// Bundles (Type=Group) created manually di QBO UI Phase 3 — included here so
// they also carry the [Integrated] marker in Description.
const CANONICAL = [
    // Inventory canonical (Phase 1)
    { id: '22', sku: 'OMP-45-001' },
    { id: '9',  sku: 'OMP-90-001' },
    { id: '6',  sku: 'OMP-180-001' },
    { id: '18', sku: 'OMC-90-001' },
    { id: '20', sku: 'OMC-180-001' },
    { id: '15', sku: 'OMO-30-001' },
    { id: '16', sku: 'OMO-60-001' },
    { id: '13', sku: 'MRS-001' },
    { id: '24', sku: 'Bamboo-Scoop' },
    { id: '56', sku: 'Bamboo-Whisk' },
    // Bundles (Phase 3)
    { id: '58', sku: 'MRS-002' },
    { id: '59', sku: 'MRS-003' },
    { id: '60', sku: 'MRS-004' },
    { id: '61', sku: 'Inside-Out-Protocol' },
    { id: '62', sku: 'Discovery-Pack' },
    { id: '63', sku: 'The-Movement-&-Relief' },
];

const TAG = '[Integrated]';

const qboBaseUrl = (qbo) => `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;

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
    if (!res.ok) throw new Error(`QBO ${opts.method || 'GET'} ${p} (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
    return body;
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    console.log(`\n🏷️  Tag canonical items dengan "${TAG}" · mode=${apply ? 'APPLY' : 'DRY-RUN'}\n`);

    let stats = { tagged: 0, alreadyTagged: 0, skuMismatch: 0, errors: 0 };

    for (const c of CANONICAL) {
        try {
            const body = await qboFetch(qbo, `/item/${c.id}`);
            const item = body?.Item;
            if (!item) {
                console.log(`  ❌ id=${c.id}: not found`);
                stats.errors++;
                continue;
            }
            // Verify SKU match (safety)
            if ((item.Sku || '').trim() !== c.sku) {
                console.log(`  ⚠️  id=${c.id}: SKU mismatch! expected="${c.sku}" got="${item.Sku || '—'}" — skip`);
                stats.skuMismatch++;
                continue;
            }
            const currentDesc = item.Description || '';
            if (currentDesc.includes(TAG)) {
                console.log(`  ⏭  id=${c.id} sku=${c.sku}: already has tag, skip`);
                stats.alreadyTagged++;
                continue;
            }
            // Strip any pre-existing "Integrated" word (any case, no brackets) so
            // we don't end up with "[Integrated] Integrated" duplication when user
            // had typed the tag manually without brackets in QBO UI.
            const stripped = currentDesc.replace(/\bintegrated\b\s*/gi, '').trim();
            const newDesc = stripped
                ? `${TAG} ${stripped}`
                : `${TAG} ${item.Name}`;

            console.log(`  🏷️  id=${c.id} sku=${c.sku}: "${currentDesc.slice(0, 50)}" → "${newDesc.slice(0, 60)}"`);

            if (apply) {
                await qboFetch(qbo, '/item', {
                    method: 'POST',
                    body: JSON.stringify({
                        Id: item.Id,
                        SyncToken: item.SyncToken,
                        sparse: true,
                        Description: newDesc,
                    }),
                });
                stats.tagged++;
                await sleep(120);
            } else {
                stats.tagged++; // count as would-tag in dry-run
            }
        } catch (e) {
            console.error(`  💥 id=${c.id}: ${e.message.slice(0, 200)}`);
            stats.errors++;
        }
    }

    console.log(`\n📊 SUMMARY · tagged=${stats.tagged} · alreadyTagged=${stats.alreadyTagged} · skuMismatch=${stats.skuMismatch} · errors=${stats.errors}`);
    await mongoose.disconnect();
})().catch(e => { console.error('💥', e.message); process.exit(1); });
