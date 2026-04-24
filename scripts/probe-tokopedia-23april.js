// Check which of these 17 TP- SOs are in QBO and what TxnDate they have.
require('dotenv').config();
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const { getQboInstance } = require('../services/qboService');

const CODES = [
    'TP-583660429986792673','TP-583660069175658295','TP-583659963344782504',
    'TP-583659004629780165','TP-583658908894594432','TP-583658352539239608',
    'TP-583658298698794040','TP-583657847005611101','TP-583657569629144130',
    'TP-583656999017481295','TP-583656917193753834','TP-583655688462304420',
    'TP-583654481038182190','TP-583653738189850082','TP-583653673582429909',
    'TP-583653041495180373','TP-583651852478023659',
];

const getInvoice = (qbo, id) => new Promise((resolve) => {
    qbo.getInvoice(id, (err, body) => err ? resolve({ err: String(err.message || err).slice(0, 200) }) : resolve({ inv: body }));
});

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    // Tokopedia SO numbers in our map can have either the bare TP- form or
    // a `-NNNNNN` channel suffix (e.g. -128884). Match via prefix.
    const conditions = CODES.map(c => ({ salesorder_no: { $regex: `^${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } }));
    const rows = await JubelioOrderMap.find({ $or: conditions })
        .select('salesorder_no qbo_invoice_id last_transaction_date_raw last_status last_grand_total last_synced_at')
        .lean();

    const map = new Map();
    for (const r of rows) {
        const base = CODES.find(c => r.salesorder_no.startsWith(c));
        if (base && !map.has(base)) map.set(base, r);
    }

    const buckets = { txn23: [], txnOther: [], notMapped: [], deleted: [], error: [] };
    for (const code of CODES) {
        const r = map.get(code);
        if (!r) { buckets.notMapped.push(code); continue; }
        const { inv, err } = await getInvoice(qbo, r.qbo_invoice_id);
        if (err) {
            if (/Object Not Found|6240|404/i.test(err)) buckets.deleted.push({ code, mapped: r.salesorder_no, id: r.qbo_invoice_id });
            else buckets.error.push({ code, mapped: r.salesorder_no, id: r.qbo_invoice_id, err });
            continue;
        }
        const entry = {
            code, mapped: r.salesorder_no, id: r.qbo_invoice_id,
            txnDate: inv.TxnDate, total: inv.TotalAmt, balance: inv.Balance,
            status: r.last_status, raw: r.last_transaction_date_raw || null,
            createTime: inv.MetaData?.CreateTime,
        };
        if (inv.TxnDate === '2026-04-23') buckets.txn23.push(entry); else buckets.txnOther.push(entry);
    }

    console.log(`\n=== TxnDate=2026-04-23 in QBO: ${buckets.txn23.length} ===`);
    for (const x of buckets.txn23) console.log(`  ✅ ${x.code} → ${x.mapped}  inv=${x.id}  total=${x.total}`);
    console.log(`\n=== TxnDate ≠ 2026-04-23 in QBO: ${buckets.txnOther.length} ===`);
    for (const x of buckets.txnOther) console.log(`  ⚠️  ${x.code} → ${x.mapped}  inv=${x.id}  txnDate=${x.txnDate}  raw="${x.raw}"  createTime=${x.createTime}`);
    console.log(`\n=== Not mapped (sync never succeeded): ${buckets.notMapped.length} ===`);
    for (const x of buckets.notMapped) console.log(`  ❌ ${x}`);
    console.log(`\n=== Deleted in QBO: ${buckets.deleted.length} ===`);
    for (const x of buckets.deleted) console.log(`  🗑  ${x.code} → ${x.mapped}  inv=${x.id}`);
    console.log(`\n=== Error: ${buckets.error.length} ===`);
    for (const x of buckets.error) console.log(`  ❌ ${x.code} → ${x.mapped}  inv=${x.id}  err=${x.err}`);

    await mongoose.disconnect();
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
