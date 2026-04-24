// Comprehensive TxnDate reconciliation: scan JubelioOrderMap entries, fetch
// each QBO Invoice, and verify TxnDate matches what Jubelio actually meant.
//
// Verification layers, in priority order:
//   1. SHOPEE PATTERN — SO number `SP-YYMMDD...` encodes the order date.
//      Ground-truth is in the SO number. Always safe to auto-fix.
//   2. VERIFIED — entry has `last_transaction_date_raw` (post-deploy).
//      Expected = isoDateJakarta(raw). Always safe to auto-fix.
//   3. LEGACY ALL-CHANNELS HEURISTIC — entry has no raw value and SO number
//      doesn't encode date (Tokopedia, Shopify, manual). Bug pattern: TxnDate
//      is exactly 1 day before jktDate(CreateTime). In our SHIPPED-triggered
//      flow, transaction_date and sync time are typically same WIB day, so
//      gap=1d is overwhelmingly the bug. Auto-fixed when --all-channels.
//
// Usage:
//   node scripts/audit-txndate.js                              # report only
//   node scripts/audit-txndate.js --days=30                    # narrow window
//   node scripts/audit-txndate.js --fix                        # fix Shopee + verified
//   node scripts/audit-txndate.js --fix --all-channels         # also fix legacy gap=1d non-Shopee
//   node scripts/audit-txndate.js --silent                     # no Telegram alert

require('dotenv').config();
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const { getQboInstance } = require('../services/qboService');
const { alertAuditReport } = require('../services/alertService');

const args = process.argv.slice(2);
const arg = (k, def) => {
    const hit = args.find(a => a.startsWith(`--${k}=`));
    return hit ? hit.split('=')[1] : def;
};
const flag = (k) => args.includes(`--${k}`);

const days = Number(arg('days', '0'));     // 0 = no limit
const doFix = flag('fix');
const allChannels = flag('all-channels'); // also auto-fix legacy non-Shopee gap=1d
const silent = flag('silent');
const maxLoops = Number(arg('max-loops', '5'));

// Shopee SO number format: `SP-YYMMDDxxxxxxxx`. The 6 digits after `SP-` are
// the order date (year, month, day). Parsed date is treated as ground truth.
const parseShopeeDate = (soNo) => {
    const m = String(soNo || '').match(/^SP-(\d{2})(\d{2})(\d{2})/);
    if (!m) return null;
    const [, yy, mm, dd] = m;
    const year = Number(yy) >= 70 ? `19${yy}` : `20${yy}`;
    const date = `${year}-${mm}-${dd}`;
    // Validate: parses to a real date, not NaN
    const d = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    return date;
};

const JKT_OFFSET_MS = 7 * 60 * 60 * 1000;
const isoDateJakarta = (raw) => {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s || s === '-') return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s.substring(0, 10);
    return new Date(d.getTime() + JKT_OFFSET_MS).toISOString().substring(0, 10);
};

const dayDiff = (laterStr, earlierStr) => {
    const a = new Date(`${laterStr}T00:00:00Z`).getTime();
    const b = new Date(`${earlierStr}T00:00:00Z`).getTime();
    return Math.round((a - b) / 86400000);
};

const getInvoice = (qbo, id) => new Promise((resolve) => {
    qbo.getInvoice(id, (err, body) => err ? resolve({ err: String(err.message || err).slice(0, 200) }) : resolve({ inv: body }));
});
const updateInvoice = (qbo, payload) => new Promise((resolve, reject) => {
    qbo.updateInvoice(payload, (err, body) => err ? reject(err) : resolve(body));
});

