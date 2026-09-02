// Test reconcileSkippedPayment — gap yang bikin SHF-10704-128887 tidak punya
// Payment setelah outage Intuit 2026-09-02.
//
// Memakai fungsi asli dari routes/jubelioWebhook.js + dokumen Mongo sungguhan
// di realm palsu "TEST-REALM" (dihapus di akhir), dengan objek qbo tiruan
// supaya tidak ada satu pun panggilan ke QuickBooks.
//
//   node scripts/_test-skip-path-payment-reconcile.js
require('dotenv').config();
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const wh = require('../routes/jubelioWebhook');

const REALM = 'TEST-REALM';
const SO_ID = 999999901;
let pass = 0, fail = 0;
const ok = (c, l) => { c ? (pass++, console.log(`  ✅ ${l}`)) : (fail++, console.log(`  ❌ ${l}`)); };
const quiet = () => {};

const fakeQbo = ({ balance = 0, linked = false } = {}) => ({
    calls: { getInvoice: 0, findPayments: 0, createPayment: 0 },
    getInvoice(id, cb) {
        this.calls.getInvoice++;
        cb(null, { Id: String(id), DocNumber: 'WA-TEST', TotalAmt: 1145000, Balance: balance, CustomerRef: { value: '777' } });
    },
    findPayments(_c, cb) {
        this.calls.findPayments++;
        cb(null, { QueryResponse: { Payment: linked ? [{ Id: '555', Line: [{ LinkedTxn: [{ TxnId: '106226', TxnType: 'Invoice' }] }] }] : [] } });
    },
    createPayment(payload, cb) { this.calls.createPayment++; cb(null, { Id: '900001', TotalAmt: payload.TotalAmt }); },
});

const seed = (extra = {}) => JubelioOrderMap.findOneAndUpdate(
    { salesorder_id: SO_ID, qbo_realm_id: REALM },
    {
        salesorder_id: SO_ID, salesorder_no: 'TEST-SO', qbo_realm_id: REALM,
        qbo_invoice_id: '106226', last_status: 'PAID', last_grand_total: 1145000,
        manual_payment: false,   // reset eksplisit — kalau tidak, nilai true dari kasus sebelumnya menempel
        $unset: { qbo_payment_id: '', payment_reconciled_at: '' },
        ...extra,
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
);

const SO_PAID = { salesorder_id: SO_ID, salesorder_no: 'TEST-SO', grand_total: 1145000, note: '' };

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    try {
        console.log('\n▸ Kasus yang HARUS keluar tanpa menyentuh QBO');
        await seed(); await JubelioOrderMap.updateOne({ salesorder_id: SO_ID, qbo_realm_id: REALM }, { qbo_payment_id: '123' });
        let q = fakeQbo();
        ok((await wh.reconcileSkippedPayment(q, SO_PAID, REALM, 'PAID', quiet)) === null && q.calls.getInvoice === 0,
            'sudah punya qbo_payment_id → langsung keluar, 0 panggilan QBO');

        await seed(); await JubelioOrderMap.updateOne({ salesorder_id: SO_ID, qbo_realm_id: REALM }, { payment_reconciled_at: new Date() });
        q = fakeQbo();
        ok((await wh.reconcileSkippedPayment(q, SO_PAID, REALM, 'PAID', quiet)) === null && q.calls.getInvoice === 0,
            'sudah pernah direkonsiliasi → 0 panggilan QBO');

        await seed({ manual_payment: true });
        q = fakeQbo();
        ok((await wh.reconcileSkippedPayment(q, SO_PAID, REALM, 'PAID', quiet)) === null && q.calls.getInvoice === 0,
            'manual_payment (#UNPAID) → tidak diutak-atik');

        console.log('\n▸ Belum waktunya bayar — jangan di-stamp supaya dicek lagi nanti');
        await seed(); q = fakeQbo({ balance: 1145000 });
        await wh.reconcileSkippedPayment(q, SO_PAID, REALM, 'PROCESSING', quiet);
        let m = await JubelioOrderMap.findOne({ salesorder_id: SO_ID, qbo_realm_id: REALM }).lean();
        ok(q.calls.getInvoice === 0 && !m.payment_reconciled_at, 'status PROCESSING → tidak dicek, tidak di-stamp');

        await seed(); q = fakeQbo({ balance: 1145000 });
        await wh.reconcileSkippedPayment(q, { ...SO_PAID, note: 'kirim dulu #UNPAID nanti transfer' }, REALM, 'PAID', quiet);
        m = await JubelioOrderMap.findOne({ salesorder_id: SO_ID, qbo_realm_id: REALM }).lean();
        ok(q.calls.getInvoice === 0 && !m.payment_reconciled_at, 'penanda #UNPAID di note → Payment tetap urusan finance');

        console.log('\n▸ Invoice sudah lunas — cukup di-stamp sekali');
        await seed(); q = fakeQbo({ balance: 0 });
        const r = await wh.reconcileSkippedPayment(q, SO_PAID, REALM, 'PAID', quiet);
        m = await JubelioOrderMap.findOne({ salesorder_id: SO_ID, qbo_realm_id: REALM }).lean();
        ok(r === null && q.calls.getInvoice === 1 && q.calls.createPayment === 0 && !!m.payment_reconciled_at,
            'balance 0 → tidak buat Payment, di-stamp supaya tidak dicek lagi');

        console.log('\n▸ Skenario SHF-10704: invoice bersaldo padahal PAID');
        await seed(); q = fakeQbo({ balance: 1145000 });
        const created = await wh.reconcileSkippedPayment(q, SO_PAID, REALM, 'PAID', quiet);
        m = await JubelioOrderMap.findOne({ salesorder_id: SO_ID, qbo_realm_id: REALM }).lean();
        ok(created?.Id === '900001' && q.calls.createPayment === 1, `Payment tertinggal dibuat → id=${created?.Id}`);
        ok(m.qbo_payment_id === '900001' && !!m.payment_reconciled_at, 'id Payment + stempel tersimpan di mapping');

        q = fakeQbo({ balance: 1145000 });
        ok((await wh.reconcileSkippedPayment(q, SO_PAID, REALM, 'PAID', quiet)) === null && q.calls.createPayment === 0,
            'panggilan kedua tidak membuat Payment ganda');

        console.log('\n▸ Payment sudah ada di QBO tapi mapping belum tahu (data lama)');
        await seed(); q = fakeQbo({ balance: 1145000, linked: true });
        const r2 = await wh.reconcileSkippedPayment(q, SO_PAID, REALM, 'PAID', quiet);
        m = await JubelioOrderMap.findOne({ salesorder_id: SO_ID, qbo_realm_id: REALM }).lean();
        ok(r2 === null && q.calls.createPayment === 0 && !!m.payment_reconciled_at,
            'markQboInvoicePaid mendeteksi Payment terpaut → tidak dobel, mapping di-stamp');
    } finally {
        await JubelioOrderMap.deleteMany({ qbo_realm_id: REALM });
        const sisa = await JubelioOrderMap.countDocuments({ qbo_realm_id: REALM });
        console.log(`\nBersih-bersih: dokumen realm ${REALM} tersisa = ${sisa}`);
        await mongoose.disconnect();
    }
    console.log(`${pass} lulus, ${fail} gagal`);
    process.exit(fail ? 1 : 0);
})();
