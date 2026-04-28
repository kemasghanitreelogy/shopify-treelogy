// Local smoke test for Phase 8 bundle expansion in routes/jubelioWebhook.js
// Imports the buildLines function via a controlled fake `so` object and prints
// the resulting line array. Read-only against QBO (only does SKU→Id lookups).
//
// Toggle BUNDLE_AWARE=true to test bundle path.
//
//   BUNDLE_AWARE=true node scripts/test-bundle-expansion.js

require('dotenv').config();
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');

// Re-implement buildLines's relevant helpers by re-requiring the module — but
// buildLines is internal. Easiest: replicate the path as a simulation.
const { isBundleSku, getBundleComposition, isBundleAwareEnabled } = require('../services/bundleService');

const SAFE_ITEM_TYPES = new Set(['Service', 'Inventory', 'NonInventory']);

const qboFindItemsBySku = (qbo, sku) => new Promise((resolve) => {
    qbo.findItems([{ field: 'Sku', value: sku, operator: '=' }], (err, body) => {
        if (err) return resolve([]);
        resolve(body?.QueryResponse?.Item || []);
    });
});

const FAKE_ORDERS = [
    {
        label: 'Bundle: Discovery-Pack at promo price (998.900)',
        items: [{ item_code: 'Discovery-Pack', item_name: 'Discovery Pack', qty: 1, sell_price: 998900, amount: 998900 }],
    },
    {
        label: 'Bundle: The-Movement-&-Relief at full price (1.450.000)',
        items: [{ item_code: 'The-Movement-&-Relief', item_name: 'Movement Relief', qty: 1, sell_price: 1450000, amount: 1450000 }],
    },
    {
        label: 'Mixed: Inside-Out-Protocol + 1 Powder 45gr',
        items: [
            { item_code: 'Inside-Out-Protocol', item_name: 'Inside Out Protocol', qty: 1, sell_price: 690000, amount: 690000 },
            { item_code: 'OMP-45-001', item_name: 'Powder 45gr', qty: 1, sell_price: 320000, amount: 320000 },
        ],
    },
    {
        label: 'Non-bundle: just OMC-180-001',
        items: [{ item_code: 'OMC-180-001', item_name: 'Capsule 180', qty: 1, sell_price: 690000, amount: 690000 }],
    },
    {
        label: 'Marketplace fees: SP-260425PHT0VE69-like (Movement & Relief 1.250 + service_fee 152.500 + order_processing_fee 1.250)',
        items: [{ item_code: 'The-Movement-&-Relief', item_name: 'Movement Relief', qty: 1, sell_price: 1400000, amount: 1250000 }],
        grand_total: 1096250,
        service_fee: 152500,
        order_processing_fee: 1250,
    },
    {
        label: 'Marketplace fees on non-bundle: OMC-180 390k + service_fee 52.650 + processing_fee 1.250 (= 336.100 net)',
        items: [{ item_code: 'OMC-180-001', item_name: 'Capsule 180', qty: 1, sell_price: 390000, amount: 390000 }],
        grand_total: 336100,
        service_fee: 52650,
        order_processing_fee: 1250,
    },
];