async function runOnce(qbo, opts) {
    const filter = days > 0 ? { last_synced_at: { $gte: new Date(Date.now() - days * 86400000) } } : {};
    const rows = await JubelioOrderMap.find(filter)
        .select('salesorder_no qbo_invoice_id last_transaction_date_raw last_synced_at')
        .lean();

    const shopeeFix = [];     // { so, inv, qbo, expected, syncToken }
    const verifiedFix = [];   // { so, inv, qbo, expected, syncToken, raw }
    const legacyFix = [];     // { so, inv, qbo, expected, syncToken, gap } — non-Shopee, no raw, gap=1d
    const errors = [];

    let processed = 0;
    for (const r of rows) {
        processed++;
        if (processed % 50 === 0) process.stdout.write(`\r  scanned ${processed}/${rows.length}...`);
        const { inv, err } = await getInvoice(qbo, r.qbo_invoice_id);
        if (err) {
            // Object Not Found → invoice deleted in QBO; map is stale, ignore.
            if (!/Object Not Found|6240|404/i.test(err)) {
                errors.push({ so: r.salesorder_no, inv: r.qbo_invoice_id, err });
            }
            continue;
        }

        // Layer 1: Shopee SO number is ground truth.
        const shopeeDate = parseShopeeDate(r.salesorder_no);
        if (shopeeDate) {
            if (inv.TxnDate !== shopeeDate) {
                shopeeFix.push({
                    so: r.salesorder_no, inv: r.qbo_invoice_id,
                    qbo: inv.TxnDate, expected: shopeeDate, syncToken: inv.SyncToken,
                });
            }
            continue;
        }

        // Layer 2: Verified (post-deploy) — raw value from Jubelio.
        if (r.last_transaction_date_raw) {
            const expected = isoDateJakarta(r.last_transaction_date_raw);
            if (expected && inv.TxnDate !== expected) {
                verifiedFix.push({
                    so: r.salesorder_no, inv: r.qbo_invoice_id,
                    qbo: inv.TxnDate, expected, syncToken: inv.SyncToken,
                    raw: r.last_transaction_date_raw,
                });
            }
            continue;
        }

        // Layer 3: Legacy non-Shopee — fix gap=1d (timezone bug pattern).
        const jktCreate = isoDateJakarta(inv.MetaData?.CreateTime);
        if (!jktCreate || !inv.TxnDate) continue;
        const gap = dayDiff(jktCreate, inv.TxnDate);
        if (gap === 1) {
            legacyFix.push({
                so: r.salesorder_no, inv: r.qbo_invoice_id,
                qbo: inv.TxnDate, expected: jktCreate, syncToken: inv.SyncToken, gap,
            });
        }
    }
    process.stdout.write('\r');

    return { rows, shopeeFix, verifiedFix, legacyFix, errors };
}

