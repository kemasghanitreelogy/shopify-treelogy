// One-time backfill: walk every JubelioOrderMap entry, derive the canonical
// invoice date from Jubelio's payment_date (preferred) or transaction_date,
// and update both the QBO Invoice TxnDate and the JubelioOrderMap audit
// fields. Lets historical invoices use the same payment_date semantics as
// new webhooks after the policy change.
//
// Source priority for raw payment_date value, in order:
//   1. JubelioOrderMap.last_payment_date_raw (already stored, post-fix)
//   2. JubelioPayloadLog.payload.payment_date (most recent webhook for the SO)
//   3. Live Jubelio API GET /sales/orders/{id} (when log entry expired by TTL)
//
// Dry-run by default. Apply=1 writes both QBO and Mongo.

const JubelioOrderMap = require('../models/JubelioOrderMap');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const jubelio = require('./jubelioApiService');

const TZ_OFFSET_MS = (Number(process.env.JUBELIO_TZ_OFFSET_HOURS) || 8) * 60 * 60 * 1000;
const isoDateJubelio = (raw) => {
    if (!raw) return null;
    const d = new Date(String(raw).trim());
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() + TZ_OFFSET_MS).toISOString().substring(0, 10);
};

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
        throw err;
    }
    return body;
};

const updateInvoiceDate = (qbo, invoiceId, syncToken, newDate) =>
    qboFetch(qbo, '/invoice', {
        method: 'POST',
        body: JSON.stringify({
            Id: String(invoiceId),
            SyncToken: String(syncToken),
            sparse: true,
            TxnDate: newDate,
        }),
    });

