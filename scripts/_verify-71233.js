require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const { getQboInstance } = require('../services/qboService');
    const qbo = await getQboInstance();
    const baseUrl = `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
    const headers = { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' };

    const invR = await fetch(`${baseUrl}/invoice/71233?minorversion=65`, { headers });
    const inv = (await invR.json())?.Invoice;
    console.log('Invoice 71233');
    console.log('  CustomerRef=', JSON.stringify(inv.CustomerRef));
    console.log('  TotalAmt=', inv.TotalAmt, 'Balance=', inv.Balance, 'SyncToken=', inv.SyncToken);
    console.log('  LinkedTxn=', JSON.stringify(inv.LinkedTxn || []));

    const pmtR = await fetch(`${baseUrl}/payment/71721?minorversion=65`, { headers });
    const pmt = (await pmtR.json())?.Payment;
    console.log('\nPayment 71721');
    console.log('  CustomerRef=', JSON.stringify(pmt.CustomerRef));
    console.log('  TotalAmt=', pmt.TotalAmt, 'UnappliedAmt=', pmt.UnappliedAmt, 'SyncToken=', pmt.SyncToken);
    console.log('  Line=', JSON.stringify(pmt.Line, null, 2));

    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
