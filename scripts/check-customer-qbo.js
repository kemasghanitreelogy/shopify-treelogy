require('dotenv').config();
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');
const JubelioOrderMap = require('../models/JubelioOrderMap');

const TARGETS = [
    { sn: 'TP-583762709849605516', map_buyer_id: '7495927243750083180', map_source: 'TOKOPEDIA' },
    { sn: 'WS-CD5CAH47UYQUJS4ARZ' },
];

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    const baseUrl = `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;

    // Also peek at the alternate customer the map points to
    const extraIds = ['14656'];
    for (const cid of extraIds) {
        const cr = await fetch(`${baseUrl}/customer/${cid}?minorversion=65`, {
            headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' },
        });
        const cust = (await cr.json())?.Customer;
        console.log(`\n━━━ Extra customer ${cid} ━━━`);
        if (cust) {
            console.log(`  DisplayName: "${cust.DisplayName}"  Active=${cust.Active}`);
            console.log(`  created=${cust.MetaData?.CreateTime}  updated=${cust.MetaData?.LastUpdatedTime}`);
        } else {
            console.log('  not found');
        }
    }

    for (const t of TARGETS) {
        console.log(`\n━━━ ${t.sn} ━━━`);
        const m = await JubelioOrderMap.findOne({ salesorder_no: { $regex: '^' + t.sn } }).lean();
        if (!m) { console.log('  no order map'); continue; }
        const r = await fetch(`${baseUrl}/invoice/${m.qbo_invoice_id}?minorversion=65`, {
            headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' },
        });
        const inv = (await r.json())?.Invoice;
        if (!inv) { console.log('  invoice not found'); continue; }
        const custId = inv.CustomerRef?.value;
        const custName = inv.CustomerRef?.name;
        console.log(`  invoice ${m.qbo_invoice_id}: CustomerRef.value=${custId} name="${custName}"`);

        const cr = await fetch(`${baseUrl}/customer/${custId}?minorversion=65`, {
            headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' },
        });
        const cust = (await cr.json())?.Customer;
        if (!cust) { console.log('  customer record not found'); continue; }
        console.log(`  Customer.Id          : ${cust.Id}`);
        console.log(`  Customer.DisplayName : "${cust.DisplayName}"`);
        console.log(`  Customer.GivenName   : "${cust.GivenName || '-'}"`);
        console.log(`  Customer.FamilyName  : "${cust.FamilyName || '-'}"`);
        console.log(`  Customer.PrimaryEmail: ${cust.PrimaryEmailAddr?.Address || '-'}`);
        console.log(`  Customer.MetaData    : created=${cust.MetaData?.CreateTime}, updated=${cust.MetaData?.LastUpdatedTime}`);
    }
    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
