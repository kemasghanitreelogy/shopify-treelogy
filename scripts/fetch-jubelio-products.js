// Fetch ALL products from Jubelio (/inventory/items/) and save to JSON.
// Read-only.
//
// Usage:
//   node scripts/fetch-jubelio-products.js                  # default → jubelio-products.json
//   node scripts/fetch-jubelio-products.js --out=path.json
//   node scripts/fetch-jubelio-products.js --include-archived

require('dotenv').config();
const fs = require('fs');
const { apiGetPaged } = require('../services/jubelioApiService');

const args = process.argv.slice(2);
const arg = (k, def) => {
    const hit = args.find(a => a.startsWith(`--${k}=`));
    return hit ? hit.split('=')[1] : def;
};
const outPath = arg('out', 'jubelio-products.json');
const includeArchived = args.includes('--include-archived');

(async () => {
    console.log('🔌 Fetching Jubelio /inventory/items/ (Satuan) ...');
    const active = await apiGetPaged('/inventory/items/', {}, { pageSize: 100, maxPages: 200 });
    console.log(`  → ${active.length} active single-item groups`);

    console.log('🔌 Fetching Jubelio /inventory/item-bundles/ (Bundle) ...');
    let bundles = [];
    try {
        bundles = await apiGetPaged('/inventory/item-bundles/', {}, { pageSize: 100, maxPages: 200 });
        console.log(`  → ${bundles.length} active bundles`);
    } catch (e) {
        console.warn(`  ⚠️ bundles fetch failed: ${e.message}`);
    }

    let archived = [];
    if (includeArchived) {
        try {
            archived = await apiGetPaged('/inventory/items/archived/', {}, { pageSize: 100, maxPages: 200 });
            console.log(`  → ${archived.length} archived items`);
        } catch (e) {
            console.warn(`  ⚠️ archived fetch failed: ${e.message}`);
        }
    }

    const out = {
        fetchedAt: new Date().toISOString(),
        activeCount: active.length,
        bundleCount: bundles.length,
        archivedCount: archived.length,
        active,
        bundles,
        archived,
    };
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`💾 Saved to ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);

    // Print sample so we know the shape
    if (active.length > 0) {
        const sample = active[0];
        console.log('\n📋 Sample item keys:', Object.keys(sample).join(', '));
        console.log('📋 Sample preview:', JSON.stringify({
            item_code: sample.item_code,
            item_name: sample.item_name,
            item_id: sample.item_id,
            item_group_id: sample.item_group_id,
            sell_price: sample.sell_price,
            price: sample.price,
            is_active: sample.is_active,
            archived: sample.archived,
            item_type: sample.item_type,
        }, null, 2));
    }
})().catch(e => {
    console.error('❌', e.message);
    process.exit(1);
});
