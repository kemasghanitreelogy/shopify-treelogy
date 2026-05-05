// v2 — verify the Jubelio side using BOTH:
//   (a) JubelioPayloadLog (webhook captures, TTL 30d)
//   (b) Jubelio API live pull (/sales/orders/ with status filter, authoritative)
// Then cross-check vs JubelioOrderMap (QBO synced state).

require('dotenv').config();
const mongoose = require('mongoose');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const jubelioApi = require('../services/jubelioApiService');

const TARGET_DAY = '2026-04-27';
const JKT_OFFSET_MS = (Number(process.env.JUBELIO_TZ_OFFSET_HOURS) || 8) * 60 * 60 * 1000;
const jktDay = (raw) => {
    if (!raw) return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() + JKT_OFFSET_MS).toISOString().substring(0, 10);
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);

    // ─── A: PAYLOAD LOG ──────────────────────────────────────────────────────
    const allLogs = await JubelioPayloadLog.find({ endpoint: 'pesanan' })
        .select('salesorder_no salesorder_id status source_name received_at payload.transaction_date payload.payment_date payload.created_date payload.is_canceled payload.grand_total')
        .lean();

    const logBySo = new Map();
    for (const l of allLogs) {
        const sn = l.salesorder_no;
        if (!sn) continue;
        const tx = l.payload?.transaction_date;
        const py = l.payload?.payment_date;
        const cr = l.payload?.created_date;
        // Match if ANY of (transaction_date | payment_date | created_date) lands on 27 Apr Jakarta
        const matches = [tx, py, cr].some(d => jktDay(d) === TARGET_DAY);
        if (!matches) continue;
        const cur = logBySo.get(sn) || { sn, statuses: new Set(), src: l.source_name, canceled: false, grand_total: l.payload?.grand_total, salesorder_id: l.salesorder_id, txn_jkt: jktDay(tx), pay_jkt: jktDay(py) };
        if (l.payload?.status) cur.statuses.add(String(l.payload.status).toUpperCase());
        if (l.payload?.is_canceled) cur.canceled = true;
        logBySo.set(sn, cur);
    }
    const logBySoTxnOnly = new Map([...logBySo.entries()].filter(([_, o]) => o.txn_jkt === TARGET_DAY));

    console.log(`\n━━━ A. JubelioPayloadLog (webhook captures, TTL 30d) ━━━\n`);
    console.log(`  Distinct SO with ANY of {txn,pay,created}_date Jakarta = ${TARGET_DAY}: ${logBySo.size}`);
    console.log(`  Distinct SO with transaction_date Jakarta = ${TARGET_DAY}:        ${logBySoTxnOnly.size}`);

    // ─── B: JUBELIO API live pull ────────────────────────────────────────────
    console.log(`\n━━━ B. Jubelio API live pull ━━━\n`);
    if (!jubelioApi.isConfigured()) {
        console.log('  Jubelio API not configured (no JUBELIO_API_USERNAME/PASSWORD) — skipping');
    } else {
        try {
            // Pull last few pages of /sales/orders (no status filter — get everything)
            // and filter client-side for transaction_date = TARGET_DAY
            const dateFromMinus1 = '2026-04-26';
            const all = await jubelioApi.apiGetPaged('/sales/orders/', { sortBy: 'transaction_date', sortDirection: 'desc' }, {
                pageSize: 100,
                maxPages: 30,
                until: (item) => {
                    const d = jktDay(item?.transaction_date);
                    return d && d < dateFromMinus1;
                }
            });
            console.log(`  Pulled ${all.length} order(s) from /sales/orders/ (sort=desc, until txn < ${dateFromMinus1})`);
            const onTarget = all.filter(o => jktDay(o.transaction_date) === TARGET_DAY);
            console.log(`  Filtered to transaction_date Jakarta = ${TARGET_DAY}: ${onTarget.length}`);
            const byStatus = {};
            const bySource = {};
            for (const o of onTarget) {
                const st = String(o.status || '-').toUpperCase();
                byStatus[st] = (byStatus[st] || 0) + 1;
                const src = o.source_name || '-';
                bySource[src] = (bySource[src] || 0) + 1;
            }
            console.log(`  by status:`);
            for (const [s, n] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) console.log(`    ${s.padEnd(12)} ${n}`);
            console.log(`  by source_name:`);
            for (const [s, n] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) console.log(`    ${s.padEnd(15)} ${n}`);

            // Diff: in API but NOT in payload log
            const apiSos = new Set(onTarget.map(o => o.salesorder_no));
            const logSos = new Set(logBySo.keys());
            const inApiNotLog = [...apiSos].filter(s => !logSos.has(s));
            const inLogNotApi = [...logSos].filter(s => !apiSos.has(s));
            console.log(`\n  In Jubelio API but NOT in payload log: ${inApiNotLog.length}`);
            for (const sn of inApiNotLog.slice(0, 20)) {
                const o = onTarget.find(x => x.salesorder_no === sn);
                console.log(`    ${sn.padEnd(35)} status=${(o.status||'-').padEnd(12)} source=${(o.source_name||'-').padEnd(15)} grand_total=Rp ${(o.grand_total||0).toLocaleString('id-ID')}`);
            }
            if (inApiNotLog.length > 20) console.log(`    ... and ${inApiNotLog.length - 20} more`);
            console.log(`\n  In payload log but NOT in API result: ${inLogNotApi.length}`);
            for (const sn of inLogNotApi.slice(0, 10)) {
                const o = logBySo.get(sn);
                console.log(`    ${sn.padEnd(35)} statuses=[${[...o.statuses].sort().join(',')}] src=${(o.src||'-').padEnd(12)}`);
            }

            // ─── Cross-ref API vs QBO map ──────────────────────────────────────
            const realmId = process.env.QBO_REALM_ID || (await JubelioOrderMap.findOne())?.qbo_realm_id;
            const allMaps = await JubelioOrderMap.find({ qbo_realm_id: String(realmId) })
                .select('salesorder_no salesorder_id last_status').lean();
            const mapBySoNoPrefix = new Map();
            const mapBySoId = new Map();
            for (const m of allMaps) {
                const noPrefix = String(m.salesorder_no || '').replace(/-\d+$/, '');  // strip -store_id suffix
                if (noPrefix) mapBySoNoPrefix.set(noPrefix, m);
                if (m.salesorder_id) mapBySoId.set(m.salesorder_id, m);
            }
            const inApiNotQbo = onTarget.filter(o => !mapBySoNoPrefix.has(o.salesorder_no) && !mapBySoId.has(o.salesorder_id));
            console.log(`\n━━━ MATCH (API vs QBO map) ━━━`);
            console.log(`  Jubelio API on ${TARGET_DAY}: ${onTarget.length}`);
            console.log(`  In QBO map (any status):     ${onTarget.length - inApiNotQbo.length}`);
            console.log(`  NOT in QBO map:              ${inApiNotQbo.length}`);
            if (inApiNotQbo.length) {
                console.log(`\n  Orders not synced to QBO (sample):`);
                for (const o of inApiNotQbo.slice(0, 30)) {
                    console.log(`    ${o.salesorder_no.padEnd(35)} status=${(o.status||'-').padEnd(12)} source=${(o.source_name||'-').padEnd(15)} grand_total=Rp ${(o.grand_total||0).toLocaleString('id-ID')} payment_date=${o.payment_date || '(null)'}`);
                }
                if (inApiNotQbo.length > 30) console.log(`    ... and ${inApiNotQbo.length - 30} more`);
            }
        } catch (e) {
            console.error(`  Jubelio API error: ${e.message.slice(0, 300)}`);
        }
    }

    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
