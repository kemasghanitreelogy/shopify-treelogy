// Phase 2 — Dry-run migration tool (no apply by default).
//
// Walks every JubelioOrderMap entry that has a QBO invoice, computes what
// the WIB-canonical TxnDate WOULD be, compares to the current QBO TxnDate,
// and reports candidates that would shift. Output is rich enough that you
// can hand it to finance for sign-off before any --apply is considered.
//
// Apply is GUARDED: requires --apply AND --i-understand flag together,
// AND a --limit, AND will refuse to touch invoices in the current month
// (locked-period guard, override with --allow-current-month).
//
// Usage:
//   node scripts/migrate-txndate-wita-to-wib.js                    # dry-run all
//   node scripts/migrate-txndate-wita-to-wib.js --channel SP       # filter
//   node scripts/migrate-txndate-wita-to-wib.js --before 2026-04-01 # only older
//   node scripts/migrate-txndate-wita-to-wib.js --limit 50
//   node scripts/migrate-txndate-wita-to-wib.js --apply --i-understand --limit 5 --before 2026-04-30
//
// Output (always written): migration-audit-wita-to-wib-<ISO>.ndjson

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const { toQboTxnDate, toWitaDate } = require('../lib/jubelioTime');

const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const val = (k) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : null;
};

const APPLY = flag('apply');
const I_UNDERSTAND = flag('i-understand');
const ALLOW_CURRENT_MONTH = flag('allow-current-month');
const LIMIT = Number(val('limit')) || 0;
const BEFORE = val('before'); // YYYY-MM-DD; only records with TxnDate < this
const CHANNEL = (val('channel') || '').toUpperCase();

if (APPLY && !I_UNDERSTAND) {
    console.error('❌ --apply requires --i-understand flag (this rewrites historical books).');
    console.error('   See script header for full usage.');
    process.exit(2);
}
if (APPLY && LIMIT === 0) {
    console.error('❌ --apply requires --limit N (no unbounded apply allowed).');
    process.exit(2);
}

const auditPath = path.join(
    process.cwd(),
    `migration-audit-wita-to-wib-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`,
);
const auditStream = fs.createWriteStream(auditPath, { flags: 'a' });
const audit = (rec) => auditStream.write(JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');

const monthOf = (yyyymmdd) => yyyymmdd?.slice(0, 7) || null;
const currentMonth = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 7);

const getInvoice = (qbo, id) => new Promise((resolve) => {
    qbo.getInvoice(id, (err, body) => err ? resolve({ err: String(err.message || err).slice(0, 200) }) : resolve({ inv: body }));
});
const updateInvoice = (qbo, payload) => new Promise((resolve, reject) => {
    qbo.updateInvoice(payload, (err, body) => err ? reject(err) : resolve(body));
});

