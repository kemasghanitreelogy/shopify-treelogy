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

const SOURCE_TO_PREFIX = {
    'TOKOPEDIA': 'TP',
    'SHOP | TOKOPEDIA': 'TP',
    'SHOPEE': 'SP',
    'SHOPIFY': 'SHF',
};

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

    // 1) Group map entries by qbo_customer_id → set of sources
    const maps = await JubelioCustomerMap.find({ qbo_realm_id: realmId }).lean();
    const sourcesByCustomer = new Map();
    const lastSeenByCustomer = new Map();
    for (const m of maps) {
        const id = String(m.qbo_customer_id);
        if (!sourcesByCustomer.has(id)) sourcesByCustomer.set(id, new Set());
        sourcesByCustomer.get(id).add(m.source);
        const prev = lastSeenByCustomer.get(id);
        if (!prev || (m.last_seen_at && m.last_seen_at > prev)) {
            lastSeenByCustomer.set(id, m.last_seen_at);
        }
    }
    console.log(`Distinct customers with buyer_id mapping: ${sourcesByCustomer.size}`);

    const report = {
        apply, mode, runMs: 0,
        totalMappedCustomers: sourcesByCustomer.size,
        renamed: [],
        skippedAlreadyPrefixed: 0,
        skippedMultiSource: [],
        skippedUnknownSource: [],
        skippedDuplicate: [],
        skippedCustomerMissing: 0,
        errors: [],
    };

    let processed = 0;
    for (const [customerId, sources] of sourcesByCustomer) {
        processed++;

        // Multi-source customer → ambiguous prefix; skip.
        if (sources.size > 1) {
            report.skippedMultiSource.push({ customerId, sources: [...sources] });
            continue;
        }
        const source = [...sources][0];
        const prefix = SOURCE_TO_PREFIX[source];
        if (!prefix) {
            report.skippedUnknownSource.push({ customerId, source });
            continue;
        }

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
            source,
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

        if (processed % 50 === 0) console.log(`  ... ${processed}/${sourcesByCustomer.size} processed`);
    }

    report.runMs = Date.now() - t0;
    console.log(`\n✅ ${mode} done in ${report.runMs}ms · renamed=${report.renamed.length} alreadyPrefixed=${report.skippedAlreadyPrefixed} duplicate=${report.skippedDuplicate.length} multiSource=${report.skippedMultiSource.length} errors=${report.errors.length}`);
    return report;
};

module.exports = { runCustomerPrefixMigration };