async function applyFix(qbo, list, label) {
    let ok = 0, fail = 0;
    for (const m of list) {
        try {
            const updated = await updateInvoice(qbo, {
                Id: m.inv, SyncToken: m.syncToken, sparse: true, TxnDate: m.expected,
            });
            console.log(`  ✅ [${label}] ${m.so} inv=${m.inv}: ${m.qbo} → ${updated.TxnDate}`);
            ok++;
        } catch (e) {
            console.log(`  ❌ [${label}] ${m.so} inv=${m.inv}: ${e.message || JSON.stringify(e).slice(0, 200)}`);
            fail++;
        }
    }
    return { ok, fail };
}

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    const scope = days > 0 ? `last ${days}d` : 'ALL TIME';
    console.log(`\n=== TxnDate Audit (${scope})${doFix ? ' [FIX MODE]' : ''} ===\n`);

    let totalFixed = 0;
    let lastResult;

    for (let loop = 1; loop <= maxLoops; loop++) {
        const result = await runOnce(qbo);
        lastResult = result;
        const { rows, shopeeFix, verifiedFix, legacyFix, errors } = result;
        console.log(`Loop ${loop}: scanned=${rows.length}  shopee-mismatch=${shopeeFix.length}  verified-mismatch=${verifiedFix.length}  legacy-gap1d=${legacyFix.length}  errors=${errors.length}`);

        if (shopeeFix.length) {
            console.log('\nShopee mismatches (date encoded in SO# is authoritative):');
            for (const m of shopeeFix.slice(0, 30)) console.log(`  ${m.so} inv=${m.inv}  QBO=${m.qbo} → expected=${m.expected}`);
            if (shopeeFix.length > 30) console.log(`  ... and ${shopeeFix.length - 30} more`);
        }
        if (verifiedFix.length) {
            console.log('\nVerified mismatches (raw transaction_date stored):');
            for (const m of verifiedFix.slice(0, 30)) console.log(`  ${m.so} inv=${m.inv}  QBO=${m.qbo} → expected=${m.expected}  raw="${m.raw}"`);
            if (verifiedFix.length > 30) console.log(`  ... and ${verifiedFix.length - 30} more`);
        }
        if (legacyFix.length) {
            const verb = (doFix && allChannels) ? 'will be auto-fixed' : 'NOT auto-fixed (pass --all-channels to enable)';
            console.log(`\nLegacy non-Shopee with gap=1d (${verb}):`);
            for (const m of legacyFix.slice(0, 30)) console.log(`  ${m.so} inv=${m.inv}  QBO=${m.qbo} → CreateTime(JKT)=${m.expected}`);
            if (legacyFix.length > 30) console.log(`  ... and ${legacyFix.length - 30} more`);
        }
        if (errors.length) {
            console.log('\nErrors:');
            for (const e of errors.slice(0, 10)) console.log(`  ${e.so} inv=${e.inv}: ${e.err}`);
        }

        const toFix = [];
        if (doFix && shopeeFix.length) toFix.push({ list: shopeeFix, label: 'SHOPEE' });
        if (doFix && verifiedFix.length) toFix.push({ list: verifiedFix, label: 'VERIFIED' });
        if (doFix && allChannels && legacyFix.length) toFix.push({ list: legacyFix, label: 'LEGACY' });

        if (!toFix.length) {
            const fixableLeft = shopeeFix.length + verifiedFix.length + (allChannels ? legacyFix.length : 0);
            if (fixableLeft) {
                console.log('\n(Run with --fix to auto-patch.)');
            } else {
                console.log('\n✅ All auto-verifiable TxnDates are correct.');
                if (legacyFix.length && !allChannels) {
                    console.log(`   ${legacyFix.length} legacy non-Shopee gap=1d entries pending — pass --all-channels to also auto-fix those.`);
                }
            }
            if (!silent) alertAuditReport({
                scope: `${scope} (loop ${loop})`,
                scanned: rows.length,
                mismatches: shopeeFix.length + verifiedFix.length + legacyFix.length,
                fixed: totalFixed, errors: errors.length,
            });
            await mongoose.disconnect();
            const stillBroken = shopeeFix.length + verifiedFix.length + (allChannels ? legacyFix.length : 0);
            process.exit(stillBroken ? 1 : 0);
        }

        console.log(`\nApplying fixes (loop ${loop})...`);
        let loopFixed = 0;
        for (const { list, label } of toFix) {
            const { ok } = await applyFix(qbo, list, label);
            loopFixed += ok;
        }
        totalFixed += loopFixed;
        console.log(`Loop ${loop} fixed: ${loopFixed}\n`);

        if (loopFixed === 0) {
            console.log('No progress this loop — stopping to avoid infinite loop.');
            break;
        }
    }

    console.log(`\n=== Done. Total fixed across loops: ${totalFixed} ===`);
    const final = lastResult || { rows: [], shopeeFix: [], verifiedFix: [], legacyFix: [], errors: [] };
    if (!silent) alertAuditReport({
        scope,
        scanned: final.rows.length,
        mismatches: final.shopeeFix.length + final.verifiedFix.length + final.legacyFix.length,
        fixed: totalFixed, errors: final.errors.length,
    });
    await mongoose.disconnect();
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
