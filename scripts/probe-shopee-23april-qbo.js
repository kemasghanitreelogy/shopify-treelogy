// Verify each mapped invoice is still active (not voided/deleted) in QBO.
require('dotenv').config();
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const { getQboInstance } = require('../services/qboService');

const CODES = [
    'SP-260423JBC4WVSC','SP-260423J7NBGSPS','SP-260423J6FK7C6S','SP-260423J1JGFBQM',
    'SP-260423HTBAR92X','SP-260423HPKMSN7F','SP-260423HPAHYYQN','SP-260423HNHX7PBM',
    'SP-260423HNAY12ST','SP-260423HMXEGPXE','SP-260423HJ45THJA','SP-260423HHS13XDP',
    'SP-260423HF6M9B5P','SP-260423HE6MWESG','SP-260423HAJVWVWN','SP-260423H3UEQKFK',
];

const getInvoice = (qbo, id) => new Promise((resolve) => {
    qbo.getInvoice(id, (err, body) => {
        if (err) return resolve({ err: String(err.message || err).slice(0, 200) });
        resolve({ inv: body });
    });
});

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    const rows = await JubelioOrderMap.find({ salesorder_no: { $in: CODES } }).lean();
    const map = new Map(rows.map(r => [r.salesorder_no, r]));

    const buckets = { active: [], void: [], deleted: [], error: [], notMapped: [] };
    for (const code of CODES) {
        const r = map.get(code);
        if (!r) { buckets.notMapped.push(code); continue; }
        const { inv, err } = await getInvoice(qbo, r.qbo_invoice_id);
        if (err) {
            // QBO returns 6240 for invoices that are deleted (not just voided)
            if (/Object Not Found|6240|404/i.test(err)) buckets.deleted.push({ code, id: r.qbo_invoice_id, err });
            else buckets.error.push({ code, id: r.qbo_invoice_id, err });
            continue;
        }
        const isVoid = inv.PrivateNote && /^Voided/i.test(inv.PrivateNote);
        const totalZero = Number(inv.TotalAmt) === 0;
        const balanceZero = Number(inv.Balance) === 0;
        const txnDate = inv.TxnDate;
        const docNo = inv.DocNumber;
        if (isVoid || (totalZero && (inv.PrivateNote || '').toLowerCase().includes('void'))) {
            buckets.void.push({ code, id: r.qbo_invoice_id, doc: docNo, txnDate, total: inv.TotalAmt, note: inv.PrivateNote });
        } else {
            buckets.active.push({ code, id: r.qbo_invoice_id, doc: docNo, txnDate, total: inv.TotalAmt, balance: inv.Balance });
        }
    }

    console.log(`\n=== ACTIVE: ${buckets.active.length} ===`);
    for (const x of buckets.active) console.log(`  ✅ ${x.code}  inv=${x.id}  txnDate=${x.txnDate}  total=${x.total}  balance=${x.balance}`);
    console.log(`\n=== VOIDED: ${buckets.void.length} ===`);
    for (const x of buckets.void) console.log(`  ⚠️  ${x.code}  inv=${x.id}  txnDate=${x.txnDate}  total=${x.total}  note=${x.note}`);
    console.log(`\n=== DELETED: ${buckets.deleted.length} ===`);
    for (const x of buckets.deleted) console.log(`  🗑  ${x.code}  inv=${x.id}  err=${x.err}`);
    console.log(`\n=== ERROR: ${buckets.error.length} ===`);
    for (const x of buckets.error) console.log(`  ❌ ${x.code}  inv=${x.id}  err=${x.err}`);
    console.log(`\n=== NOT MAPPED: ${buckets.notMapped.length} ===`);
    for (const x of buckets.notMapped) console.log(`  ❓ ${x}`);

    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
