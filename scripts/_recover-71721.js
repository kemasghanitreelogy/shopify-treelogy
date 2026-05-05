// Recover from partial unlink: relink Payment 71721 back to Invoice 71233
// on customer 14641 so we can rerun the rewire script cleanly.

require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const { getQboInstance } = require('../services/qboService');
    const qbo = await getQboInstance();
    const baseUrl = `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
    const headers = { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json', 'Content-Type': 'application/json' };

    const pmtR = await fetch(`${baseUrl}/payment/71721?minorversion=65`, { headers });
    const pmt = (await pmtR.json())?.Payment;
    console.log(`Payment 71721 BEFORE: CustomerRef=${pmt.CustomerRef?.value} TotalAmt=${pmt.TotalAmt} UnappliedAmt=${pmt.UnappliedAmt} lines=${(pmt.Line || []).length} SyncToken=${pmt.SyncToken}`);

    const invR = await fetch(`${baseUrl}/invoice/71233?minorversion=65`, { headers });
    const inv = (await invR.json())?.Invoice;
    console.log(`Invoice 71233 BEFORE: CustomerRef=${inv.CustomerRef?.value} Balance=${inv.Balance}`);

    if (pmt.UnappliedAmt > 0 && (pmt.Line || []).length === 0 && inv.CustomerRef?.value === pmt.CustomerRef?.value && inv.Balance > 0) {
        console.log('State is mid-flight — relinking ...');
        const restoredLine = [{
            Amount: 690000,
            LinkedTxn: [{ TxnId: '71233', TxnType: 'Invoice' }],
        }];
        const r = await fetch(`${baseUrl}/payment?minorversion=65`, {
            method: 'POST', headers,
            body: JSON.stringify({ ...pmt, Line: restoredLine }),
        });
        const j = await r.json();
        if (j?.Payment) {
            console.log(`✅ Payment 71721 relinked. lines=${(j.Payment.Line || []).length}`);
        } else {
            console.log('❌', JSON.stringify(j).slice(0, 400));
        }
        const inv2 = await fetch(`${baseUrl}/invoice/71233?minorversion=65`, { headers }).then(r => r.json());
        console.log(`Invoice 71233 AFTER: CustomerRef=${inv2.Invoice.CustomerRef?.value} Balance=${inv2.Invoice.Balance}`);
    } else {
        console.log('Not in mid-flight state — no recovery needed.');
    }

    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
