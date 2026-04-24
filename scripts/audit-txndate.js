// Reconciliation: scan recent JubelioOrderMap entries, fetch the matching
// QBO Invoice, and flag any TxnDate that doesn't match the expected date
// (computed from the raw Jubelio transaction_date in Asia/Jakarta TZ).
//
// Usage:
//   node scripts/audit-txndate.js             # last 7 days
//   node scripts/audit-txndate.js --days=30   # last N days
//   node scripts/audit-txndate.js --days=30 --fix    # auto-patch mismatches
require('dotenv').config();
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const { getQboInstance } = require('../services/qboService');

const args = process.argv.slice(2);
const days = Number((args.find(a => a.startsWith('--days=')) || '--days=7').split('=')[1]);
const doFix = args.includes('--fix');

const JKT_OFFSET_MS = 7 * 60 * 60 * 1000;
const isoDateJakarta = (raw) => {
    if (!raw) return null;
    const d = new Date(String(raw).trim());
    if (Number.isNaN(d.getTime())) return String(raw).substring(0, 10);
    return new Date(d.getTime() + JKT_OFFSET_MS).toISOString().substring(0, 10);
};

const getInvoice = (qbo, id) => new Promise((resolve) => {
    qbo.getInvoice(id, (err, body) => err ? resolve({ err: String(err.message || err).slice(0, 200) }) : resolve({ inv: body }));
});
const updateInvoice = (qbo, payload) => new Promise((resolve, reject) => {
    qbo.updateInvoice(payload, (err, body) => err ? reject(err) : resolve(body));
});

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const rows = await JubelioOrderMap.find({ last_synced_at: { $gte: since } })
        .select('salesorder_no qbo_invoice_id qbo_doc_number last_transaction_date_raw last_txn_date last_synced_at')
        .lean();

    console.log(`Auditing ${rows.length} mappings synced in last ${days} day(s)...\n`);
    const mismatches = [];
    const noRaw = [];

    for (const r of rows) {
        if (!r.last_transaction_date_raw) {
            noRaw.push(r);
            continue;
        }
        const expected = isoDateJakarta(r.last_transaction_date_raw);
        const { inv, err } = await getInvoice(qbo, r.qbo_invoice_id);
        if (err) {
            console.log(`  ⚠️  ${r.salesorder_no} inv=${r.qbo_invoice_id}: ${err}`);
            continue;
        }
        if (inv.TxnDate !== expected) {
            mismatches.push({
                so: r.salesorder_no,
                inv: r.qbo_invoice_id,
                qboTxnDate: inv.TxnDate,
                expected,
                raw: r.last_transaction_date_raw,
                syncToken: inv.SyncToken,
            });
        }
    }

    console.log(`\n=== MISMATCHES: ${mismatches.length} ===`);
    for (const m of mismatches) {
        console.log(`  ${m.so}  inv=${m.inv}  QBO=${m.qboTxnDate}  expected=${m.expected}  raw="${m.raw}"`);
    }
    if (noRaw.length) {
        console.log(`\n=== NO RAW DATE (synced before audit field added): ${noRaw.length} ===`);
        console.log('  → run audit again after newer webhooks have populated the field.');
    }

    if (doFix && mismatches.length) {
        console.log(`\nApplying --fix to ${mismatches.length} invoices...`);
        for (const m of mismatches) {
            try {
                const updated = await updateInvoice(qbo, {
                    Id: m.inv, SyncToken: m.syncToken, sparse: true, TxnDate: m.expected,
                });
                console.log(`  ✅ ${m.so} inv=${m.inv}: ${m.qboTxnDate} → ${updated.TxnDate}`);
            } catch (e) {
                console.log(`  ❌ ${m.so} inv=${m.inv}: ${e.message || JSON.stringify(e).slice(0, 200)}`);
            }
        }
    } else if (mismatches.length) {
        console.log(`\nRe-run with --fix to auto-patch.`);
    }

    await mongoose.disconnect();
    process.exit(mismatches.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
