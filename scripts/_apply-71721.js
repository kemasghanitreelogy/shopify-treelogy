require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const { getQboInstance } = require('../services/qboService');
    const qbo = await getQboInstance();
    const baseUrl = `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
    const headers = { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json', 'Content-Type': 'application/json' };

    const pmt = (await fetch(`${baseUrl}/payment/71721?minorversion=65`, { headers }).then(r => r.json())).Payment;
    const r = await fetch(`${baseUrl}/payment?minorversion=65`, {
        method: 'POST', headers,
        body: JSON.stringify({
            ...pmt,
            Line: [{
                Amount: 690000,
                LinkedTxn: [{ TxnId: '71233', TxnType: 'Invoice' }],
            }],
        }),
    });
    const j = await r.json();
    if (!j?.Payment) { console.error('FAIL', JSON.stringify(j).slice(0, 400)); process.exit(1); }
    console.log(`Payment 71721: TotalAmt=${j.Payment.TotalAmt} UnappliedAmt=${j.Payment.UnappliedAmt} lines=${(j.Payment.Line || []).length}`);

    const inv = (await fetch(`${baseUrl}/invoice/71233?minorversion=65`, { headers }).then(r => r.json())).Invoice;
    console.log(`Invoice 71233: CustomerRef=${inv.CustomerRef?.value} Balance=${inv.Balance} LinkedTxn=${JSON.stringify(inv.LinkedTxn || [])}`);

    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
