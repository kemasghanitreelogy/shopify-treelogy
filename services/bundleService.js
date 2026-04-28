// Canonical Jubelio bundle compositions for QBO invoice expansion.
//
// QBO Indonesia doesn't support Bundle (Type=Group) creation via API V3, so
// the 6 bundle items were created manually in the QBO UI. The integration
// READS canonical Inventory components by SKU and emits per-component lines
// (instead of a single GroupLineDetail) on the invoice — this avoids the
// "discount > subtotal" validation race that GroupLineDetail triggers when
// QBO hasn't yet expanded the line at validation time.
//
// Component prices are the published Jubelio canonical sell_price (UnitPrice
// per Inventory item in QBO). When the marketplace channel applies a discount
// (e.g. Tokopedia/Shopee promo) the difference between componentSum and the
// actual paid line amount becomes a DiscountLineDetail row.
//
// Update procedure when Jubelio changes a bundle:
//   1. Update the relevant CANONICAL_BUNDLES entry below.
//   2. Bump prices/qty/sku as needed.
//   3. Deploy.
//
// (We chose hardcode over Mongo cache because: bundle composition changes are
// extremely rare; finance team can't cause a runtime cache miss; one source of
// truth in the diff for review.)

const CANONICAL_BUNDLES = {
    'MRS-002': {
        name: 'TREELOGY Moringa Ritual Set + Powder 45gr (Ritual Starter Bundle)',
        components: [
            { sku: 'MRS-001',     qty: 1, unitPrice: 1090000 },
            { sku: 'OMP-45-001',  qty: 1, unitPrice:  320000 },
        ],
    },
    'MRS-003': {
        name: 'TREELOGY Moringa Ritual Set + Powder 90gr (Daily Wellness Bundle)',
        components: [
            { sku: 'MRS-001',     qty: 1, unitPrice: 1090000 },
            { sku: 'OMP-90-001',  qty: 1, unitPrice:  540000 },
        ],
    },
    'MRS-004': {
        name: 'TREELOGY Moringa Ritual Set + Powder 180gr (The Complete Ritual Bundle)',
        components: [
            { sku: 'MRS-001',     qty: 1, unitPrice: 1090000 },
            { sku: 'OMP-180-001', qty: 1, unitPrice:  990000 },
        ],
    },
    'Discovery-Pack': {
        name: 'Treelogy The Discovery Pack',
        components: [
            { sku: 'OMP-45-001',  qty: 1, unitPrice: 320000 },
            { sku: 'OMO-30-001',  qty: 1, unitPrice: 470000 },
            { sku: 'OMC-90-001',  qty: 1, unitPrice: 390000 },
        ],
    },
    'Inside-Out-Protocol': {
        name: 'Inside Out Moringa Protocol (Capsule 90 + Oil 30ml)',
        components: [
            { sku: 'OMC-90-001',  qty: 1, unitPrice: 390000 },
            { sku: 'OMO-30-001',  qty: 1, unitPrice: 470000 },
        ],
    },
    'The-Movement-&-Relief': {
        name: 'TREELOGY The Movement & Relief',
        components: [
            { sku: 'OMC-180-001', qty: 1, unitPrice: 690000 },
            { sku: 'OMO-60-001',  qty: 1, unitPrice: 790000 },
        ],
    },
};

const isBundleSku = (sku) => Object.prototype.hasOwnProperty.call(CANONICAL_BUNDLES, String(sku || '').trim());
const getBundleComposition = (sku) => CANONICAL_BUNDLES[String(sku || '').trim()] || null;

// Bundle expansion is disabled by default; flip BUNDLE_AWARE=true in env to
// enable on prod. Lets us land the code first, observe a controlled rollout.
const isBundleAwareEnabled = () => String(process.env.BUNDLE_AWARE || '').toLowerCase() === 'true';

module.exports = {
    CANONICAL_BUNDLES,
    isBundleSku,
    getBundleComposition,
    isBundleAwareEnabled,
};
