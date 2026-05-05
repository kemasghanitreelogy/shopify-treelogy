// Probe: can we unlink a Payment from its Invoice via sparse update with Line=[]?
// Read-only effect: this attempts the unlink, then immediately relinks to
// restore the original state. Use as a probe before relying on the technique.

require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const { getQboInstance } = require('../services/qboService');
    const qbo = await getQboInstance();
    const baseUrl = `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
    const headers = { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json', 'Content-Type': 'application/json' };

    const before = await fetch(`${baseUrl}/payment/71721?minorversion=65`, { headers }).then(r => r.json());
    const pmt = before.Payment;
    console.log('BEFORE:', JSON.stringify({ Id: pmt.Id, CustomerRef: pmt.CustomerRef, TotalAmt: pmt.TotalAmt, SyncToken: pmt.SyncToken, lines: (pmt.Line || []).length }));

    // Attempt full update (no sparse) with Line=[]
    const fullBody = { ...pmt, Line: [] };
    const r1 = await fetch(`${baseUrl}/payment?minorversion=65`, {
        method: 'POST', headers, body: JSON.stringify(fullBody),
    });
    const j1 = await r1.json();
    console.log('UNLINK status:', r1.status);
    if (j1?.Payment) {
        console.log('  Payment after unlink: TotalAmt=' + j1.Payment.TotalAmt, 'lines=' + (j1.Payment.Line || []).length, 'SyncToken=' + j1.Payment.SyncToken, 'UnappliedAmt=' + j1.Payment.UnappliedAmt);
    } else {
        console.log('  Error:', JSON.stringify(j1).slice(0, 400));
    }

    // Check invoice balance after unlink
    const invR = await fetch(`${baseUrl}/invoice/71233?minorversion=65`, { headers });
    const inv = (await invR.json())?.Invoice;
    console.log('  Invoice 71233 balance after unlink:', inv.Balance);

    // RELINK — full update payment with original lines
    if (j1?.Payment) {
        const relinkBody = { ...j1.Payment, Line: pmt.Line };
        const r2 = await fetch(`${baseUrl}/payment?minorversion=65`, {
            method: 'POST', headers, body: JSON.stringify(relinkBody),
        });
        const j2 = await r2.json();
        console.log('RELINK status:', r2.status);
        if (j2?.Payment) {
            console.log('  Payment after relink: TotalAmt=' + j2.Payment.TotalAmt, 'lines=' + (j2.Payment.Line || []).length);
        } else {
            console.log('  Error:', JSON.stringify(j2).slice(0, 400));
        }
        const invR2 = await fetch(`${baseUrl}/invoice/71233?minorversion=65`, { headers });
        console.log('  Invoice 71233 balance after relink:', (await invR2.json())?.Invoice?.Balance);
    }

    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
