// For each HAS_PAYLOAD_LOG orphan, check whether a JubelioOrderMap entry
// exists for the same salesorder_id (via the payload log's salesorder_id).
// If yes → race-condition duplicate (the orphan invoice was a "loser" of a
// concurrent map.create race; map points to a sibling invoice).
// If no  → genuine missing-map (some other bug).

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const JubelioOrderMap = require('../models/JubelioOrderMap');

const v2File = process.argv[2];
const fmt = (n) => (n || 0).toLocaleString('id-ID');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const data = JSON.parse(fs.readFileSync(v2File, 'utf-8'));
    const realmId = process.env.QBO_REALM_ID || (await JubelioOrderMap.findOne())?.qbo_realm_id;
    const hasLog = data.filter(r => r.payloadLogCount > 0);

    console.log(`\nDUPLICATE-INVOICE CHECK  ${hasLog.length} orphans with payload log\n`);

    let raceCount = 0;
    let trueOrphan = 0;
    const races = [];
    const trueOrphans = [];

    for (const r of hasLog) {
        // Get salesorder_id from latest payload log
        const log = await JubelioPayloadLog.findOne({ salesorder_no: r.latestSalesorderNo })
            .sort({ received_at: -1 })
            .select('salesorder_id salesorder_no')
            .lean();
        const soId = log?.salesorder_id || r.latestSalesorderId;

        if (!soId) {
            trueOrphans.push({ ...r, _reason: 'no_salesorder_id_in_log' });
            trueOrphan++;
            continue;
        }

        const map = await JubelioOrderMap.findOne({
            salesorder_id: soId,
            qbo_realm_id: String(realmId),
        }).lean();

        if (map && String(map.qbo_invoice_id) !== String(r.invoiceId)) {
            // RACE: map points to a different (winner) invoice
            races.push({
                ...r,
                salesorder_id: soId,
                winnerInvoiceId: map.qbo_invoice_id,
                winnerDocNumber: map.qbo_doc_number,
                winnerStatus: map.last_status,
                winnerSyncedAt: map.last_synced_at,
            });
            raceCount++;
        } else if (!map) {
            trueOrphans.push({ ...r, salesorder_id: soId, _reason: 'no_map_entry_at_all' });
            trueOrphan++;
        } else {
            // map exists and points to THIS invoice — but our cross-ref said no map?
            // Edge case — earlier cross-ref used salesorder_no lookup which might miss
            // due to suffix. Re-categorize.
            races.push({ ...r, salesorder_id: soId, winnerInvoiceId: map.qbo_invoice_id, winnerStatus: map.last_status, _reason: 'map_does_exist_via_id' });
        }
    }

    console.log(`  RACE_DUPLICATE (map points to sibling invoice): ${raceCount}  sum_balance=Rp ${fmt(races.reduce((s, r) => s + r.balance, 0))}`);
    console.log(`  TRUE_ORPHAN  (no map by salesorder_id either):   ${trueOrphan}  sum_balance=Rp ${fmt(trueOrphans.reduce((s, r) => s + r.balance, 0))}`);
    console.log();

    if (races.length) {
        console.log(`  RACE_DUPLICATE sample:`);
        for (const r of races.slice(0, 15)) {
            console.log(`    orphan inv=${r.invoiceId.padStart(6)} doc=${r.docNumber.padEnd(28)} so_id=${r.salesorder_id} → winner inv=${String(r.winnerInvoiceId).padStart(6)} winner_doc=${r.winnerDocNumber} winner_status=${r.winnerStatus}  ${r._reason || ''}`);
        }
        if (races.length > 15) console.log(`    ... and ${races.length - 15} more`);
        console.log();
    }

    if (trueOrphans.length) {
        console.log(`  TRUE_ORPHAN sample:`);
        for (const r of trueOrphans.slice(0, 15)) {
            console.log(`    inv=${r.invoiceId.padStart(6)} doc=${r.docNumber.padEnd(28)} so_id=${r.salesorder_id || '?'}  reason=${r._reason}`);
        }
        if (trueOrphans.length > 15) console.log(`    ... and ${trueOrphans.length - 15} more`);
        console.log();
    }

    const outFile = v2File.replace('.json', '-dupcheck.json');
    fs.writeFileSync(outFile, JSON.stringify({ races, trueOrphans }, null, 2));
    console.log(`output: ${outFile}`);

    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
