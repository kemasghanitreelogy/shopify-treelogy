require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const { getQboInstance } = require('../services/qboService');
    const qbo = await getQboInstance();
    const baseUrl = `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
    const headers = { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' };

    const cR = await fetch(`${baseUrl}/customer/14756?minorversion=65`, { headers });
    const c = (await cR.json())?.Customer;
    console.log('Customer 14756');
    console.log('  DisplayName:', c.DisplayName);
    console.log('  PrimaryPhone:', c.PrimaryPhone?.FreeFormNumber || '-');
    console.log('  PrimaryEmail:', c.PrimaryEmailAddr?.Address || '-');
    console.log('  ShipAddr:', JSON.stringify(c.ShipAddr || {}, null, 2));
    console.log('  BillAddr:', JSON.stringify(c.BillAddr || {}, null, 2));
    console.log('  MetaData:', JSON.stringify(c.MetaData));

    const invQ = encodeURIComponent("SELECT Id, DocNumber, TotalAmt, TxnDate FROM Invoice WHERE CustomerRef = '14756' ORDERBY TxnDate ASC");
    const invR = await fetch(`${baseUrl}/query?query=${invQ}&minorversion=65`, { headers });
    const invs = (await invR.json())?.QueryResponse?.Invoice || [];
    console.log(`\nInvoices on this customer: ${invs.length}`);
    invs.forEach(i => console.log(`  id=${i.Id} doc=${i.DocNumber} amt=${i.TotalAmt} date=${i.TxnDate}`));

    // Check our payload log for the 71233 order's recipient details
    const L = require('../models/JubelioPayloadLog');
    const log = await L.findOne({ 'payload.salesorder_no': /^TP-583774525508847513/ }).sort({ received_at: 1 }).lean();
    if (log) {
        console.log('\nOriginal order recipient:');
        console.log('  customer_name:', log.payload.customer_name);
        console.log('  shipping_full_name:', log.payload.shipping_full_name);
        console.log('  shipping_phone:', log.payload.shipping_phone);
        console.log('  shipping_city:', log.payload.shipping_city);
        console.log('  shipping_address:', String(log.payload.shipping_address || '').slice(0, 100));
        console.log('  shipping_post_code:', log.payload.shipping_post_code);
        console.log('  shipping_province:', log.payload.shipping_province);
        console.log('  contact_id:', log.payload.contact_id);
    }

    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
