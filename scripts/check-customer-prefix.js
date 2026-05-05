require('dotenv').config();
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const JubelioCustomerMap = require('../models/JubelioCustomerMap');

const TARGETS = ['TP-583762709849605516', 'WS-CD5CAH47UYQUJS4ARZ'];

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    for (const sn of TARGETS) {
        console.log(`\n━━━ ${sn} ━━━`);
        let m = await JubelioOrderMap.findOne({ salesorder_no: sn }).lean();
        if (!m) {
            m = await JubelioOrderMap.findOne({ salesorder_no: { $regex: '^' + sn } }).lean();
            if (!m) { console.log('  ❌ NOT FOUND in JubelioOrderMap'); continue; }
            console.log(`  (partial match: ${m.salesorder_no})`);
        }
        console.log(`  qbo_invoice_id   : ${m.qbo_invoice_id}`);
        console.log(`  qbo_customer_id  : ${m.qbo_customer_id || '(not stored)'}`);
        console.log(`  last_status      : ${m.last_status}`);
        console.log(`  last_synced_at   : ${m.last_synced_at}`);

        const log = await JubelioPayloadLog.findOne({
            salesorder_no: { $regex: '^' + sn.replace(/-\d+$/, '') },
            endpoint: 'pesanan',
        }).sort({ received_at: -1 }).lean();
        if (log?.payload) {
            const p = log.payload;
            console.log(`  payload.source_name      : ${p.source_name || '(missing)'}`);
            console.log(`  payload.buyer_id         : ${p.buyer_id || '(missing)'}`);
            console.log(`  payload.customer_name    : ${p.customer_name || '(missing)'}`);
            console.log(`  payload.customer_email   : ${p.customer_email || '(missing)'}`);
            console.log(`  payload.shipping_name    : ${p.shipping_full_name || '(missing)'}`);

            // Check JubelioCustomerMap
            if (p.source_name && p.buyer_id) {
                const cmap = await JubelioCustomerMap.findOne({
                    source: String(p.source_name).toUpperCase().trim(),
                    buyer_id: String(p.buyer_id).trim(),
                }).lean();
                if (cmap) {
                    console.log(`  📍 JubelioCustomerMap match: qbo_customer_id=${cmap.qbo_customer_id}, last_jubelio_name="${cmap.last_customer_name_jubelio || '-'}"`);
                    console.log(`     created: ${cmap.created_at || cmap.createdAt}`);
                } else {
                    console.log(`  📍 JubelioCustomerMap: NO match for (${p.source_name}, ${p.buyer_id})`);
                }
            }
        }
    }
    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
