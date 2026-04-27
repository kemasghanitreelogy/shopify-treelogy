// For each QBO Customer that we know belongs to a single channel (via
// JubelioCustomerMap), and whose DisplayName has no channel prefix yet,
// rename to "{PREFIX} - {currentName}". Existing prefixed names are left
// untouched. Cross-channel customers are skipped (we can't pick one).
//
// Channel sources → prefix:
//   TOKOPEDIA / SHOP | TOKOPEDIA → TP
//   SHOPEE                       → SP
//   SHOPIFY                      → SHF
//
// Source mapping is derived from the JubelioCustomerMap entries we just
// backfilled, so the prefix matches the actual channel that buyer used.

const JubelioCustomerMap = require('../models/JubelioCustomerMap');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');

// Direct source-name mapping. Several Tokopedia variants exist; treat all as TP.
const SOURCE_TO_PREFIX = {
    'TOKOPEDIA': 'TP',
    'SHOP | TOKOPEDIA': 'TP',
    'SHOPEE': 'SP',
    'SHOPIFY': 'SHF',
};

// Channel codes carried in the salesorder_no (highest authority — INTERNAL
// source covers multiple channels distinguishable only by SO# prefix).
//   SP — Shopee · TP, TT — Tokopedia · SHF — Shopify
//   LB — La Brisa · CS — Consignment
//   DP — WhatsApp / Direct sales · DW — Walk-in
const KNOWN_SO_PREFIXES = new Set(['SP', 'TP', 'TT', 'SHF', 'LB', 'CS', 'DP', 'DW']);

// Treat alternates (TT) as TP per business spec — TT is just a Tokopedia
// shop-store flavor in Jubelio's source_name vocabulary.
const PREFIX_CANONICAL = { TT: 'TP' };

const getSoPrefix = (soNo) => {
    const m = String(soNo || '').match(/^([A-Z]{2,5})-/);
    return m ? m[1] : null;
};
const canonicalPrefix = (p) => PREFIX_CANONICAL[p] || p;

// Already-prefixed if name starts with 1-5 uppercase letters then "-" or " - ".
const HAS_PREFIX_RE = /^\s*[A-Z]{2,5}\s*-/;

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

