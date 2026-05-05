// Quick check: did these SO numbers eventually sync to QBO?
require('dotenv').config();
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const { getQboInstance } = require('../services/qboService');

const SO_NUMBERS = process.argv.slice(2);
if (!SO_NUMBERS.length) { console.error('usage: node scripts/check-so-sync.js SO1 SO2 ...'); process.exit(1); }

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    const fmt = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID')}`;

    for (const sn of SO_NUMBERS) {
        console.log(`\n━━━ ${sn} ━━━`);
        const map = await JubelioOrderMap.findOne({ salesorder_no: sn }).lean();
        if (!map) { console.log(`  ❌ NOT in JubelioOrderMap — never synced`); continue; }
        console.log(`  ✓ In Mongo: qbo_invoice_id=${map.qbo_invoice_id} status=${map.last_status} grandTotal=${fmt(map.last_grand_total)}`);
        console.log(`    last_synced_at=${map.last_synced_at || 'n/a'} payment_date=${map.last_payment_date_raw || 'n/a'}`);

        if (!map.qbo_invoice_id) { console.log(`  ⚠️ No qbo_invoice_id — sync incomplete`); continue; }

        const url = `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}/invoice/${map.qbo_invoice_id}?minorversion=${qbo.minorversion || '65'}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' } });
        const body = await res.json();
        const inv = body?.Invoice;
        if (!inv) { console.log(`  ❌ QBO Invoice ${map.qbo_invoice_id} not found (${res.status})`); continue; }
        console.log(`  ✓ QBO Invoice ${inv.Id}: TotalAmt=${fmt(inv.TotalAmt)} Balance=${fmt(inv.Balance)} TxnDate=${inv.TxnDate} DocNumber=${inv.DocNumber}`);
        console.log(`    MetaData.LastUpdatedTime=${inv.MetaData?.LastUpdatedTime}`);
    }
    await mongoose.disconnect();
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
