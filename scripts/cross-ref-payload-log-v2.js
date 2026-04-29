// v2 — match JubelioPayloadLog using SO# PREFIX (Tokopedia/TT logs use
// `{docNumber}-{store_id}` format while QBO DocNumber omits the store suffix).

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');

const enrichedFile = process.argv[2];
const fmt = (n) => (n || 0).toLocaleString('id-ID');
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const enriched = JSON.parse(fs.readFileSync(enrichedFile, 'utf-8'));
    const orphans = enriched.filter(r => r.jubelio_status === '__NOT_IN_MAP__');

    console.log(`\nPAYLOAD-LOG CROSS-REF v2  ${orphans.length} orphan invoices  (prefix match)\n`);

    const out = [];
    for (const r of orphans) {
        // Match either exact or prefix (with optional -{suffix})
        const re = new RegExp('^' + escapeRegex(r.docNumber) + '(-\\d+)?$');
        const logs = await JubelioPayloadLog.find({ salesorder_no: { $regex: re } })
            .sort({ received_at: -1 })
            .limit(10)
            .lean();
        const latest = logs[0];
        out.push({
            ...r,
            payloadLogCount: logs.length,
            latestPayloadStatus: latest?.status,
            latestPayloadAction: latest?.action,
            latestSourceName: latest?.source_name,
            latestSalesorderNo: latest?.salesorder_no,
            latestSalesorderId: latest?.salesorder_id,
            latestReceivedAt: latest?.received_at,
            distinctStatuses: [...new Set(logs.map(l => l.status))].sort(),
        });
    }

    const hasLog = out.filter(r => r.payloadLogCount > 0);
    const noLog = out.filter(r => r.payloadLogCount === 0);

    console.log(`SUMMARY:`);
    console.log(`  HAS_PAYLOAD_LOG  count=${hasLog.length}  sum_balance=Rp ${fmt(hasLog.reduce((s, r) => s + r.balance, 0))}`);
    console.log(`  NO_PAYLOAD_LOG   count=${noLog.length}  sum_balance=Rp ${fmt(noLog.reduce((s, r) => s + r.balance, 0))}`);
    console.log();

    if (hasLog.length) {
        const byLatestStatus = {};
        for (const r of hasLog) {
            const k = r.latestPayloadStatus || '<null>';
            byLatestStatus[k] = (byLatestStatus[k] || 0) + 1;
        }
        console.log(`  HAS_PAYLOAD_LOG by latest status:`);
        for (const [s, c] of Object.entries(byLatestStatus).sort((a, b) => b[1] - a[1])) {
            console.log(`    ${s.padEnd(20)} ${c}`);
        }
        console.log();

        // Of those with logs — categorize: (a) ever had COMPLETED/PAID? (b) only SHIPPED
        const everCompletedPaid = hasLog.filter(r =>
            r.distinctStatuses.some(s => /^(COMPLETED|PAID)$/i.test(s || ''))
        );
        const onlyEarlier = hasLog.filter(r =>
            !r.distinctStatuses.some(s => /^(COMPLETED|PAID)$/i.test(s || ''))
        );
        console.log(`  EVER COMPLETED/PAID (= should have Payment): ${everCompletedPaid.length}  sum_balance=Rp ${fmt(everCompletedPaid.reduce((s, r) => s + r.balance, 0))}`);
        console.log(`  ONLY EARLIER STATUS (legitimate unpaid):     ${onlyEarlier.length}`);
        console.log();

        if (everCompletedPaid.length) {
            console.log(`  ⚠️  COMPLETED/PAID but no Payment in QBO (BUG candidates) — sample:`);
            for (const r of everCompletedPaid.slice(0, 15)) {
                console.log(`    ${r.docNumber.padEnd(28)} inv=${String(r.invoiceId).padStart(6)} latest=${(r.latestPayloadStatus||'-').padEnd(10)} statuses=[${r.distinctStatuses.join(',')}] logs=${r.payloadLogCount} latest_so_no=${r.latestSalesorderNo}`);
            }
            if (everCompletedPaid.length > 15) console.log(`    ... and ${everCompletedPaid.length - 15} more`);
        }
        console.log();
    }

    if (noLog.length) {
        console.log(`  NO_PAYLOAD_LOG sample (first 10):`);
        for (const r of noLog.slice(0, 10)) {
            console.log(`    ${r.docNumber.padEnd(28)} inv=${String(r.invoiceId).padStart(6)} total=Rp ${fmt(r.totalAmt)} txn=${r.txnDate}`);
        }
        if (noLog.length > 10) console.log(`    ... and ${noLog.length - 10} more`);
    }

    const outFile = enrichedFile.replace('.json', '-payload-log-v2.json');
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    console.log(`\noutput: ${outFile}`);

    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