const runCustomerPrefixMigration = async ({ qbo, apply = false }) => {
    const t0 = Date.now();
    const mode = apply ? 'APPLY' : 'DRY-RUN';
    const realmId = String(qbo.realmId);
    console.log(`\n🏷️  Customer channel prefix migration (${mode})\n`);

    // 1) Group map entries by qbo_customer_id, collecting both source_name(s)
    //    and SO# prefix(es) so INTERNAL source customers can still be assigned
    //    a channel prefix from the salesorder_no.
    const maps = await JubelioCustomerMap.find({ qbo_realm_id: realmId }).lean();
    const customerData = new Map(); // qbo_customer_id → { sources: Set, soPrefixes: Set, sampleSos: [] }
    for (const m of maps) {
        const id = String(m.qbo_customer_id);
        if (!customerData.has(id)) {
            customerData.set(id, { sources: new Set(), soPrefixes: new Set(), sampleSos: [] });
        }
        const d = customerData.get(id);
        d.sources.add(m.source);
        const p = canonicalPrefix(getSoPrefix(m.last_so_no));
        if (p && KNOWN_SO_PREFIXES.has(p)) d.soPrefixes.add(p);
        if (m.last_so_no && d.sampleSos.length < 3) d.sampleSos.push(m.last_so_no);
    }
    console.log(`Distinct customers with buyer_id mapping: ${customerData.size}`);

    // 2) Augment with SO# scan from JubelioPayloadLog for customers whose
    //    JubelioCustomerMap source isn't in SOURCE_TO_PREFIX (e.g. INTERNAL).
    //    We pull every salesorder_no associated with that buyer to detect
    //    multi-channel within INTERNAL (LB+DP+DW etc.) which we'll treat as
    //    ambiguous and skip.
    const buyersToScan = [];
    for (const [id, d] of customerData) {
        for (const src of d.sources) {
            if (!SOURCE_TO_PREFIX[src] && d.soPrefixes.size === 0) {
                // Fetch all SO#s for this buyer from payload log
                buyersToScan.push({ customerId: id, source: src });
            }
        }
    }
    if (buyersToScan.length > 0) {
        // Get buyer_ids for these customer ids
        const buyersByCustomer = new Map();
        for (const m of maps) {
            const id = String(m.qbo_customer_id);
            if (!buyersByCustomer.has(id)) buyersByCustomer.set(id, []);
            buyersByCustomer.get(id).push({ source: m.source, buyer_id: m.buyer_id });
        }
        for (const { customerId } of buyersToScan) {
            const buyers = buyersByCustomer.get(customerId) || [];
            const orQ = buyers.map(b => ({ source_name: b.source, 'payload.buyer_id': b.buyer_id }));
            if (orQ.length === 0) continue;
            const logs = await JubelioPayloadLog.find({ $or: orQ }).select('salesorder_no').lean();
            const d = customerData.get(customerId);
            for (const l of logs) {
                const p = canonicalPrefix(getSoPrefix(l.salesorder_no));
                if (p && KNOWN_SO_PREFIXES.has(p)) d.soPrefixes.add(p);
                if (d.sampleSos.length < 3) d.sampleSos.push(l.salesorder_no);
            }
        }
    }

    const report = {
        apply, mode, runMs: 0,
        totalMappedCustomers: customerData.size,
        renamed: [],
        skippedAlreadyPrefixed: 0,
        skippedAmbiguous: [],   // multi-channel within one customer
        skippedNoPrefix: [],    // could not determine a known prefix
        skippedDuplicate: [],
        skippedCustomerMissing: 0,
        errors: [],
    };

    let processed = 0;
    for (const [customerId, d] of customerData) {
        processed++;

        // Resolve the channel prefix:
        //  1) source_name → SOURCE_TO_PREFIX (TOKOPEDIA/SHOPEE/SHOPIFY)
        //  2) SO# prefix from last_so_no (covers INTERNAL → LB/CS/DP/DW)
        const sourcePrefixes = new Set();
        for (const src of d.sources) {
            if (SOURCE_TO_PREFIX[src]) sourcePrefixes.add(SOURCE_TO_PREFIX[src]);
        }
        const allPrefixes = new Set([...sourcePrefixes, ...d.soPrefixes]);

        if (allPrefixes.size > 1) {
            report.skippedAmbiguous.push({
                customerId,
                sources: [...d.sources],
                prefixes: [...allPrefixes],
                sampleSos: d.sampleSos,
            });
            continue;
        }
        if (allPrefixes.size === 0) {
            report.skippedNoPrefix.push({
                customerId,
                sources: [...d.sources],
                sampleSos: d.sampleSos,
            });
            continue;
        }
        const prefix = [...allPrefixes][0];

        // Fetch current DisplayName + SyncToken
        let customer;
        try {
            const body = await qboFetch(qbo, `/customer/${customerId}`);
            customer = body?.Customer;
        } catch (e) {
            // 404 → customer was deleted/merged
            if (e.status === 404 || /Object Not Found/i.test(e.message)) {
                report.skippedCustomerMissing++;
                continue;
            }
            report.errors.push({ customerId, error: e.message?.slice(0, 200) });
            continue;
        }
        if (!customer) {
            report.skippedCustomerMissing++;
            continue;
        }
        if (customer.Active === false) {
            // Inactive customer — leave alone
            continue;
        }

        const currentName = String(customer.DisplayName || '').trim();
        if (HAS_PREFIX_RE.test(currentName)) {
            report.skippedAlreadyPrefixed++;
            continue;
        }

        const newName = `${prefix} - ${currentName}`.substring(0, 100);
        const action = {
            customerId,
            currentName,
            newName,
            prefix,
            sources: [...d.sources],
            sampleSos: d.sampleSos,
        };

        if (apply) {
            try {
                await qboFetch(qbo, '/customer', {
                    method: 'POST',
                    body: JSON.stringify({
                        Id: customer.Id,
                        SyncToken: customer.SyncToken,
                        sparse: true,
                        DisplayName: newName,
                    }),
                });
                action.applied = true;
                report.renamed.push(action);
                console.log(`  ✅ ${customerId}: "${currentName}" → "${newName}"`);
            } catch (e) {
                const detail = JSON.stringify(e.body || {}).slice(0, 400);
                if (/Duplicate Name Exists/i.test(detail) || /Another customer/i.test(detail)) {
                    // Target name already taken (likely the canonical record exists separately)
                    report.skippedDuplicate.push({ customerId, currentName, newName, detail: detail.slice(0, 200) });
                    console.log(`  ⏭  ${customerId} "${currentName}" → "${newName}" already taken; left as-is`);
                } else {
                    report.errors.push({ customerId, currentName, newName, error: e.message?.slice(0, 300) });
                    console.log(`  ❌ ${customerId}: ${e.message?.slice(0, 200)}`);
                }
            }
        } else {
            report.renamed.push(action);
            console.log(`  📝 Would rename ${customerId}: "${currentName}" → "${newName}"`);
        }

        if (processed % 50 === 0) console.log(`  ... ${processed}/${customerData.size} processed`);
    }

    report.runMs = Date.now() - t0;
    console.log(`\n✅ ${mode} done in ${report.runMs}ms · renamed=${report.renamed.length} alreadyPrefixed=${report.skippedAlreadyPrefixed} duplicate=${report.skippedDuplicate.length} ambiguous=${report.skippedAmbiguous.length} noPrefix=${report.skippedNoPrefix.length} errors=${report.errors.length}`);
    return report;
};

module.exports = { runCustomerPrefixMigration };
