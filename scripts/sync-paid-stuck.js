// Find paid Jubelio orders (date range) NOT yet in QBO + force-sync them.
//
// Source of truth = Jubelio API (/sales/orders/).
// Paid signal      = payment_date is set (= buyer paid escrow).
// QBO-side check   = JubelioOrderMap.salesorder_id (authoritative cross-ref,
//                    avoids the salesorder_no -store_id suffix mismatch).
//
// Usage:
//   node scripts/sync-paid-stuck.js                          # dry-run, dates 2026-04-27,2026-04-28
//   node scripts/sync-paid-stuck.js --dates=2026-04-27,2026-04-28 --apply
//   node scripts/sync-paid-stuck.js --dates=2026-04-29

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const jubelioApi = require('../services/jubelioApiService');
const webhook = require('../routes/jubelioWebhook');

const apply = process.argv.includes('--apply');
const datesArg = (process.argv.find(a => a.startsWith('--dates=')) || '--dates=2026-04-27,2026-04-28').split('=')[1];
const TARGET_DAYS = new Set(datesArg.split(',').map(s => s.trim()).filter(Boolean));

const JKT_OFFSET_MS = (Number(process.env.JUBELIO_TZ_OFFSET_HOURS) || 8) * 60 * 60 * 1000;
const jktDay = (raw) => {
    if (!raw) return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() + JKT_OFFSET_MS).toISOString().substring(0, 10);
};
const fmt = (n) => `Rp ${(n || 0).toLocaleString('id-ID')}`;

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    const realmId = qbo.realmId;

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const auditFile = `sync-paid-stuck-${ts}.jsonl`;
    const audit = (e) => fs.appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');

    console.log(`\nSYNC-PAID-STUCK  dates=[${[...TARGET_DAYS].join(',')}]  mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
    console.log(`audit: ${auditFile}\n`);

    // 1. Pull Jubelio orders (sort by transaction_date desc, stop when older than min target date)
    const minDate = [...TARGET_DAYS].sort()[0];
    const oneDayBefore = new Date(new Date(minDate + 'T00:00:00.000Z').getTime() - 86400000).toISOString().substring(0, 10);
    console.log(`Pulling /sales/orders/ until txn < ${oneDayBefore}...`);

    const all = await jubelioApi.apiGetPaged('/sales/orders/', { sortBy: 'transaction_date', sortDirection: 'desc' }, {
        pageSize: 100,
        maxPages: 30,
        until: (item) => {
            const d = jktDay(item?.transaction_date);
            return d && d < oneDayBefore;
        }
    });
    console.log(`Pulled ${all.length} orders`);

    // 2. Filter to target dates + paid
    // /sales/orders/ listing returns `is_paid` (not payment_date — that's only
    // in getOrderDetail). is_paid:true means buyer has paid (escrow funded).
    const onTarget = all.filter(o => TARGET_DAYS.has(jktDay(o.transaction_date)));
    const paid = onTarget.filter(o => o.is_paid === true && !o.is_canceled);
    console.log(`On target dates: ${onTarget.length} · is_paid=true: ${paid.length}\n`);

    // 3. Cross-ref vs JubelioOrderMap by salesorder_id
    const allMaps = await JubelioOrderMap.find({ qbo_realm_id: String(realmId) })
        .select('salesorder_id qbo_invoice_id last_status').lean();
    const mapBySoId = new Map(allMaps.map(m => [m.salesorder_id, m]));

    const stuck = paid.filter(o => !mapBySoId.has(o.salesorder_id));
    const synced = paid.filter(o => mapBySoId.has(o.salesorder_id));

    console.log(`MATCH:`);
    console.log(`  Paid orders                      ${paid.length}`);
    console.log(`  Already in QBO map               ${synced.length}`);
    console.log(`  STUCK (paid, not in QBO)         ${stuck.length}\n`);

    if (stuck.length === 0) {
        console.log(`No stuck orders. Nothing to sync.`);
        await mongoose.disconnect();
        return;
    }

    console.log(`Stuck orders to sync:`);
    for (const o of stuck) {
        console.log(`  ${o.salesorder_no.padEnd(35)} id=${String(o.salesorder_id).padStart(5)} txn=${jktDay(o.transaction_date)} pay=${jktDay(o.payment_date)} grand_total=${fmt(o.grand_total)}`);
    }
    console.log();

    audit({ phase: 'discover', dryRun: !apply, paid_count: paid.length, synced_count: synced.length, stuck_count: stuck.length, stuck_ids: stuck.map(o => o.salesorder_id) });

    if (!apply) {
        console.log(`DRY-RUN — no changes. Re-run with --apply to sync.`);
        await mongoose.disconnect();
        return;
    }

    // 4. Apply: pull payload from log + upsert + payment
    const stats = { applied: 0, errors: 0, paymentCreated: 0, noPayload: 0 };
    for (const o of stuck) {
        try {
            const log = await JubelioPayloadLog.findOne({
                salesorder_id: o.salesorder_id,
                endpoint: 'pesanan',
            }).sort({ received_at: -1 }).lean();

            if (!log || !log.payload) {
                console.log(`━━━ ${o.salesorder_no} (id ${o.salesorder_id}): NO payload in log → fetch from API + reconstruct`);
                // Fallback: fetch from API directly (the listing data is already a full SO record)
                // Use `o` as the payload — Jubelio listing returns same shape as webhook
                try {
                    const detail = await jubelioApi.getOrderDetail(o.salesorder_id);
                    const detailSo = detail?.data || detail;
                    const upserted = await webhook.upsertQboInvoice(qbo, detailSo, realmId);
                    console.log(`    ✓ Invoice ${upserted.action}: id=${upserted.invoice.Id} doc=${upserted.invoice.DocNumber || '-'} total=${fmt(upserted.invoice.TotalAmt)}`);
                    let payment = null;
                    if (upserted.action !== 'skipped' && detailSo.payment_date) {
                        payment = await webhook.markQboInvoicePaid(qbo, upserted.invoice, upserted.customerId, detailSo);
                        if (payment) { console.log(`    ✓ Payment ${payment.Id} amount=${fmt(payment.TotalAmt)}`); stats.paymentCreated++; }
                    }
                    audit({ salesorder_no: o.salesorder_no, salesorder_id: o.salesorder_id, source: 'api', status: 'applied', invoice_id: upserted.invoice.Id, payment_id: payment?.Id });
                    stats.applied++;
                } catch (e) {
                    console.error(`    ERROR (api fallback): ${e.message.slice(0, 300)}`);
                    audit({ salesorder_no: o.salesorder_no, salesorder_id: o.salesorder_id, status: 'error_api_fallback', error: e.message });
                    stats.errors++;
                }
                continue;
            }

            const payload = log.payload;
            console.log(`━━━ ${o.salesorder_no} (id ${o.salesorder_id})  log_status=${log.status} payment_date=${payload.payment_date}`);
            const upserted = await webhook.upsertQboInvoice(qbo, payload, realmId);
            console.log(`    ✓ Invoice ${upserted.action}: id=${upserted.invoice.Id} doc=${upserted.invoice.DocNumber || '-'} total=${fmt(upserted.invoice.TotalAmt)}`);

            let payment = null;
            const wantsPayment = !!(payload.payment_date && String(payload.payment_date).trim());
            if (upserted.action !== 'skipped' && wantsPayment) {
                payment = await webhook.markQboInvoicePaid(qbo, upserted.invoice, upserted.customerId, payload);
                if (payment) { console.log(`    ✓ Payment ${payment.Id} amount=${fmt(payment.TotalAmt)}`); stats.paymentCreated++; }
            }

            audit({ salesorder_no: o.salesorder_no, salesorder_id: o.salesorder_id, source: 'log', status: 'applied', invoice_id: upserted.invoice.Id, payment_id: payment?.Id, payment_amount: payment?.TotalAmt });
            stats.applied++;
        } catch (e) {
            console.error(`    ERROR: ${e.message.slice(0, 400)}`);
            audit({ salesorder_no: o.salesorder_no, salesorder_id: o.salesorder_id, status: 'error', error: e.message });
            stats.errors++;
        }
    }

    console.log(`\nSUMMARY  applied=${stats.applied}  paymentCreated=${stats.paymentCreated}  errors=${stats.errors}  noPayload=${stats.noPayload}`);
    console.log(`audit: ${auditFile}`);
    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
