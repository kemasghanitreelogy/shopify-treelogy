// Fetch detailed bundle compositions from Jubelio.
//
// Strategy: for each bundle in /inventory/item-bundles/, hit /inventory/items/{item_id}
// to get the full bundle structure (members + qty). Read-only.
//
// Output: jubelio-bundle-composition.json
//   {
//     bundle_sku, bundle_name, bundle_item_id, bundle_group_id,
//     bundle_price, components: [{sku, qty, item_name, sell_price}]
//   }

require('dotenv').config();
const fs = require('fs');
const { apiGet } = require('../services/jubelioApiService');

(async () => {
    const data = JSON.parse(fs.readFileSync('jubelio-products.json', 'utf8'));
    const bundles = data.bundles || [];
    console.log(`🔌 Fetching detail for ${bundles.length} bundles...\n`);

    const compositions = [];
    for (const b of bundles) {
        const bundleVariant = b.variants?.[0];
        if (!bundleVariant) {
            console.warn(`⚠️ ${b.item_name} has no variants — skip`);
            continue;
        }
        const itemId = bundleVariant.item_id;
        try {
            const detail = await apiGet(`/inventory/items/${itemId}`);
            // Probe shape
            const compRaw = detail?.bundle_items
                || detail?.composition
                || detail?.components
                || detail?.bundle_composition
                || detail?.item_bundle
                || [];
            const components = (Array.isArray(compRaw) ? compRaw : []).map(c => ({
                sku: String(c.item_code || c.sku || c.bundle_item_code || '').trim(),
                item_id: c.item_id || c.bundle_item_id || null,
                item_name: c.item_name || c.bundle_item_name || '',
                qty: Number(c.qty_required || c.qty || c.quantity || c.bundle_qty || 1),
                sell_price: c.sell_price ?? c.price ?? null,
            }));
            compositions.push({
                bundle_sku: bundleVariant.item_code,
                bundle_name: b.item_name,
                bundle_item_id: itemId,
                bundle_group_id: b.item_group_id,
                bundle_price: bundleVariant.sell_price,
                components,
                detailKeys: Object.keys(detail || {}),
                _raw: detail,  // keep so we can probe shape if components are empty
            });
            console.log(`  ✓ ${bundleVariant.item_code.padEnd(22)} → ${components.length} components${components.length === 0 ? '  (probing keys: ' + Object.keys(detail || {}).join(', ').slice(0, 200) + ')' : ''}`);
            for (const c of components) {
                console.log(`      · ${c.sku} ×${c.qty} (${c.item_name})`);
            }
        } catch (e) {
            console.error(`  ✗ ${bundleVariant.item_code}: ${e.message}`);
        }
    }

    fs.writeFileSync('jubelio-bundle-composition.json', JSON.stringify(compositions, null, 2));
    console.log(`\n💾 Saved to jubelio-bundle-composition.json (${(fs.statSync('jubelio-bundle-composition.json').size / 1024).toFixed(1)} KB)`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
