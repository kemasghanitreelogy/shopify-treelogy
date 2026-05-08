// Scan invoices that were written with WIB (UTC+7) during the brief
// 2026-05-06 → 2026-05-08 cutover window and need re-dating to UTC+8.
//
// Read-only. Apply via separate fix script (not yet built — pending review
// of this scan output).
//
// Window: invoices with last_synced_at >= 2026-05-06T03:30Z (commit 06eb978
// deploy) and last_synced_at <= 2026-05-08T03:50Z (commit dd50156 deploy).
// Adjustable via --since and --until flags.
//
// For each candidate map:
//   raw      = last_payment_date_raw || last_transaction_date_raw
//   utc8Date = toQboTxnDate(raw)  (+8h, current canonical)
//   wibDate  = toWibDate(raw)     (+7h, what cutover wrote)
//   Skip if utc8Date === wibDate (no boundary, no shift)
//   Read QBO Invoice.TxnDate
//   Classify:
//     - inv.TxnDate === utc8Date → already correct (no fix needed)
//     - inv.TxnDate === wibDate  → CANDIDATE (was WIB, should be UTC+8)
//     - inv.TxnDate ≠ map.last_txn_date → finance manually edited (DO NOT TOUCH)
//     - else → unrelated drift (separate issue)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const { toQboTxnDate, toWibDate } = require('../lib/jubelioTime');

const args = process.argv.slice(2);
const val = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : null; };

const SINCE = val('since') || '2026-05-06T03:30:00.000Z'; // commit 06eb978 deploy
const UNTIL = val('until') || '2026-05-08T03:50:00.000Z'; // commit dd50156 deploy
const CHANNEL = (val('channel') || '').toUpperCase();
const LIMIT = Number(val('limit')) || 0;

const getInvoice = (qbo, id) => new Promise((res) =>
    qbo.getInvoice(id, (e, b) => e ? res({ err: String(e.message || e).slice(0, 200) }) : res({ inv: b }))
);

const channelOf = (no) => (String(no || '').match(/^([A-Z]{2,5})-/) || [])[1] || '';

const auditDir = path.join(process.cwd(), 'audit-logs');
fs.mkdirSync(auditDir, { recursive: true });
const auditPath = path.join(auditDir, `scan-wib-window-drift-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
const auditStream = fs.createWriteStream(auditPath, { flags: 'a' });
const audit = (rec) => auditStream.write(JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    console.log(`🔎 Scan WIB-window drift`);
    console.log(`   window:  ${SINCE} → ${UNTIL}`);
    console.log(`   channel: ${CHANNEL || 'ALL'}`);
    console.log(`   limit:   ${LIMIT || 'none'}`);
    console.log(`   audit:   ${auditPath}\n`);

    const filter = {
        qbo_invoice_id: { $exists: true, $ne: null },
        last_synced_at: { $gte: new Date(SINCE), $lte: new Date(UNTIL) },
        $or: [
            { last_payment_date_raw: { $exists: true, $ne: null } },
            { last_transaction_date_raw: { $exists: true, $ne: null } },
        ],
    };
    const rows = await JubelioOrderMap.find(filter)
        .select('salesorder_no qbo_invoice_id last_payment_date_raw last_transaction_date_raw last_txn_date last_synced_at')
        .sort({ last_synced_at: 1 })
        .lean();
    console.log(`📦 Maps in window: ${rows.length}`);

    const stats = {
        scanned: 0,
        skipped_channel: 0,
        skipped_no_boundary: 0,
        skipped_qbo_404: 0,
        already_correct_utc8: 0,
        finance_edited: 0,
        unrelated_drift: 0,
        candidates: 0,
    };
    const candidates = [];
    const financeEdits = [];
    const unrelated = [];

    for (const r of rows) {
        if (LIMIT && stats.scanned >= LIMIT) break;
        stats.scanned++;
        const ch = channelOf(r.salesorder_no);
        if (CHANNEL && ch !== CHANNEL) { stats.skipped_channel++; continue; }

        const raw = r.last_payment_date_raw || r.last_transaction_date_raw;
        const utc8 = toQboTxnDate(raw);
        const wib = toWibDate(raw);

        if (!utc8 || !wib) { stats.skipped_no_boundary++; continue; }
        if (utc8 === wib) { stats.skipped_no_boundary++; continue; } // no boundary case — no shift

        const { inv, err } = await getInvoice(qbo, r.qbo_invoice_id);
        if (err) { stats.skipped_qbo_404++; audit({ event: 'qbo_404', so: r.salesorder_no, inv: r.qbo_invoice_id, err }); continue; }

        const cur = inv.TxnDate;
        const entry = {
            so: r.salesorder_no,
            channel: ch,
            inv: r.qbo_invoice_id,
            cur_txn: cur,
            map_last_txn: r.last_txn_date,
            wib_value: wib,
            utc8_value: utc8,
            src: r.last_payment_date_raw ? 'payment_date' : 'transaction_date',
            raw,
            last_synced_at: r.last_synced_at,
        };

        if (cur === utc8) {
            stats.already_correct_utc8++;
            audit({ event: 'already_correct_utc8', ...entry });
            continue;
        }

        // Finance manual edit detector
        if (r.last_txn_date && cur !== r.last_txn_date) {
            stats.finance_edited++;
            financeEdits.push(entry);
            audit({ event: 'finance_edited', ...entry });
            continue;
        }

        if (cur === wib) {
            stats.candidates++;
            candidates.push(entry);
            audit({ event: 'candidate', ...entry });
        } else {
            stats.unrelated_drift++;
            unrelated.push(entry);
            audit({ event: 'unrelated_drift', ...entry });
        }
    }

    console.log(`\n📊 Stats`);
    console.log(JSON.stringify(stats, null, 2));

    if (candidates.length > 0) {
        console.log(`\n🎯 Candidates that would shift WIB → UTC+8 (${candidates.length}):`);
        candidates.slice(0, 30).forEach((c) => {
            console.log(`  ${c.so.padEnd(30)} inv=${String(c.inv).padEnd(7)} cur=${c.cur_txn} → new=${c.utc8_value}  src=${c.src}  synced=${c.last_synced_at?.toISOString()}`);
        });
        if (candidates.length > 30) console.log(`  ... ${candidates.length - 30} more in audit file`);
    } else {
        console.log(`\n✓ No candidates need re-dating.`);
    }

    if (financeEdits.length > 0) {
        console.log(`\n📌 Finance manually edited (do NOT touch — ${financeEdits.length}):`);
        financeEdits.slice(0, 10).forEach((c) => {
            console.log(`  ${c.so.padEnd(30)} cur=${c.cur_txn}  map_last=${c.map_last_txn}  utc8=${c.utc8_value}  wib=${c.wib_value}`);
        });
    }

    if (unrelated.length > 0) {
        console.log(`\n⚠️  Unrelated drift (${unrelated.length} — separate issue, not from cutover):`);
        unrelated.slice(0, 10).forEach((c) => {
            console.log(`  ${c.so.padEnd(30)} cur=${c.cur_txn}  utc8=${c.utc8_value}  wib=${c.wib_value}`);
        });
    }

    auditStream.end();
    await mongoose.disconnect();
    console.log(`\n💾 Full audit: ${auditPath}`);
})().catch(async (e) => {
    console.error('❌', e);
    auditStream.end();
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
});
