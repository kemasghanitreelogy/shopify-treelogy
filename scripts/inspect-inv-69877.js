// Deep-dive on the single BUG candidate: TP-583683909731714489 inv 69877.
// Webhook fired 8x with COMPLETED status but no Payment in QBO.
// Possibilities:
//   (a) Payment created then deleted (check QBO query for Payment by memo)
//   (b) markQboInvoicePaid threw mid-way (check JubelioOrderMap.last_status)
//   (c) idempotency skipped Payment (check timeline of payload logs)

require('dotenv').config();
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const JubelioOrderMap = require('../models/JubelioOrderMap');

const SO_PREFIX = 'TP-583683909731714489';
const INV_ID = '69877';

const qboBaseUrl = (qbo) => `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
const qboFetch = async (qbo, p) => {
    const url = `${qboBaseUrl(qbo)}${p}${p.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' } });
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(`QBO GET ${p} (${res.status}): ${JSON.stringify(body).slice(0, 600)}`);
    return body;
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    // 1. JubelioOrderMap entry
    const map = await JubelioOrderMap.findOne({
        salesorder_no: { $regex: '^' + SO_PREFIX },
        qbo_realm_id: String(qbo.realmId),
    }).lean();
    console.log('\n━━━ JubelioOrderMap entry:');
    console.log(JSON.stringify(map, null, 2));

    // 2. Payload log timeline
    const logs = await JubelioPayloadLog.find({ salesorder_no: { $regex: '^' + SO_PREFIX } })
        .sort({ received_at: 1 })
        .select('received_at endpoint action status salesorder_id is_canceled')
        .lean();
    console.log(`\n━━━ Webhook timeline (${logs.length} payloads):`);
    for (const l of logs) {
        console.log(`  ${l.received_at.toISOString()}  ${(l.endpoint || '-').padEnd(8)} action=${(l.action || '-').padEnd(20)} status=${(l.status || '-').padEnd(12)} canceled=${l.is_canceled || false} so_id=${l.salesorder_id}`);
    }

    // 3. Invoice current state
    const invBody = await qboFetch(qbo, `/invoice/${INV_ID}`);
    const inv = invBody?.Invoice;
    console.log(`\n━━━ Invoice ${inv.Id}  doc=${inv.DocNumber}`);
    console.log(`  TotalAmt = Rp ${(inv.TotalAmt || 0).toLocaleString('id-ID')}`);
    console.log(`  Balance  = Rp ${(inv.Balance || 0).toLocaleString('id-ID')}`);
    console.log(`  CreateTime    = ${inv.MetaData?.CreateTime}`);
    console.log(`  LastModified  = ${inv.MetaData?.LastUpdatedTime}`);
    console.log(`  LinkedTxn = ${JSON.stringify(inv.LinkedTxn || [])}`);
    console.log(`  PrivateNote = ${(inv.PrivateNote || '').slice(0, 250)}`);

    // 4. Search for any Payment ever created with memo referencing this SO# (in case deleted)
    try {
        const q = `SELECT Id, TxnDate, TotalAmt, UnappliedAmt, PrivateNote, MetaData FROM Payment WHERE PrivateNote LIKE '%${SO_PREFIX}%' MAXRESULTS 20`;
        const res = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const payments = res?.QueryResponse?.Payment || [];
        console.log(`\n━━━ Payments with memo containing "${SO_PREFIX}": ${payments.length}`);
        for (const p of payments) {
            console.log(`  Payment id=${p.Id} date=${p.TxnDate} TotalAmt=Rp ${(p.TotalAmt || 0).toLocaleString('id-ID')} UnappliedAmt=Rp ${(p.UnappliedAmt || 0).toLocaleString('id-ID')}`);
            console.log(`    PrivateNote = ${(p.PrivateNote || '').slice(0, 200)}`);
            console.log(`    Created = ${p.MetaData?.CreateTime}  LastModified = ${p.MetaData?.LastUpdatedTime}`);
        }
    } catch (e) {
        console.log(`Payment query failed: ${e.message.slice(0, 200)}`);
    }

    // 5. Search Customer balance (maybe payment exists but not linked to this invoice)
    try {
        const customerId = inv.CustomerRef?.value;
        const q = `SELECT Id, TxnDate, TotalAmt, UnappliedAmt, CustomerRef, PrivateNote FROM Payment WHERE CustomerRef = '${customerId}' MAXRESULTS 20`;
        const res = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const payments = res?.QueryResponse?.Payment || [];
        console.log(`\n━━━ All Payments for customer ${customerId} (${inv.CustomerRef?.name}): ${payments.length}`);
        for (const p of payments) {
            console.log(`  Payment id=${p.Id} date=${p.TxnDate} TotalAmt=Rp ${(p.TotalAmt || 0).toLocaleString('id-ID')} UnappliedAmt=Rp ${(p.UnappliedAmt || 0).toLocaleString('id-ID')}`);
            console.log(`    note = ${(p.PrivateNote || '').slice(0, 120)}`);
        }
    } catch (e) {
        console.log(`Customer payment query failed: ${e.message.slice(0, 200)}`);
    }

    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