const runPaymentDateBackfill = async ({ qbo, apply = false, days = null, fetchMissing = true }) => {
    const t0 = Date.now();
    const mode = apply ? 'APPLY' : 'DRY-RUN';
    const realmId = String(qbo.realmId);
    console.log(`\n📅 Payment-date backfill (${mode}, days=${days || 'ALL'})\n`);

    const filter = { qbo_realm_id: realmId };
    if (days && Number(days) > 0) {
        filter.last_synced_at = { $gte: new Date(Date.now() - Number(days) * 86400000) };
    }
    const maps = await JubelioOrderMap.find(filter)
        .select('salesorder_id salesorder_no qbo_invoice_id last_transaction_date_raw last_payment_date_raw last_txn_date')
        .lean();
    console.log(`Scanning ${maps.length} order map entries`);

    // Pre-fetch payload log for all SOs in one query — payment_date by SO#.
    const payloadIndex = new Map(); // salesorder_no → payment_date_raw
    const txnFromLog = new Map(); // salesorder_no → transaction_date_raw (fallback)
    const soNos = maps.map(m => m.salesorder_no).filter(Boolean);
    if (soNos.length > 0) {
        const logs = await JubelioPayloadLog.find({
            salesorder_no: { $in: soNos },
            endpoint: 'pesanan',
        }).select('salesorder_no payload.payment_date payload.transaction_date received_at').lean();
        for (const l of logs) {
            const so = l.salesorder_no;
            if (!so) continue;
            const pay = l.payload?.payment_date || null;
            const txn = l.payload?.transaction_date || null;
            const existing = payloadIndex.get(so);
            // Prefer the log entry that actually has payment_date set, else newest.
            if (pay && (!existing || existing.payment !== pay)) payloadIndex.set(so, { payment: pay, txn });
            if (txn && !txnFromLog.has(so)) txnFromLog.set(so, txn);
        }
    }
    console.log(`Indexed ${payloadIndex.size} payment_dates from payload log`);

    const report = {
        apply, mode, runMs: 0,
        scanned: maps.length,
        updated: 0,
        alreadyCorrect: 0,
        noDateSource: 0,
        invoiceMissing: 0,
        errors: 0,
        sample: [],
    };

    let processed = 0;
    for (const m of maps) {
        processed++;
        try {
            // Resolve raw date — priority: map field → payload log → live API
            let raw = m.last_payment_date_raw || null;
            let source = raw ? 'map' : null;
            if (!raw) {
                const idx = payloadIndex.get(m.salesorder_no);
                if (idx?.payment) { raw = idx.payment; source = 'log'; }
            }
            if (!raw) {
                // Try transaction_date fallback (map → log)
                raw = m.last_transaction_date_raw || txnFromLog.get(m.salesorder_no) || null;
                if (raw) source = source || 'txn';
            }
            if (!raw && fetchMissing) {
                // Last resort: hit Jubelio API for the SO
                try {
                    const fullSo = await jubelio.getOrderDetail(m.salesorder_id);
                    const data = fullSo?.data || fullSo;
                    raw = data?.payment_date || data?.transaction_date || null;
                    if (raw) source = 'api';
                } catch (e) {
                    // Swallow per-item API errors
                }
            }
            if (!raw) {
                report.noDateSource++;
                continue;
            }

            const expected = isoDateJubelio(raw);
            if (!expected) {
                report.noDateSource++;
                continue;
            }

            // Fetch the QBO Invoice to compare current TxnDate
            let inv;
            try {
                const body = await qboFetch(qbo, `/invoice/${m.qbo_invoice_id}`);
                inv = body?.Invoice;
            } catch (e) {
                if (e.status === 404 || /Object Not Found|6240/i.test(e.message)) {
                    report.invoiceMissing++;
                    continue;
                }
                throw e;
            }
            if (!inv) { report.invoiceMissing++; continue; }

            if (inv.TxnDate === expected) {
                report.alreadyCorrect++;
                // Even if TxnDate is correct, refresh map fields if missing.
                if (apply && !m.last_payment_date_raw && raw && source !== 'txn') {
                    await JubelioOrderMap.updateOne(
                        { _id: m._id },
                        {
                            last_payment_date_raw: raw,
                            last_txn_date: expected,
                        }
                    );
                }
                continue;
            }

            const action = {
                so: m.salesorder_no,
                inv: m.qbo_invoice_id,
                from: inv.TxnDate,
                to: expected,
                raw,
                source,
            };

            if (apply) {
                try {
                    const updated = await updateInvoiceDate(qbo, m.qbo_invoice_id, inv.SyncToken, expected);
                    action.applied = true;
                    action.appliedTo = updated?.Invoice?.TxnDate;
                    // Refresh the map's audit fields too
                    const updatePayload = {
                        last_txn_date: expected,
                    };
                    if (raw && source !== 'txn') updatePayload.last_payment_date_raw = raw;
                    await JubelioOrderMap.updateOne({ _id: m._id }, updatePayload);
                    report.updated++;
                    console.log(`  ✅ ${m.salesorder_no} inv=${m.qbo_invoice_id}: ${inv.TxnDate} → ${expected} (src=${source})`);
                } catch (e) {
                    action.applied = false;
                    action.error = e.message?.slice(0, 300);
                    report.errors++;
                    console.log(`  ❌ ${m.salesorder_no}: ${action.error}`);
                }
            } else {
                console.log(`  📝 ${m.salesorder_no} inv=${m.qbo_invoice_id}: ${inv.TxnDate} → ${expected} (src=${source})`);
            }

            if (report.sample.length < 30) report.sample.push(action);
            if (processed % 100 === 0) console.log(`  ... ${processed}/${maps.length} processed`);
        } catch (e) {
            report.errors++;
            console.error(`  💥 ${m.salesorder_no}: ${e.message?.slice(0, 200)}`);
        }
    }

    report.runMs = Date.now() - t0;
    console.log(`\n✅ ${mode} done in ${report.runMs}ms · updated=${report.updated} alreadyCorrect=${report.alreadyCorrect} noDateSource=${report.noDateSource} invoiceMissing=${report.invoiceMissing} errors=${report.errors}`);
    return report;
};

module.exports = { runPaymentDateBackfill };
