// For each NOT_IN_MAP invoice from cross-ref output, look up
// JubelioPayloadLog (TTL 30d) to determine whether webhook ever fired.
//
// Two outcomes per invoice:
//   HAS_PAYLOAD_LOG  — webhook arrived in last 30d; either map.create silently
//                      failed OR map.create never reached this code path.
//                      Surface the latest payload + status.
//   NO_PAYLOAD_LOG   — no inbound webhook record. Invoice was created some
//                      other way: manual finance entry, import script,
//                      pre-30d-window webhook (unlikely since invoices are
//                      all April 2026 and TTL is 30d).

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');

const enrichedFile = process.argv[2];
if (!enrichedFile) { console.error('usage: node scripts/cross-ref-payload-log.js <cross-ref-json>'); process.exit(1); }

const fmt = (n) => (n || 0).toLocaleString('id-ID');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const enriched = JSON.parse(fs.readFileSync(enrichedFile, 'utf-8'));
    const orphans = enriched.filter(r => r.jubelio_status === '__NOT_IN_MAP__');

    console.log(`\nPAYLOAD-LOG CROSS-REF  ${orphans.length} orphan invoices\n`);

    const out = [];
    for (const r of orphans) {
        const logs = await JubelioPayloadLog.find({ salesorder_no: r.docNumber })
            .sort({ received_at: -1 })
            .limit(5)
            .lean();
        const latest = logs[0];
        out.push({
            ...r,
            payloadLogCount: logs.length,
            latestPayloadStatus: latest?.status,
            latestPayloadAction: latest?.action,
            latestPayloadEndpoint: latest?.endpoint,
            latestReceivedAt: latest?.received_at,
            distinctStatuses: [...new Set(logs.map(l => l.status))],
        });
    }

    const hasLog = out.filter(r => r.payloadLogCount > 0);
    const noLog = out.filter(r => r.payloadLogCount === 0);

    console.log(`SUMMARY:`);
    console.log(`  HAS_PAYLOAD_LOG  count=${hasLog.length}  sum_balance=Rp ${fmt(hasLog.reduce((s, r) => s + r.balance, 0))}`);
    console.log(`  NO_PAYLOAD_LOG   count=${noLog.length}  sum_balance=Rp ${fmt(noLog.reduce((s, r) => s + r.balance, 0))}`);
    console.log();

    if (hasLog.length) {
        // Distribute by status
        const byStatus = {};
        for (const r of hasLog) {
            const k = r.latestPayloadStatus || '<null>';
            byStatus[k] = (byStatus[k] || 0) + 1;
        }
        console.log(`  HAS_PAYLOAD_LOG by latest status:`);
        for (const [s, c] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
            console.log(`    ${s.padEnd(20)} ${c}`);
        }
        console.log();

        console.log(`  Sample (first 15 with HAS_PAYLOAD_LOG):`);
        for (const r of hasLog.slice(0, 15)) {
            console.log(`    ${r.docNumber.padEnd(28)} inv=${String(r.invoiceId).padStart(6)} latest_status=${(r.latestPayloadStatus || '-').padEnd(12)} action=${(r.latestPayloadAction || '-').padEnd(20)} received=${r.latestReceivedAt?.toISOString?.().slice(0, 19)}  logs=${r.payloadLogCount}`);
        }
        if (hasLog.length > 15) console.log(`    ... and ${hasLog.length - 15} more`);
        console.log();
    }

    if (noLog.length) {
        console.log(`  Sample (first 15 with NO_PAYLOAD_LOG):`);
        for (const r of noLog.slice(0, 15)) {
            console.log(`    ${r.docNumber.padEnd(28)} inv=${String(r.invoiceId).padStart(6)} total=Rp ${fmt(r.totalAmt)} txnDate=${r.txnDate}`);
        }
        if (noLog.length > 15) console.log(`    ... and ${noLog.length - 15} more`);
        console.log();
    }

    const outFile = enrichedFile.replace('.json', '-payload-log.json');
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    console.log(`output: ${outFile}`);

    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
