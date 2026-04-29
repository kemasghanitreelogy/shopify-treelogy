// Create missing Payments for 6 Shopify (SHF) invoices that were force-synced
// without Payment because Shopify webhooks don't populate payment_date and the
// payload-log snapshot showed status=INVOICED. Jubelio API getOrderDetail
// confirms is_paid=true + status=PAID for all 6, so create Payment now.

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');
const jubelioApi = require('../services/jubelioApiService');
const webhook = require('../routes/jubelioWebhook');

const apply = process.argv.includes('--apply');

const TARGETS = [
    // 27-28 April batch (already applied 2026-04-29 morning)
    // { sn: 'SHF-7498-128887', qbo_invoice_id: '70994', salesorder_id: 1113 },
    // { sn: 'SHF-7497-128887', qbo_invoice_id: '71012', salesorder_id: 1103 },
    // { sn: 'SHF-7496-128887', qbo_invoice_id: '71033', salesorder_id: 1088 },
    // { sn: 'SHF-7495-128887', qbo_invoice_id: '71042', salesorder_id: 1082 },
    // { sn: 'SHF-7494-128887', qbo_invoice_id: '71045', salesorder_id: 1067 },
    // { sn: 'SHF-7493-128887', qbo_invoice_id: '71050', salesorder_id: 1064 },
    // 29 April batch
    { sn: 'SHF-7505-128887', qbo_invoice_id: '71072', salesorder_id: 1150 },
    { sn: 'SHF-7504-128887', qbo_invoice_id: '71083', salesorder_id: 1142 },
    { sn: 'SHF-7503-128887', qbo_invoice_id: '71090', salesorder_id: 1137 },
    { sn: 'SHF-7502-128887', qbo_invoice_id: '71091', salesorder_id: 1136 },
    { sn: 'SHF-7501-128887', qbo_invoice_id: '71092', salesorder_id: 1133 },
    { sn: 'SHF-7500-128887', qbo_invoice_id: '71099', salesorder_id: 1126 },
    { sn: 'SHF-7499-128887', qbo_invoice_id: '71112', salesorder_id: 1117 },
];

const fmt = (n) => `Rp ${(n || 0).toLocaleString('id-ID')}`;

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    const qboBaseUrl = `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const auditFile = `create-missing-payments-shf-${ts}.jsonl`;
    const audit = (e) => fs.appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');

    console.log(`\nCREATE-MISSING-PAYMENTS  ${TARGETS.length} SHF invoices  mode=${apply ? 'APPLY' : 'DRY-RUN'}\n`);

    const stats = { ok: 0, applied: 0, errors: 0 };
    for (const t of TARGETS) {
        try {
            // Fetch fresh invoice from QBO
            const invRes = await fetch(`${qboBaseUrl}/invoice/${t.qbo_invoice_id}?minorversion=65`, {
                headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' },
            });
            const invBody = await invRes.json();
            const inv = invBody?.Invoice;
            if (!inv) throw new Error('invoice not found');

            // Fetch SO detail from Jubelio
            const detail = await jubelioApi.getOrderDetail(t.salesorder_id);
            const so = detail?.data || detail;
            if (!so) throw new Error('jubelio detail not found');

            console.log(`━━━ ${t.sn}  inv=${inv.Id}  balance=${fmt(inv.Balance)}  so_status=${so.status}  is_paid=${so.is_paid}`);

            if (Number(inv.Balance || 0) === 0) {
                console.log(`    SKIP: invoice already balanced (Payment exists)`);
                audit({ ...t, status: 'skipped_already_balanced' });
                stats.ok++;
                continue;
            }

            console.log(`    PLAN: create Payment amount=${fmt(inv.Balance)} TxnDate=${so.payment_date || so.transaction_date}`);
            audit({ ...t, action: 'plan', dryRun: !apply, balance: inv.Balance, txn_date_src: so.payment_date ? 'payment_date' : 'transaction_date' });

            if (!apply) { stats.ok++; continue; }

            // markQboInvoicePaid uses so.payment_date || so.transaction_date for TxnDate (webhook:1234)
            const customerId = inv.CustomerRef?.value;
            const payment = await webhook.markQboInvoicePaid(qbo, inv, customerId, so);
            if (payment) {
                console.log(`    ✓ Payment ${payment.Id} amount=${fmt(payment.TotalAmt)} TxnDate=${payment.TxnDate}`);
                audit({ ...t, status: 'applied', payment_id: payment.Id, payment_amount: payment.TotalAmt, payment_txn_date: payment.TxnDate });
                stats.applied++;
            } else {
                console.log(`    No payment created (markQboInvoicePaid returned null)`);
                audit({ ...t, status: 'noop' });
            }
        } catch (e) {
            console.error(`    ERROR ${t.sn}: ${e.message.slice(0, 400)}`);
            audit({ ...t, status: 'error', error: e.message });
            stats.errors++;
        }
        console.log();
    }

    console.log(`SUMMARY  ok=${stats.ok}  applied=${stats.applied}  errors=${stats.errors}`);
    console.log(`audit: ${auditFile}`);
    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
