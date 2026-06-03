// Dry-run blast-radius scan for the QBO "colon in customer name" bug.
// QBO DisplayName rejects ':' (reserved parent:sub-customer separator), but
// sanitizeCustomerName() only strips colons at the start/end, not mid-string.
// A first-time customer whose name carries a mid-string ':' fails createCustomer
// and the whole sync aborts — no invoice. This scan separates:
//   • SAFE  : SO already has a QBO invoice (failure only on a later update → noise)
//   • STUCK : SO has no qbo_invoice_id → order never landed in QBO (real risk)
//
// Read-only. No writes.
require('dotenv').config();
const mongoose = require('mongoose');
const JubelioCustomerMap = require('../models/JubelioCustomerMap');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');

const COLON = /:/;

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);

    // ── 1. Payload-level scan: any SO whose customer_name / shipping_full_name
    //       carries a colon. This is the population that exercises the bug.
    console.log(`\n━━━ Payloads with ':' in customer_name / shipping_full_name ━━━`);
    const logHits = await JubelioPayloadLog.find({
        $or: [
            { 'payload.customer_name': { $regex: ':' } },
            { 'payload.shipping_full_name': { $regex: ':' } },
        ],
    })
        .select('salesorder_no salesorder_id received_at payload.customer_name payload.shipping_full_name payload.status payload.action')
        .sort({ received_at: -1 })
        .lean();

    // Collapse to one row per SO (latest payload wins).
    const bySo = new Map();
    for (const h of logHits) {
        const sn = h.salesorder_no || `id:${h.salesorder_id}`;
        if (!bySo.has(sn)) bySo.set(sn, h);
    }
    console.log(`  payloads matched: ${logHits.length}  ·  distinct SOs: ${bySo.size}`);

    const safe = [];
    const stuck = [];
    for (const [sn, h] of bySo) {
        const map = await JubelioOrderMap.findOne(
            h.salesorder_id ? { salesorder_id: h.salesorder_id } : { salesorder_no: sn }
        ).select('qbo_invoice_id last_status last_synced_at').lean();
        const hasInvoice = !!map?.qbo_invoice_id;
        const row = {
            sn,
            soId: h.salesorder_id,
            field: COLON.test(h.payload?.customer_name || '') ? 'customer_name' : 'shipping_full_name',
            name: h.payload?.customer_name || h.payload?.shipping_full_name || '',
            status: h.payload?.status,
            invoice: map?.qbo_invoice_id || null,
        };
        (hasInvoice ? safe : stuck).push(row);
    }

    console.log(`\n  ✅ SAFE (already have QBO invoice — failure is noise only): ${safe.length}`);
    for (const r of safe.slice(0, 30)) {
        console.log(`     ${r.sn}  inv=${r.invoice}  status=${r.status}  ${r.field}=${JSON.stringify(r.name)}`);
    }
    if (safe.length > 30) console.log(`     … (${safe.length - 30} more)`);

    console.log(`\n  ❌ STUCK (NO qbo_invoice_id — never landed in QBO): ${stuck.length}`);
    for (const r of stuck) {
        console.log(`     ${r.sn}  soId=${r.soId}  status=${r.status}  ${r.field}=${JSON.stringify(r.name)}`);
    }

    // ── 2. JubelioCustomerMap awareness (names already persisted with a colon).
    console.log(`\n━━━ JubelioCustomerMap rows with ':' in stored names ━━━`);
    const cmHits = await JubelioCustomerMap.find({
        $or: [
            { last_customer_name_jubelio: { $regex: ':' } },
            { last_customer_name_qbo: { $regex: ':' } },
        ],
    }).select('source buyer_id qbo_customer_id last_so_no last_customer_name_jubelio last_customer_name_qbo').lean();
    console.log(`  total: ${cmHits.length}`);
    for (const c of cmHits.slice(0, 20)) {
        console.log(`  [${c.source}] buyer=${c.buyer_id} qbo_cust=${c.qbo_customer_id} last_so=${c.last_so_no}`);
        console.log(`     jub: ${JSON.stringify(c.last_customer_name_jubelio || '')}`);
        console.log(`     qbo: ${JSON.stringify(c.last_customer_name_qbo || '')}`);
    }
    if (cmHits.length > 20) console.log(`  … (${cmHits.length - 20} more)`);

    console.log(`\n━━━ SUMMARY ━━━`);
    console.log(`  distinct SOs touching a colon name : ${bySo.size}`);
    console.log(`  ✅ safe (have invoice)             : ${safe.length}`);
    console.log(`  ❌ stuck (no invoice, REAL risk)   : ${stuck.length}`);
    console.log(`  CustomerMap rows w/ colon          : ${cmHits.length}`);

    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
