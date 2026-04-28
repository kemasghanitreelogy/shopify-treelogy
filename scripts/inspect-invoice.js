// Inspect a single QBO invoice's lines + Jubelio grand_total breakdown.
// Usage: node scripts/inspect-invoice.js SP-260425PHT0VE69
require('dotenv').config();
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const { getQboInstance } = require('../services/qboService');
const jubelioApi = require('../services/jubelioApiService');

const sn = process.argv[2];
if (!sn) { console.error('usage: node scripts/inspect-invoice.js <salesorder_no>'); process.exit(1); }

const fmt = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID')}`;

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    if (jubelioApi.isConfigured()) await jubelioApi.login();
    const qbo = await getQboInstance();
    const map = await JubelioOrderMap.findOne({ salesorder_no: sn }).lean();
    if (!map) { console.error('not found'); process.exit(1); }
    console.log(`\n📄 ${sn} → QBO invoice id=${map.qbo_invoice_id}`);

    const log = await JubelioPayloadLog.findOne({ salesorder_no: sn }).sort({ _id: -1 }).lean();
    let so = log?.payload;
    if (!so?.grand_total && map.salesorder_id) {
        so = await jubelioApi.getOrderDetail(map.salesorder_id);
    }
    if (so) {
        console.log('\n──── Jubelio source ────');
        console.log(`status        : ${so.status}`);
        console.log(`subtotal      : ${fmt(so.subtotal)}`);
        console.log(`shipping_cost : ${fmt(so.shipping_cost)}`);
        console.log(`shipping_disc : ${fmt(so.shipping_cost_discount)}`);
        console.log(`service_fee   : ${fmt(so.service_fee)}`);
        console.log(`order_proc_fee: ${fmt(so.order_processing_fee)}`);
        console.log(`insurance     : ${fmt(so.insurance_cost)}`);
        console.log(`add_fee       : ${fmt(so.add_fee)}`);
        console.log(`add_disc      : ${fmt(so.add_disc)}`);
        console.log(`discount_mkt  : ${fmt(so.discount_marketplace)}`);
        console.log(`discount      : ${fmt(so.discount_amount)}`);
        console.log(`grand_total   : ${fmt(so.grand_total)}`);
        console.log('items:');
        for (const it of (so.items || [])) {
            console.log(`  - ${it.item_code} "${it.item_name}" qty=${it.qty} price=${fmt(it.price)} amount=${fmt(it.amount)}`);
        }
    }

    const url = `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}/invoice/${map.qbo_invoice_id}?minorversion=${qbo.minorversion || '65'}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' } });
    const body = await res.json();
    const inv = body?.Invoice;
    console.log('\n──── QBO invoice ────');
    console.log(`DocNumber : ${inv.DocNumber}`);
    console.log(`TxnDate   : ${inv.TxnDate}`);
    console.log(`TotalAmt  : ${fmt(inv.TotalAmt)}`);
    console.log(`Balance   : ${fmt(inv.Balance)}`);
    console.log(`ApplyTaxAfterDiscount : ${inv.ApplyTaxAfterDiscount}`);
    console.log(`GlobalTaxCalculation  : ${inv.GlobalTaxCalculation}`);
    console.log('Lines:');
    for (const l of (inv.Line || [])) {
        const itemRef = l.SalesItemLineDetail?.ItemRef;
        const dt = l.DiscountLineDetail;
        const sub = l.DetailType === 'SubTotalLineDetail';
        if (sub) console.log(`  [SubTotal] ${fmt(l.Amount)}`);
        else if (l.DetailType === 'DiscountLineDetail')
            console.log(`  [Discount] ${fmt(l.Amount)} percent=${dt?.PercentBased} pct=${dt?.DiscountPercent} "${l.Description || ''}"`);
        else if (l.DetailType === 'SalesItemLineDetail')
            console.log(`  [Item   ] ${fmt(l.Amount)} item=${itemRef?.value}/"${itemRef?.name}" qty=${l.SalesItemLineDetail?.Qty} unitPrice=${fmt(l.SalesItemLineDetail?.UnitPrice)} "${l.Description || ''}"`);
        else
            console.log(`  [${l.DetailType}] ${fmt(l.Amount)} "${l.Description || ''}"`);
    }
    if (so) {
        const linesTotal = (inv.Line || []).reduce((s, l) => {
            if (l.DetailType === 'DiscountLineDetail') return s - Number(l.Amount || 0);
            if (l.DetailType === 'SalesItemLineDetail') return s + Number(l.Amount || 0);
            return s;
        }, 0);
        console.log(`\nlinesTotal (compute)    : ${fmt(linesTotal)}`);
        console.log(`grand_total (Jubelio)   : ${fmt(so.grand_total)}`);
        console.log(`diff                    : ${fmt(linesTotal - so.grand_total)}`);
    }
    await mongoose.disconnect();
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