const channelOf = (soNo) => {
    const m = String(soNo || '').match(/^([A-Z]{2,5})-/);
    return m ? m[1] : '';
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    console.log(`🚀 Migration ${APPLY ? '(APPLY)' : '(dry-run)'}`);
    console.log(`   filters: channel=${CHANNEL || 'ALL'}  before=${BEFORE || 'none'}  limit=${LIMIT || 'none'}`);
    console.log(`   guards: skip-current-month=${ALLOW_CURRENT_MONTH ? 'OFF' : 'ON'}  current_month=${currentMonth}`);
    console.log(`   audit: ${auditPath}\n`);

    const filter = {
        qbo_invoice_id: { $exists: true, $ne: null },
        $or: [
            { last_payment_date_raw: { $exists: true, $ne: null } },
            { last_transaction_date_raw: { $exists: true, $ne: null } },
        ],
    };
    const rows = await JubelioOrderMap.find(filter)
        .select('salesorder_no qbo_invoice_id last_payment_date_raw last_transaction_date_raw last_synced_at')
        .lean();
    console.log(`📦 Maps with invoice: ${rows.length}`);

    const stats = {
        scanned: 0,
        skipped_channel: 0,
        skipped_no_raw: 0,
        skipped_qbo_404: 0,
        skipped_already_wib: 0,
        skipped_neither_match: 0,
        skipped_before: 0,
        skipped_current_month: 0,
        skipped_cross_month: 0,
        would_shift: 0,
        applied: 0,
        errors: 0,
    };
    const shiftBuckets = { intra_month: 0, cross_month: 0 };
    const shifts = [];

    for (const r of rows) {
        if (LIMIT && stats.applied + stats.would_shift >= LIMIT) break;
        stats.scanned++;
        const ch = channelOf(r.salesorder_no);
        if (CHANNEL && ch !== CHANNEL) { stats.skipped_channel++; continue; }
        const raw = r.last_payment_date_raw || r.last_transaction_date_raw;
        const src = r.last_payment_date_raw ? 'payment_date' : 'transaction_date';
        if (!raw) { stats.skipped_no_raw++; continue; }

        const wib = toQboTxnDate(raw);
        const wita = toWitaDate(raw);
        if (!wib) { stats.skipped_no_raw++; continue; }

        const { inv, err } = await getInvoice(qbo, r.qbo_invoice_id);
        if (err) { stats.skipped_qbo_404++; continue; }

        const cur = inv.TxnDate;
        if (cur === wib) { stats.skipped_already_wib++; continue; }
        if (cur !== wita) {
            // Neither matches — don't touch (genuine drift, separate issue).
            stats.skipped_neither_match++;
            audit({ event: 'skipped_neither_match', so: r.salesorder_no, inv: r.qbo_invoice_id, cur, wib, wita, src });
            continue;
        }

        // cur === wita: this is a candidate for migration to WIB.
        if (BEFORE && cur >= BEFORE) { stats.skipped_before++; continue; }

        const crossMonth = monthOf(cur) !== monthOf(wib);
        if (crossMonth) shiftBuckets.cross_month++; else shiftBuckets.intra_month++;

        if (!ALLOW_CURRENT_MONTH && monthOf(cur) === currentMonth) {
            stats.skipped_current_month++;
            audit({ event: 'skipped_current_month', so: r.salesorder_no, inv: r.qbo_invoice_id, cur, wib, src });
            continue;
        }

        stats.would_shift++;
        const shift = {
            so: r.salesorder_no,
            channel: ch,
            inv: r.qbo_invoice_id,
            cur_txn: cur,
            new_txn: wib,
            cross_month: crossMonth,
            src,
            raw,
        };
        shifts.push(shift);
        audit({ event: 'would_shift', ...shift });

        if (APPLY) {
            try {
                const updated = await updateInvoice(qbo, { Id: r.qbo_invoice_id, SyncToken: inv.SyncToken, sparse: true, TxnDate: wib });
                stats.applied++;
                stats.would_shift--; // re-categorize: it actually shifted
                audit({ event: 'applied', so: r.salesorder_no, inv: r.qbo_invoice_id, from: cur, to: updated.TxnDate });
                console.log(`  ✅ ${r.salesorder_no.padEnd(28)} ${cur} → ${updated.TxnDate}`);
                await new Promise((r2) => setTimeout(r2, 200)); // QBO rate-limit margin
            } catch (e) {
                stats.errors++;
                audit({ event: 'error', so: r.salesorder_no, inv: r.qbo_invoice_id, error: e.message });
                console.error(`  ❌ ${r.salesorder_no} error: ${e.message}`);
            }
        }
    }

    console.log('\n📊 Stats');
    console.log(JSON.stringify(stats, null, 2));
    console.log(`\n📅 Shift buckets (intra-month vs cross-month — cross-month = PPN concern)`);
    console.log(`  intra_month:  ${shiftBuckets.intra_month}`);
    console.log(`  cross_month:  ${shiftBuckets.cross_month}`);

    if (!APPLY && shifts.length > 0) {
        console.log(`\n📋 First 20 records that would shift (full list in audit file):`);
        shifts.slice(0, 20).forEach((s) => {
            console.log(`  ${s.so.padEnd(28)} ${s.cur_txn} → ${s.new_txn}  ${s.cross_month ? '⚠️ CROSS-MONTH' : ''}  src=${s.src}`);
        });
    }

    auditStream.end();
    await mongoose.disconnect();
    console.log(`\n💾 Audit written: ${auditPath}`);
})().catch(async (e) => {
    console.error('❌', e);
    auditStream.end();
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
});
