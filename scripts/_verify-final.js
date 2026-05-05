require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const { getQboInstance } = require('../services/qboService');
    const qbo = await getQboInstance();
    const baseUrl = `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
    const headers = { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' };

    for (const id of ['71233', '73758']) {
        const inv = (await fetch(`${baseUrl}/invoice/${id}?minorversion=65`, { headers }).then(r => r.json())).Invoice;
        console.log(`Invoice ${id} (${inv.DocNumber})`);
        console.log(`  CustomerRef = ${JSON.stringify(inv.CustomerRef)}`);
        console.log(`  TotalAmt = ${inv.TotalAmt}, Balance = ${inv.Balance}`);
        console.log(`  LinkedTxn = ${JSON.stringify(inv.LinkedTxn || [])}`);
    }

    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
