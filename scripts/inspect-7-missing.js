// Investigate 7 orders user said aren't in QBO. For each:
//   1. Look up in JubelioOrderMap (maybe already synced)
//   2. Look up in JubelioPayloadLog (was webhook received?)
//   3. Pull from Jubelio API getOrderDetail (authoritative status + payment_date)
//   4. Decide: why not synced + can we fix it now

require('dotenv').config();
const mongoose = require('mongoose');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const JubelioOrderMap = require('../models/JubelioOrderMap');
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
    const realmId = process.env.QBO_REALM_ID || (await JubelioOrderMap.findOne())?.qbo_realm_id;

    for (const t of TARGETS) {
        console.log(`\n━━━ ${t.name} — ${t.sn}\n`);

        // 1. JubelioOrderMap (full + prefix match)
        const mapExact = await JubelioOrderMap.findOne({ salesorder_no: t.sn, qbo_realm_id: String(realmId) }).lean();
        const noSuffix = t.sn.replace(/-\d+$/, '');
        const mapPrefix = await JubelioOrderMap.findOne({
            salesorder_no: { $regex: '^' + noSuffix + '($|-\\d+$)' },
            qbo_realm_id: String(realmId),
        }).lean();
        const map = mapExact || mapPrefix;
        if (map) {
            console.log(`  ✓ FOUND in JubelioOrderMap`);
            console.log(`    qbo_invoice_id = ${map.qbo_invoice_id} (doc=${map.qbo_doc_number})`);
            console.log(`    last_status    = ${map.last_status}`);
            console.log(`    last_grand_total = ${fmt(map.last_grand_total)}`);
            console.log(`    last_synced_at = ${map.last_synced_at?.toISOString?.()}`);
        } else {
            console.log(`  ✗ NOT in JubelioOrderMap (any prefix variant)`);
        }

        // 2. JubelioPayloadLog
        const logs = await JubelioPayloadLog.find({
            salesorder_no: { $regex: '^' + noSuffix + '($|-\\d+$)' },
        }).sort({ received_at: 1 }).select('received_at status payload.payment_date payload.transaction_date payload.is_canceled payload.grand_total').lean();
        console.log(`  Webhook log entries: ${logs.length}`);
        for (const l of logs) {
            console.log(`    ${l.received_at?.toISOString?.()} status=${(l.status||'-').padEnd(12)} payment_date=${l.payload?.payment_date || '(null)'} transaction_date=${l.payload?.transaction_date || '(null)'}`);
        }

        // 3. Jubelio API getOrderDetail — authoritative
        if (jubelioApi.isConfigured()) {
            try {
                // Need salesorder_id. Try from log first; fallback to listing search.
                let soId = logs[0]?.salesorder_id;
                if (!soId && map) soId = map.salesorder_id;
                if (!soId) {
                    // Search via /sales/orders/ list with salesorder_no filter (if supported)
                    const search = await jubelioApi.apiGet('/sales/orders/', { salesorder_no: t.sn });
                    soId = (search?.data || search?.items)?.[0]?.salesorder_id;
                }
                if (!soId) {
                    // Last resort: use the noSuffix part — Jubelio internal id is in payload log usually
                    console.log(`    Jubelio API: no salesorder_id available — skipping detail fetch`);
                } else {
                    const detail = await jubelioApi.getOrderDetail(soId);
                    const so = detail?.data || detail;
                    console.log(`  Jubelio API getOrderDetail (id=${soId}):`);
                    console.log(`    status         = ${so?.status || '-'}`);
                    console.log(`    is_canceled    = ${so?.is_canceled}`);
                    console.log(`    payment_date   = ${so?.payment_date || '(null)'}`);
                    console.log(`    transaction_date = ${so?.transaction_date || '(null)'}`);
                    console.log(`    grand_total    = ${fmt(so?.grand_total)}`);
                    console.log(`    courier        = ${so?.courier || '-'}`);
                    console.log(`    tracking_no    = ${so?.tracking_no || '-'}`);
                    console.log(`    items          = ${(so?.items || []).length} item(s)`);
                }
            } catch (e) {
                console.log(`    Jubelio API error: ${e.message.slice(0, 200)}`);
            }
        }
    }

    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
