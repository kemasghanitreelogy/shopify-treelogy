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
    console.log('  DocNumber:', inv.DocNumber);
    console.log('  CustomerRef:', JSON.stringify(inv.CustomerRef));
    console.log('  TotalAmt:', inv.TotalAmt, 'Balance:', inv.Balance);
    console.log('  SyncToken:', inv.SyncToken);
    console.log('  LinkedTxn:', JSON.stringify(inv.LinkedTxn || []));

    const pmtQ = encodeURIComponent("SELECT Id, CustomerRef, TotalAmt, SyncToken FROM Payment WHERE Line.LinkedTxn.TxnId = '71233'");
    const pmtR = await fetch(`${baseUrl}/query?query=${pmtQ}&minorversion=65`, { headers });
    const pmts = (await pmtR.json())?.QueryResponse?.Payment || [];
    console.log('\nLinked payments:', pmts.length);
    pmts.forEach(p => console.log(`  id=${p.Id} cust=${JSON.stringify(p.CustomerRef)} amt=${p.TotalAmt} syncToken=${p.SyncToken}`));

    const targetName = 'TP - R***';
    const escaped = targetName.replace(/'/g, "\\'");
    const sQ = encodeURIComponent(`SELECT Id, DisplayName, Active FROM Customer WHERE DisplayName = '${escaped}'`);
    const sR = await fetch(`${baseUrl}/query?query=${sQ}&minorversion=65`, { headers });
    const sCusts = (await sR.json())?.QueryResponse?.Customer || [];
    console.log(`\n"${targetName}" candidates:`, sCusts.length);
    sCusts.forEach(cc => console.log(`  id=${cc.Id} name=${cc.DisplayName} active=${cc.Active}`));

    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
