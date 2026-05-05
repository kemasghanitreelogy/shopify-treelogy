// Compare PAID orders dated 2026-04-27 between Jubelio (source of truth via
// payload log + live API) and QBO (synced state via JubelioOrderMap).
//
// "tanggal 27" = 2026-04-27 Jakarta day, filtered on transaction_date.
//
// Read-only.

require('dotenv').config();
const mongoose = require('mongoose');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const jubelioApi = require('../services/jubelioApiService');
const { getQboInstance } = require('../services/qboService');

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

    // ─── Source A: JubelioPayloadLog (webhook captures, TTL 30d) ─────────────
    // Distinct salesorder_no where ANY captured webhook for it had status PAID
    // (or PAID+ statuses: PAID, SHIPPED, COMPLETED — once paid, status only
    // moves forward) AND transaction_date Jakarta-day = TARGET_DAY.
    const allLogs = await JubelioPayloadLog.find({
        endpoint: 'pesanan',
        'payload.transaction_date': { $exists: true, $ne: null },
    })
        .select('salesorder_no status payload.transaction_date payload.status payload.is_canceled payload.grand_total payload.source_name')
        .lean();

    const bySo = new Map();
    for (const log of allLogs) {
        const txn = log.payload?.transaction_date;
        if (jktDay(txn) !== TARGET_DAY) continue;
        const sn = log.salesorder_no;
        const cur = bySo.get(sn) || { sn, statuses: new Set(), src: log.payload?.source_name, canceled: false, grand_total: log.payload?.grand_total };
        if (log.payload?.status) cur.statuses.add(String(log.payload.status).toUpperCase());
        if (log.payload?.is_canceled) cur.canceled = true;
        bySo.set(sn, cur);
    }

    const PAID_OR_BEYOND = ['PAID', 'SHIPPED', 'COMPLETED'];
    const paidOrders = [...bySo.values()].filter(o =>
        !o.canceled && PAID_OR_BEYOND.some(s => o.statuses.has(s))
    );

    console.log(`\n━━━ Jubelio (via payload log) — orders with transaction_date=${TARGET_DAY}\n`);
    console.log(`  total distinct SO ............ ${bySo.size}`);
    console.log(`  PAID/SHIPPED/COMPLETED ....... ${paidOrders.length}`);
    console.log(`  by latest-state (status set):`);
    const stateSummary = {};
    for (const o of paidOrders) {
        // Pick the "highest" status reached
        const order = ['COMPLETED', 'SHIPPED', 'PROCESSING', 'PAID', 'INVOICED', 'PENDING'];
        const top = order.find(s => o.statuses.has(s)) || '-';
        stateSummary[top] = (stateSummary[top] || 0) + 1;
    }
    for (const [s, n] of Object.entries(stateSummary).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${s.padEnd(12)} ${n}`);
    }
    console.log(`  by source_name:`);
    const srcSummary = {};
    for (const o of paidOrders) srcSummary[o.src || '-'] = (srcSummary[o.src || '-'] || 0) + 1;
    for (const [s, n] of Object.entries(srcSummary).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${s.padEnd(15)} ${n}`);
    }

    // ─── Source B: JubelioOrderMap (synced state to QBO) ──────────────────────
    // Use last_txn_date which is computed Jakarta-day from payment_date or
    // transaction_date during webhook processing.
    const realmId = process.env.QBO_REALM_ID || (await JubelioOrderMap.findOne())?.qbo_realm_id;
    const synced = await JubelioOrderMap.find({
        last_txn_date: TARGET_DAY,
        qbo_realm_id: String(realmId),
    })
        .select('salesorder_no salesorder_id last_status last_grand_total qbo_invoice_id qbo_doc_number')
        .lean();

    console.log(`\n━━━ QBO (via JubelioOrderMap) — last_txn_date=${TARGET_DAY}\n`);
    console.log(`  total synced ................. ${synced.length}`);
    const mapStatusSummary = {};
    for (const m of synced) mapStatusSummary[m.last_status || '-'] = (mapStatusSummary[m.last_status || '-'] || 0) + 1;
    for (const [s, n] of Object.entries(mapStatusSummary).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${s.padEnd(12)} ${n}`);
    }

    // ─── Diff ────────────────────────────────────────────────────────────────
    const syncedSoNos = new Set(synced.map(m => String(m.salesorder_no || '')));
    // Match with prefix (TP/TT salesorder_no in map has -{store_id} suffix vs payload)
    const matchedJubelioOrders = paidOrders.filter(o => {
        for (const m of syncedSoNos) {
            if (m === o.sn || m.startsWith(o.sn + '-') || o.sn.startsWith(m + '-')) return true;
        }
        return false;
    });
    const unmatchedJubelio = paidOrders.filter(o => !matchedJubelioOrders.includes(o));

    console.log(`\n━━━ MATCH\n`);
    console.log(`  Jubelio PAID/+ on ${TARGET_DAY} ........ ${paidOrders.length}`);
    console.log(`  Synced to QBO (any status) ............ ${synced.length}`);
    console.log(`  Matched (Jubelio ↔ QBO) ............... ${matchedJubelioOrders.length}`);
    console.log(`  In Jubelio but NOT in QBO ............. ${unmatchedJubelio.length}`);
    if (unmatchedJubelio.length) {
        console.log(`\n  Unmatched (in Jubelio paid, not synced to QBO):`);
        for (const o of unmatchedJubelio.slice(0, 30)) {
            console.log(`    ${o.sn.padEnd(30)} src=${(o.src || '-').padEnd(12)} statuses=[${[...o.statuses].sort().join(',')}] grand_total=Rp ${(o.grand_total || 0).toLocaleString('id-ID')}`);
        }
        if (unmatchedJubelio.length > 30) console.log(`    ... and ${unmatchedJubelio.length - 30} more`);
    }

    // QBO orders not in our payload-log paid set (likely synced earlier or from older webhook)
    const jubelioSet = new Set(paidOrders.map(o => o.sn));
    const qboNotInJubelioPaid = synced.filter(m => {
        const mNo = String(m.salesorder_no || '');
        for (const sn of jubelioSet) {
            if (sn === mNo || mNo.startsWith(sn + '-') || sn.startsWith(mNo + '-')) return false;
        }
        return true;
    });
    if (qboNotInJubelioPaid.length) {
        console.log(`\n  In QBO (last_txn_date=${TARGET_DAY}) but no recent PAID webhook in payload log:`);
        for (const m of qboNotInJubelioPaid.slice(0, 15)) {
            console.log(`    ${m.salesorder_no.padEnd(35)} status=${(m.last_status || '-').padEnd(12)} qbo_inv=${m.qbo_invoice_id} grand_total=Rp ${(m.last_grand_total || 0).toLocaleString('id-ID')}`);
        }
        if (qboNotInJubelioPaid.length > 15) console.log(`    ... and ${qboNotInJubelioPaid.length - 15} more`);
        console.log(`\n  (These were likely synced via older webhooks — payload log TTL is 30d so they're still tracked in JubelioOrderMap.)`);
    }

    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
