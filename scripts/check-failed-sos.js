require('dotenv').config();
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');

const TARGETS = [
    { sn: 'SP-2604306S737HBE', soId: 1241 },
    { sn: 'SP-2604306RPTGHX5', soId: 1240 },
];

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    for (const t of TARGETS) {
        console.log(`\n━━━ ${t.sn} (SO ${t.soId}) ━━━`);
        const map = await JubelioOrderMap.findOne({ salesorder_id: t.soId }).lean();
        if (map) {
            console.log(`  QBO invoice_id   : ${map.qbo_invoice_id}`);
            console.log(`  last_status      : ${map.last_status}`);
            console.log(`  last_synced_at   : ${map.last_synced_at}`);
            console.log(`  last_payment_date: ${map.last_payment_date_raw || '-'}`);
        } else {
            console.log(`  ❌ NOT FOUND in JubelioOrderMap`);
        }
        const lastPayloads = await JubelioPayloadLog.find({ salesorder_id: t.soId, endpoint: 'pesanan' })
            .sort({ received_at: -1 })
            .limit(5)
            .select('received_at payload.status payload.action payload.grand_total')
            .lean();
        console.log(`  recent payloads (most recent first):`);
        for (const p of lastPayloads) {
            console.log(`    ${p.received_at?.toISOString?.() || p.received_at}  status=${p.payload?.status}  action=${p.payload?.action}  total=${p.payload?.grand_total}`);
        }
    }
    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