const simulate = async (qbo, so) => {
    const taxCodeId = '7'; // No VAT, like prod
    const lines = [];
    for (const it of so.items) {
        const qty = Number(it.qty || 1);
        const lineAmount = Number(it.amount || it.sell_price * qty);
        const jubelioAmount = Math.round(lineAmount * 100) / 100;
        const itemCode = String(it.item_code || '').trim();

        if (isBundleAwareEnabled() && isBundleSku(itemCode)) {
            const composition = getBundleComposition(itemCode);
            const skuToItem = new Map();
            let allResolved = true;
            for (const c of composition.components) {
                const found = await qboFindItemsBySku(qbo, c.sku);
                const TYPE_RANK = { Inventory: 0, NonInventory: 1, Service: 2 };
                const candidates = found.filter(i => SAFE_ITEM_TYPES.has(i.Type) && i.Active !== false);
                candidates.sort((a, b) => (TYPE_RANK[a.Type] ?? 9) - (TYPE_RANK[b.Type] ?? 9));
                const usable = candidates[0];
                if (!usable) { allResolved = false; break; }
                skuToItem.set(c.sku, usable);
            }
            if (allResolved) {
                let componentSum = 0;
                for (const c of composition.components) {
                    const compQty = c.qty * qty;
                    const compAmount = Math.round(c.unitPrice * compQty * 100) / 100;
                    componentSum += compAmount;
                    const compItem = skuToItem.get(c.sku);
                    lines.push({
                        Description: `[${itemCode}] ${compItem.Name}`.substring(0, 4000),
                        Amount: compAmount,
                        DetailType: 'SalesItemLineDetail',
                        SalesItemLineDetail: { Qty: compQty, UnitPrice: c.unitPrice, ItemRef: { value: compItem.Id }, TaxCodeRef: { value: taxCodeId } },
                    });
                }
                const discount = Math.round((componentSum - jubelioAmount) * 100) / 100;
                if (discount > 0) {
                    lines.push({
                        Description: `${itemCode} bundle discount`,
                        Amount: discount,
                        DetailType: 'DiscountLineDetail',
                        DiscountLineDetail: { PercentBased: false },
                    });
                }
                continue;
            }
        }
        // Non-bundle (simulated regular path — just SKU lookup)
        const found = await qboFindItemsBySku(qbo, itemCode);
        const TYPE_RANK = { Inventory: 0, NonInventory: 1, Service: 2 };
        const candidates = found.filter(i => SAFE_ITEM_TYPES.has(i.Type) && i.Active !== false);
        candidates.sort((a, b) => (TYPE_RANK[a.Type] ?? 9) - (TYPE_RANK[b.Type] ?? 9));
        const usable = candidates[0];
        lines.push({
            Description: `${it.item_name || itemCode}`.substring(0, 4000),
            Amount: jubelioAmount,
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: { Qty: qty, UnitPrice: jubelioAmount / qty, ItemRef: { value: usable?.Id || '?' }, TaxCodeRef: { value: taxCodeId } },
        });
    }

    // Marketplace fee adjustment (mirrors webhook logic in routes/jubelioWebhook.js)
    if (String(process.env.MARKETPLACE_FEE_AWARE || '').toLowerCase() === 'true') {
        const grandTotal = Number(so.grand_total ?? NaN);
        if (Number.isFinite(grandTotal)) {
            const linesTotal = lines.reduce((s, l) =>
                s + (l.DetailType === 'DiscountLineDetail' ? -Number(l.Amount || 0) : Number(l.Amount || 0)), 0);
            const adjustment = Math.round((linesTotal - grandTotal) * 100) / 100;
            if (adjustment > 0.01) {
                const parts = [];
                const fmt = (n) => `Rp ${Number(n).toLocaleString('id-ID')}`;
                if (Number(so.service_fee) > 0) parts.push(`service_fee ${fmt(so.service_fee)}`);
                if (Number(so.order_processing_fee) > 0) parts.push(`order_processing_fee ${fmt(so.order_processing_fee)}`);
                lines.push({
                    Description: `Marketplace fees & adjustments${parts.length ? ` (${parts.join(' + ')})` : ''}`,
                    Amount: adjustment,
                    DetailType: 'DiscountLineDetail',
                    DiscountLineDetail: { PercentBased: false },
                });
            }
        }
    }
    return lines;
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    console.log(`\n🔬 Bundle expansion test · BUNDLE_AWARE=${isBundleAwareEnabled() ? 'true' : 'false'}\n`);
    for (const so of FAKE_ORDERS) {
        console.log(`━━━ ${so.label}`);
        const lines = await simulate(qbo, so);
        let total = 0;
        for (const l of lines) {
            const detail = l.SalesItemLineDetail || l.DiscountLineDetail || {};
            const ref = detail.ItemRef || {};
            const sign = l.DetailType === 'DiscountLineDetail' ? '-' : '+';
            console.log(`  ${sign} ${l.DetailType.padEnd(22)} amt=Rp ${l.Amount.toLocaleString('id-ID').padStart(11)} ` +
                `${ref.value ? `item=${ref.value}` : ''} qty=${detail.Qty || ''} desc="${(l.Description || '').slice(0, 50)}"`);
            total += l.DetailType === 'DiscountLineDetail' ? -l.Amount : l.Amount;
        }
        console.log(`  ──────── Total: Rp ${total.toLocaleString('id-ID')}`);
        console.log();
    }
    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e); try { await mongoose.disconnect(); } catch {} process.exit(1); });
