// Force-sync the 2 orders that failed at 13:49 + 15:17 WIB on 2026-04-29 due
// to "Duplicate Name Exists" without Id (fixed in commit 97527b7).

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const webhook = require('../routes/jubelioWebhook');

const apply = process.argv.includes('--apply');

const TARGETS = [
    { sn: 'TP-583757280798803753-128884', salesorder_id: 1160 },
    { sn: 'SP-2604294BGTY3R7',            salesorder_id: 1169 },
];

const fmt = (n) => `Rp ${(n || 0).toLocaleString('id-ID')}`;

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    const realmId = qbo.realmId;

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const auditFile = `force-sync-2-failed-${ts}.jsonl`;
    const audit = (e) => fs.appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');

    console.log(`\nFORCE-SYNC 2 failed  mode=${apply ? 'APPLY' : 'DRY-RUN'}\n`);

    for (const t of TARGETS) {
        try {
            const existing = await JubelioOrderMap.findOne({
                salesorder_id: t.salesorder_id,
                qbo_realm_id: String(realmId),
            }).lean();
            if (existing) {
                // Invoice exists but may need Payment (sync happened during INVOICED/PROCESSING
                // status, which doesn't trigger PAID_STATUSES → no auto-Payment).
                const baseUrl = `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
                const r = await fetch(`${baseUrl}/invoice/${existing.qbo_invoice_id}?minorversion=65`, {
                    headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' },
                });
                const inv = (await r.json())?.Invoice;
                if (inv && Number(inv.Balance || 0) > 0) {
                    const log = await JubelioPayloadLog.findOne({ salesorder_id: t.salesorder_id, endpoint: 'pesanan' }).sort({ received_at: -1 }).lean();
                    const so = log?.payload || {};
                    if (so.payment_date) {
                        console.log(`━━━ ${t.sn}  invoice ${inv.Id} balance=${fmt(inv.Balance)} — creating missing Payment`);
                        if (apply) {
                            const payment = await webhook.markQboInvoicePaid(qbo, inv, inv.CustomerRef?.value, so);
                            if (payment) console.log(`    ✓ Payment ${payment.Id} amount=${fmt(payment.TotalAmt)}`);
                            audit({ ...t, status: 'payment_added', invoice_id: inv.Id, payment_id: payment?.Id });
                        } else {
                            console.log(`    PLAN: markQboInvoicePaid (TxnDate=${so.payment_date})`);
                        }
                    } else {
                        console.log(`━━━ ${t.sn}  invoice ${inv.Id} balance=${fmt(inv.Balance)} — no payment_date in payload, skip`);
                    }
                } else {
                    console.log(`━━━ ${t.sn}  SKIP: already in QBO (inv ${existing.qbo_invoice_id}, balance 0)`);
                    audit({ ...t, status: 'skipped_already_synced', qbo_invoice_id: existing.qbo_invoice_id });
                }
                console.log();
                continue;
            }

            const log = await JubelioPayloadLog.findOne({
                salesorder_id: t.salesorder_id,
                endpoint: 'pesanan',
            }).sort({ received_at: -1 }).lean();
            if (!log?.payload) {
                console.log(`━━━ ${t.sn}  ERROR: no payload in log`);
                audit({ ...t, status: 'error_no_payload' });
                console.log();
                continue;
            }
            const payload = log.payload;
            console.log(`━━━ ${t.sn}  log_status=${log.status}  customer="${payload.customer_name}"  grand_total=${fmt(payload.grand_total)}`);

            if (!apply) {
                console.log(`    PLAN: upsertQboInvoice + markQboInvoicePaid (if payment_date)`);
                audit({ ...t, action: 'plan' });
                console.log();
                continue;
            }

            const upserted = await webhook.upsertQboInvoice(qbo, payload, realmId);
            console.log(`    ✓ Invoice ${upserted.action}: id=${upserted.invoice.Id} doc=${upserted.invoice.DocNumber} total=${fmt(upserted.invoice.TotalAmt)}`);

            let payment = null;
            if (upserted.action !== 'skipped' && payload.payment_date) {
                payment = await webhook.markQboInvoicePaid(qbo, upserted.invoice, upserted.customerId, payload);
                if (payment) console.log(`    ✓ Payment ${payment.Id} amount=${fmt(payment.TotalAmt)}`);
            }

            audit({ ...t, status: 'applied', invoice_id: upserted.invoice.Id, payment_id: payment?.Id });
        } catch (e) {
            console.error(`    ERROR ${t.sn}: ${e.message.slice(0, 400)}`);
            audit({ ...t, status: 'error', error: e.message });
        }
        console.log();
    }
    console.log(`audit: ${auditFile}`);
    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
