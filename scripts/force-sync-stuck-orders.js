// Force-sync orders that webhook fired BEFORE the new payment-signal gate
// deployed (commit bcf0caf, 2026-04-29 09:48 WIB), so they got skipped under
// the old SHIPPED/COMPLETED-only gate even though they had payment_date set.
//
// Strategy: pull the latest webhook payload from JubelioPayloadLog for each
// target SO, then call upsertQboInvoice + markQboInvoicePaid (since is_paid
// is verified true in Jubelio for all targets).
//
// Usage:
//   node scripts/force-sync-stuck-orders.js          # dry-run
//   node scripts/force-sync-stuck-orders.js --apply  # apply

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const webhook = require('../routes/jubelioWebhook');

const apply = process.argv.includes('--apply');

const TARGETS = [
    { name: 'Rika Handayani', sn: 'TT-583723198772971284-128883' },
    { name: 'Jumi Hermawan',  sn: 'TP-583723447859578139-128884' },
    { name: 'Linda Wati',     sn: 'TP-583724404254345152-128884' },
    { name: 'Jessica',        sn: 'TP-583724559724611293-128884' },
    { name: 'Ayu',            sn: 'TP-583724730439599589-128884' },
    { name: 'Sonta',          sn: 'TP-583727120659285310-128884' },
    { name: 'Ie Hue Chen',    sn: 'TP-583728509226681614-128884' },
];

const fmt = (n) => `Rp ${(n || 0).toLocaleString('id-ID')}`;

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    const realmId = qbo.realmId;

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const auditFile = `force-sync-stuck-${ts}.jsonl`;
    const audit = (e) => fs.appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');

    console.log(`\nFORCE-SYNC  ${TARGETS.length} stuck orders  mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
    console.log(`audit: ${auditFile}\n`);

    const stats = { ok: 0, applied: 0, skipped: 0, errors: 0, paymentCreated: 0 };

    for (const t of TARGETS) {
        try {
            // 1. Idempotency check — already in QBO?
            const existing = await JubelioOrderMap.findOne({
                salesorder_no: { $regex: '^' + t.sn.replace(/-\d+$/, '') },
                qbo_realm_id: String(realmId),
            }).lean();
            if (existing && existing.qbo_invoice_id) {
                console.log(`━━━ ${t.name.padEnd(20)} ${t.sn}`);
                console.log(`    SKIP: already in QBO (invoice ${existing.qbo_invoice_id}, status ${existing.last_status})`);
                audit({ ...t, status: 'skipped_already_synced', qbo_invoice_id: existing.qbo_invoice_id });
                stats.skipped++;
                console.log();
                continue;
            }

            // 2. Pull latest payload
            const log = await JubelioPayloadLog.findOne({
                salesorder_no: { $regex: '^' + t.sn.replace(/-\d+$/, '') },
                endpoint: 'pesanan',
            }).sort({ received_at: -1 }).lean();

            if (!log || !log.payload) {
                console.log(`━━━ ${t.name.padEnd(20)} ${t.sn}`);
                console.log(`    ERROR: no payload found in log`);
                audit({ ...t, status: 'error_no_payload' });
                stats.errors++;
                console.log();
                continue;
            }

            const payload = log.payload;
            console.log(`━━━ ${t.name.padEnd(20)} ${t.sn}`);
            console.log(`    Latest webhook: ${log.received_at?.toISOString?.()}  status=${payload.status}  payment_date=${payload.payment_date}  grand_total=${fmt(payload.grand_total)}`);

            const wantsPayment = !!(payload.payment_date && String(payload.payment_date).trim());

            audit({ ...t, action: 'plan', dryRun: !apply, status: payload.status, payment_date: payload.payment_date, grand_total: payload.grand_total, wantsPayment });

            if (!apply) {
                console.log(`    PLAN: upsertQboInvoice → create invoice + ${wantsPayment ? 'create Payment (is_paid=true)' : 'no Payment (no payment_date)'}`);
                stats.ok++;
                console.log();
                continue;
            }

            // 3. Apply
            const upserted = await webhook.upsertQboInvoice(qbo, payload, realmId);
            console.log(`    ✓ Invoice ${upserted.action}: id=${upserted.invoice.Id} doc=${upserted.invoice.DocNumber || '-'} total=${fmt(upserted.invoice.TotalAmt)} balance=${fmt(upserted.invoice.Balance)}`);

            let payment = null;
            if (wantsPayment && upserted.action !== 'skipped') {
                payment = await webhook.markQboInvoicePaid(qbo, upserted.invoice, upserted.customerId, payload);
                if (payment) {
                    console.log(`    ✓ Payment ${payment.Id} created amount=${fmt(payment.TotalAmt)}`);
                    stats.paymentCreated++;
                }
            }

            audit({ ...t, status: 'applied', invoice_id: upserted.invoice.Id, doc_number: upserted.invoice.DocNumber, action: upserted.action, payment_id: payment?.Id, payment_amount: payment?.TotalAmt });
            stats.applied++;
            console.log();
        } catch (e) {
            console.error(`    ERROR  ${t.name}: ${e.message.slice(0, 400)}`);
            audit({ ...t, status: 'error', error: e.message });
            stats.errors++;
            console.log();
        }
    }

    console.log(`SUMMARY  ok=${stats.ok}  applied=${stats.applied}  skipped=${stats.skipped}  errors=${stats.errors}  paymentCreated=${stats.paymentCreated}`);
    console.log(`audit: ${auditFile}`);
    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
