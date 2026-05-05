require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const { getQboInstance } = require('../services/qboService');
    const qbo = await getQboInstance();
    const baseUrl = `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
    const headers = { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' };

    for (const cid of ['14641', '14921', '14756']) {
        const r = await fetch(`${baseUrl}/customer/${cid}?minorversion=65`, { headers });
        const c = (await r.json())?.Customer;
        if (!c) { console.log(cid, 'not found'); continue; }
        console.log(`Customer ${cid}: "${c.DisplayName}" Active=${c.Active}`);
        console.log(`  Job=${c.Job} ParentRef=${JSON.stringify(c.ParentRef || null)} Level=${c.Level}`);
        console.log(`  FullyQualifiedName=${c.FullyQualifiedName}`);
        console.log(`  PrimaryPhone=${c.PrimaryPhone?.FreeFormNumber || '-'}`);
    }

    const pmtR = await fetch(`${baseUrl}/payment/71721?minorversion=65`, { headers });
    const pmt = (await pmtR.json())?.Payment;
    console.log(`\nPayment 71721:`);
    console.log(`  CustomerRef=${JSON.stringify(pmt.CustomerRef)}`);
    console.log(`  TotalAmt=${pmt.TotalAmt}  SyncToken=${pmt.SyncToken}`);
    console.log(`  Line=${JSON.stringify(pmt.Line, null, 2)}`);

    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
