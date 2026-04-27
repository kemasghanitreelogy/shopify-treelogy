// Backfill JubelioCustomerMap from existing JubelioPayloadLog + JubelioOrderMap
// data. Walks the payload log within the TTL window and pairs (source, buyer_id)
// with the qbo_customer_id we'd resolve via the order map → invoice → customer
// chain. Lets newly-deployed buyer_id-based lookup work for historical buyers
// without waiting for a fresh webhook per buyer.

const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const JubelioCustomerMap = require('../models/JubelioCustomerMap');

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
    if (!res.ok) {
        const err = new Error(`QBO GET ${path} (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
        err.status = res.status;
        throw err;
    }
    return body;
};

const runCustomerMapBackfill = async ({ qbo, apply = false }) => {
    const t0 = Date.now();
    const mode = apply ? 'APPLY' : 'DRY-RUN';
    const realmId = String(qbo.realmId);
    console.log(`\n🔧 Customer-map backfill (${mode})\n`);

    // 1) Mine payload log for (source, buyer_id, salesorder_no, customer_name)
    //    Only entries with non-empty buyer_id are eligible — that's the key.
    const logs = await JubelioPayloadLog.find({
        endpoint: 'pesanan',
        'payload.buyer_id': { $exists: true, $ne: null, $ne: '' },
    }).select('source_name salesorder_no payload.buyer_id payload.customer_name').lean();

    // Group by (source, buyer_id) — keep newest SO per buyer for audit fields
    const byBuyer = new Map(); // "source|buyer" → { source, buyer_id, soNos: [], jubelioName }
    for (const l of logs) {
        const source = String(l.source_name || l.payload?.source_name || '').toUpperCase().trim();
        const buyer = String(l.payload?.buyer_id || '').trim();
        if (!source || !buyer) continue;
        const key = `${source}|${buyer}`;
        const entry = byBuyer.get(key) || { source, buyer_id: buyer, soNos: [], jubelioName: null };
        entry.soNos.push(l.salesorder_no);
        if (!entry.jubelioName && l.payload?.customer_name) entry.jubelioName = l.payload.customer_name;
        byBuyer.set(key, entry);
    }
    console.log(`Mined ${byBuyer.size} unique (source, buyer_id) pairs from ${logs.length} payload logs`);

    const report = {
        apply, mode, runMs: 0,
        totalBuyers: byBuyer.size,
        backfilled: 0,
        alreadyMapped: 0,
        skippedNoSoMap: 0,
        skippedInvoiceMissing: 0,
        skippedNoCustomer: 0,
        errors: 0,
        sampleActions: [],
    };

    // Cache the qbo_customer_id per qbo_invoice_id to avoid re-fetching
    const invoiceCustomerCache = new Map();
    const fetchInvoiceCustomerId = async (invoiceId) => {
        if (invoiceCustomerCache.has(invoiceId)) return invoiceCustomerCache.get(invoiceId);
        try {
            const body = await qboFetch(qbo, `/invoice/${invoiceId}`);
            const custId = body?.Invoice?.CustomerRef?.value || null;
            const custName = body?.Invoice?.CustomerRef?.name || null;
            const result = { custId, custName };
            invoiceCustomerCache.set(invoiceId, result);
            return result;
        } catch (e) {
            invoiceCustomerCache.set(invoiceId, null);
            return null;
        }
    };

    let processed = 0;
    for (const [key, entry] of byBuyer) {
        processed++;
        // 2) Find any successfully synced order for this buyer to derive qbo_customer_id
        const orderMap = await JubelioOrderMap.findOne({
            salesorder_no: { $in: entry.soNos },
            qbo_realm_id: realmId,
        }).select('qbo_invoice_id salesorder_no').lean();

        if (!orderMap?.qbo_invoice_id) {
            report.skippedNoSoMap++;
            continue;
        }

        const invInfo = await fetchInvoiceCustomerId(orderMap.qbo_invoice_id);
        if (!invInfo) {
            report.skippedInvoiceMissing++;
            continue;
        }
        if (!invInfo.custId) {
            report.skippedNoCustomer++;
            continue;
        }

        // 3) Check if mapping already exists
        const existingMap = await JubelioCustomerMap.findOne({
            source: entry.source, buyer_id: entry.buyer_id, qbo_realm_id: realmId,
        }).lean();

        if (existingMap) {
            // Refresh audit fields if same id; if different, prefer the invoice's
            // current CustomerRef (finance may have re-merged/renamed).
            if (String(existingMap.qbo_customer_id) === String(invInfo.custId)) {
                report.alreadyMapped++;
                continue;
            }
        }

        const action = {
            source: entry.source,
            buyer_id: entry.buyer_id,
            qbo_customer_id: invInfo.custId,
            qbo_customer_name: invInfo.custName,
            via_so: orderMap.salesorder_no,
            jubelio_name: entry.jubelioName,
            existing_qbo_customer_id: existingMap?.qbo_customer_id,
        };

        if (apply) {
            try {
                await JubelioCustomerMap.findOneAndUpdate(
                    { source: entry.source, buyer_id: entry.buyer_id, qbo_realm_id: realmId },
                    {
                        qbo_customer_id: String(invInfo.custId),
                        last_seen_at: new Date(),
                        last_so_no: orderMap.salesorder_no,
                        last_customer_name_jubelio: entry.jubelioName,
                        last_customer_name_qbo: invInfo.custName,
                    },
                    { upsert: true }
                );
                report.backfilled++;
                action.applied = true;
            } catch (e) {
                report.errors++;
                action.error = e.message;
            }
        } else {
            report.backfilled++;
        }

        if (report.sampleActions.length < 20) report.sampleActions.push(action);

        if (processed % 50 === 0) console.log(`  ... ${processed}/${byBuyer.size} processed`);
    }

    report.runMs = Date.now() - t0;
    console.log(`\n✅ ${mode} done in ${report.runMs}ms · backfilled=${report.backfilled} alreadyMapped=${report.alreadyMapped} skippedNoSoMap=${report.skippedNoSoMap} errors=${report.errors}`);
    return report;
};

module.exports = { runCustomerMapBackfill };
