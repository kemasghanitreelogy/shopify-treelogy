// One-off: Payment yang hilang untuk SHF-10704-128887 (invoice QBO 106226).
//
// Sebab (outage Intuit 2026-09-02): percobaan jam 09:17 berhasil membuat
// invoice lalu gagal di langkah Payment karena QBO tidak merespons. Retry
// Jubelio berikutnya mengambil jalur idempoten "skipped" — dan jalur itu ikut
// melewati pembuatan Payment karena mengasumsikan webhook sebelumnya sudah
// menuntaskan sisi pembayaran. Invoice ada, Payment tidak pernah dibuat.
//
// Memakai markQboInvoicePaid yang sama persis dengan webhook, dengan payload
// Jubelio terakhir sebagai sumber angka — bukan angka yang diketik ulang.
//
//   node scripts/fix-payment-shf-10704.js           # dry-run
//   node scripts/fix-payment-shf-10704.js --apply
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const webhook = require('../routes/jubelioWebhook');

const SO_NO = 'SHF-10704-128887';
const QBO_INVOICE_ID = '106226';
const EXPECTED_TOTAL = 1145000;
const APPLY = process.argv.includes('--apply');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const auditPath = `fix-payment-shf-10704-${stamp}.jsonl`;
const audit = (r) => fs.appendFileSync(auditPath, JSON.stringify({ at: new Date().toISOString(), ...r }) + '\n');
const fmt = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID')}`;
const fail = (m) => { console.error(`\n⛔ ABORT — ${m}`); audit({ action: 'abort', msg: m }); throw new Error(m); };

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    const base = `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
    const H = { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' };
    const g = async (p) => (await fetch(`${base}/${p}${p.includes('?') ? '&' : '?'}minorversion=65`, { headers: H })).json();

    console.log('='.repeat(70));
    console.log(`Mode  : ${APPLY ? '🔴 APPLY' : '🟢 DRY-RUN'} · target ${SO_NO} · invoice ${QBO_INVOICE_ID}`);
    console.log(`Audit : ${auditPath}`);
    console.log('='.repeat(70));

    const map = await JubelioOrderMap.findOne({ salesorder_no: SO_NO, qbo_realm_id: String(qbo.realmId) }).lean();
    if (!map) fail('mapping tidak ada');
    if (String(map.qbo_invoice_id) !== QBO_INVOICE_ID) fail(`map.qbo_invoice_id=${map.qbo_invoice_id} ≠ ${QBO_INVOICE_ID}`);
    if (!['PAID', 'COMPLETED'].includes(String(map.last_status).toUpperCase())) fail(`status Jubelio ${map.last_status} — bukan PAID/COMPLETED`);
    console.log(`✓ map: status=${map.last_status} total=${fmt(map.last_grand_total)}`);

    const log = await JubelioPayloadLog.findOne({ salesorder_no: SO_NO }).sort({ received_at: -1 }).lean();
    if (!log?.payload) fail('payload webhook terakhir tidak ditemukan');
    const so = log.payload;
    if (Math.abs(Number(so.grand_total) - EXPECTED_TOTAL) > 1) fail(`grand_total payload ${so.grand_total} ≠ ${EXPECTED_TOTAL}`);
    if (webhook.hasUnpaidMarker(so)) fail('payload punya penanda #UNPAID — Payment memang harus manual');
    console.log(`✓ payload ${new Date(log.received_at).toISOString()} · status=${so.internal_status || so.status} · grand_total=${fmt(so.grand_total)}`);

    const inv = (await g(`invoice/${QBO_INVOICE_ID}`))?.Invoice;
    if (!inv) fail('invoice tidak ditemukan di QBO');
    if (inv.DocNumber !== 'WA-10704-128887') fail(`DocNumber tak terduga: ${inv.DocNumber}`);
    if (Math.abs(Number(inv.TotalAmt) - EXPECTED_TOTAL) > 1) fail(`TotalAmt ${inv.TotalAmt} ≠ ${EXPECTED_TOTAL}`);
    if (Number(inv.Balance) <= 0) fail(`Balance sudah ${inv.Balance} — Payment tampaknya sudah ada`);
    console.log(`✓ invoice ${inv.Id} · ${fmt(inv.TotalAmt)} · saldo ${fmt(inv.Balance)} · cust "${inv.CustomerRef?.name}"`);

    const existing = (await g(`query?query=${encodeURIComponent(`SELECT * FROM Payment WHERE CustomerRef = '${inv.CustomerRef.value}'`)}`))?.QueryResponse?.Payment || [];
    const linked = existing.filter(p => (p.Line || []).some(l => (l.LinkedTxn || []).some(t => t.TxnId === QBO_INVOICE_ID)));
    if (linked.length) fail(`sudah ada Payment terpaut: ${linked.map(p => p.Id).join(',')}`);
    console.log(`✓ belum ada Payment terpaut (customer punya ${existing.length} payment lain)`);

    if (!APPLY) {
        console.log(`\nDRY-RUN — akan membuat Payment ${fmt(Math.min(Number(so.grand_total), Number(inv.Balance)))} untuk invoice ${inv.Id}`);
        audit({ action: 'dry-run', qbo_invoice_id: QBO_INVOICE_ID, amount: Math.min(Number(so.grand_total), Number(inv.Balance)) });
        await mongoose.disconnect();
        return;
    }

    const payment = await webhook.markQboInvoicePaid(qbo, inv, inv.CustomerRef.value, so);
    console.log(`\n✅ Payment dibuat: id=${payment?.Id} · ${fmt(payment?.TotalAmt)}`);
    audit({ action: 'create-payment', qbo_payment_id: payment?.Id, amount: payment?.TotalAmt });

    const after = (await g(`invoice/${QBO_INVOICE_ID}`))?.Invoice;
    console.log(`Verifikasi: invoice ${after.Id} · total ${fmt(after.TotalAmt)} · saldo ${fmt(after.Balance)}`);
    audit({ action: 'verify', balance_after: after.Balance });
    if (Number(after.Balance) !== 0) console.warn('⚠️ saldo belum 0 — cek manual');
    await mongoose.disconnect();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
