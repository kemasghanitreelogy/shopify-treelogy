// One-shot: re-date specific invoices that were written WIB (UTC+7) during
// the brief 2026-05-06 → 2026-05-08 cutover window back to UTC+8 (the
// canonical, dashboard-aligned semantic). Sparse update TxnDate + DueDate
// (recomputed from new TxnDate + termDays). Also updates
// JubelioOrderMap.last_txn_date so the webhook's finance-edit-respect logic
// doesn't misclassify this fix as a manual edit on the next re-fire.
//
// Usage:
//   node scripts/fix-wib-window-drift.js --so SP-260506M9BUBSSU                    # dry-run
//   node scripts/fix-wib-window-drift.js --so SP-260506M9BUBSSU,TP-58387...        # multi
//   node scripts/fix-wib-window-drift.js --so SP-260506M9BUBSSU --apply --i-understand --limit 1
//
// Source-of-truth list: audit-logs/scan-wib-window-drift-*.ndjson

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const { toQboTxnDate, toWibDate } = require('../lib/jubelioTime');

const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const val = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : null; };

const APPLY = flag('apply');
const I_UNDERSTAND = flag('i-understand');
const LIMIT = Number(val('limit')) || 0;
const SO_LIST = (val('so') || '').split(',').map((s) => s.trim()).filter(Boolean);

if (SO_LIST.length === 0) {
    console.error('❌ Need --so SO_NO[,SO_NO,...]');
    process.exit(2);
}
if (APPLY && !I_UNDERSTAND) {
    console.error('❌ --apply requires --i-understand');
    process.exit(2);
}
if (APPLY && LIMIT === 0) {
    console.error('❌ --apply requires --limit N');
    process.exit(2);
}

// Term-days source: SO# prefix. Mirrors getTermDays in webhook.
const getTermDays = (soNo) => {
    const m = String(soNo || '').match(/^([A-Z]{2,5})-/);
    return m && m[1] === 'CS' ? 7 : 14;
};
const addDays = (isoDate, days) => {
    const d = new Date(`${isoDate}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return undefined;
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().substring(0, 10);
};

const getInvoice = (qbo, id) => new Promise((res, rej) =>
    qbo.getInvoice(id, (e, b) => e ? rej(new Error(`getInvoice ${id}: ${e.message || e}`)) : res(b))
);
const updateInvoice = (qbo, payload) => new Promise((res, rej) =>
    qbo.updateInvoice(payload, (e, b) => e ? rej(new Error(`updateInvoice: ${e.message || e}`)) : res(b))
);

const auditDir = path.join(process.cwd(), 'audit-logs');
fs.mkdirSync(auditDir, { recursive: true });
const auditPath = path.join(auditDir, `fix-wib-window-drift-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
const auditStream = fs.createWriteStream(auditPath, { flags: 'a' });
const audit = (rec) => auditStream.write(JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    console.log(`🚀 Fix WIB-window drift ${APPLY ? '(APPLY)' : '(dry-run)'}`);
    console.log(`   targets: ${SO_LIST.join(', ')}`);
    console.log(`   limit:   ${LIMIT || 'none'}`);
    console.log(`   audit:   ${auditPath}\n`);

    const stats = { scanned: 0, applied: 0, skipped_no_map: 0, skipped_already_correct: 0, skipped_no_match: 0, errors: 0 };

    for (const soNo of SO_LIST) {
        if (LIMIT && stats.applied >= LIMIT) break;
        stats.scanned++;
        const m = await JubelioOrderMap.findOne({ salesorder_no: soNo }).lean();
        if (!m || !m.qbo_invoice_id) {
            stats.skipped_no_map++;
            console.log(`  ⚠️  ${soNo} — no map / no invoice`);
            audit({ event: 'skip_no_map', so: soNo });
            continue;
        }

        const raw = m.last_payment_date_raw || m.last_transaction_date_raw;
        const utc8 = toQboTxnDate(raw);
        const wib = toWibDate(raw);
        if (!utc8 || !raw) {
            stats.skipped_no_match++;
            console.log(`  ⚠️  ${soNo} — no raw timestamp`);
            audit({ event: 'skip_no_raw', so: soNo, raw });
            continue;
        }

        const inv = await getInvoice(qbo, m.qbo_invoice_id);
        const cur = inv.TxnDate;

        if (cur === utc8) {
            stats.skipped_already_correct++;
            console.log(`  ✓  ${soNo.padEnd(30)} inv=${m.qbo_invoice_id} already utc8=${utc8}`);
            audit({ event: 'skip_already_correct', so: soNo, inv: m.qbo_invoice_id, cur, utc8 });
            continue;
        }
        if (cur !== wib) {
            stats.skipped_no_match++;
            console.log(`  ⚠️  ${soNo.padEnd(30)} inv=${m.qbo_invoice_id} cur=${cur} matches NEITHER utc8=${utc8} nor wib=${wib} — skip (manual edit?)`);
            audit({ event: 'skip_no_match', so: soNo, inv: m.qbo_invoice_id, cur, utc8, wib, map_last_txn: m.last_txn_date });
            continue;
        }

        const termDays = getTermDays(soNo);
        const newDueDate = addDays(utc8, termDays);
        const plan = {
            so: soNo,
            inv: m.qbo_invoice_id,
            cur_txn: cur,
            new_txn: utc8,
            new_due: newDueDate,
            termDays,
            src: m.last_payment_date_raw ? 'payment_date' : 'transaction_date',
            raw,
        };

        if (!APPLY) {
            console.log(`  📋 ${soNo.padEnd(30)} inv=${m.qbo_invoice_id} ${cur} → ${utc8}  due+${termDays}=${newDueDate}`);
            audit({ event: 'plan', dryRun: true, ...plan });
            continue;
        }

        try {
            const updated = await updateInvoice(qbo, {
                Id: m.qbo_invoice_id,
                SyncToken: inv.SyncToken,
                sparse: true,
                TxnDate: utc8,
                DueDate: newDueDate,
            });
            await JubelioOrderMap.updateOne(
                { _id: m._id },
                { last_txn_date: utc8, last_synced_at: new Date() },
            );
            stats.applied++;
            console.log(`  ✅ ${soNo.padEnd(30)} inv=${m.qbo_invoice_id} ${cur} → ${updated.TxnDate}  due=${updated.DueDate}`);
            audit({ event: 'applied', ...plan, applied_txn: updated.TxnDate, applied_due: updated.DueDate });
            await new Promise((r) => setTimeout(r, 200)); // QBO rate-limit margin
        } catch (e) {
            stats.errors++;
            console.error(`  ❌ ${soNo} error: ${e.message}`);
            audit({ event: 'error', so: soNo, error: e.message });
        }
    }

    console.log('\n📊 Stats');
    console.log(JSON.stringify(stats, null, 2));
    auditStream.end();
    await mongoose.disconnect();
    console.log(`\n💾 Audit: ${auditPath}`);
})().catch(async (e) => {
    console.error('❌', e);
    auditStream.end();
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
});
