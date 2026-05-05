// Pull current state from Jubelio API for the 7 orders to confirm if they're
// actually PAID (escrow funded) vs other interpretations of payment_date.

require('dotenv').config();
const mongoose = require('mongoose');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const jubelioApi = require('../services/jubelioApiService');

const TARGETS = [
    { name: 'Rika Handayani', sn: 'TT-583723198772971284-128883' },
    { name: 'Jumi Hermawan',  sn: 'TP-583723447859578139-128884' },
    { name: 'Linda Wati',     sn: 'TP-583724404254345152-128884' },
    { name: 'Jessica',        sn: 'TP-583724559724611293-128884' },
    { name: 'Ayu',            sn: 'TP-583724730439599589-128884' },
    { name: 'Sonta',          sn: 'TP-583727120659285310-128884' },
    { name: 'Ie Hue Chen',    sn: 'TP-583728509226681614-128884' },
];

const fmt = (n) => `Rp ${(n || 0).toLocaleString('id-ID')}`;

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);

    // Get salesorder_id from payload log for each
    for (const t of TARGETS) {
        const noSuffix = t.sn.replace(/-\d+$/, '');
        const log = await JubelioPayloadLog.findOne({
            salesorder_no: { $regex: '^' + noSuffix },
        }).select('salesorder_id payload.salesorder_id').lean();
        t.salesorder_id = log?.salesorder_id || log?.payload?.salesorder_id;
    }

    console.log(`\nPulling current state from Jubelio API (authoritative)\n`);

    for (const t of TARGETS) {
        if (!t.salesorder_id) {
            console.log(`  ${t.name.padEnd(20)} ${t.sn}  → NO salesorder_id found`);
            continue;
        }
        try {
            const detail = await jubelioApi.getOrderDetail(t.salesorder_id);
            const so = detail?.data || detail;
            console.log(`━━━ ${t.name.padEnd(20)} (${t.sn})`);
            console.log(`    Jubelio salesorder_id  = ${t.salesorder_id}`);
            console.log(`    status                 = ${so?.status || '-'}`);
            console.log(`    is_canceled            = ${so?.is_canceled}`);
            console.log(`    payment_date           = ${so?.payment_date || '(null)'}`);
            console.log(`    transaction_date       = ${so?.transaction_date || '(null)'}`);
            console.log(`    grand_total            = ${fmt(so?.grand_total)}`);
            console.log(`    courier                = ${so?.courier || '-'}`);
            console.log(`    tracking_no            = ${so?.tracking_no || '-'}`);
            console.log(`    shipped_date           = ${so?.shipped_date || '(null)'}`);
            // Tokopedia/Shopee specific payment status fields if any
            if (so?.payment_status) console.log(`    payment_status         = ${so.payment_status}`);
            if (so?.is_paid !== undefined) console.log(`    is_paid                = ${so.is_paid}`);
            console.log();
        } catch (e) {
            console.log(`  ${t.name}: API error: ${e.message.slice(0, 200)}`);
        }
    }

    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
