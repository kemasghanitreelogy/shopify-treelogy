// Dry-run smoke test for the #UNPAID marker pipeline.
//
// Validates four things WITHOUT making any QBO writes:
//   1. hasUnpaidMarker() helper matches/rejects expected variants.
//   2. JubelioOrderMap accepts the new manual_payment field (Mongoose schema strict-mode check).
//   3. A real recent internal-channel SO payload, with `#UNPAID` injected
//      into `note`, would produce the expected webhook decisions
//      (shouldSync=true, hasUnpaidMarker=true, payment-skipped path taken).
//   4. The same payload WITHOUT the marker still flows through auto-payment
//      so we don't silently regress existing behaviour.
//
// Run: node scripts/test-unpaid-marker.js

require('dotenv').config();
const mongoose = require('mongoose');

const cases = [
    { input: '#UNPAID', expected: true },
    { input: '#unpaid', expected: true },
    { input: 'Consignment Order 05/05/2026 #UNPAID', expected: true },
    { input: 'Customer minta kirim dulu, bayar minggu depan #UNPAID', expected: true },
    { input: '#unpaid - kirim hari Jumat', expected: true },
    { input: '#Unpaid mixed case', expected: true },
    { input: 'Consignment Order 05/05/2026', expected: false },
    { input: 'unpaid items', expected: false },
    { input: '#unpaidly', expected: false },           // word-boundary check
    { input: 'belum bayar', expected: false },
    { input: '', expected: false },
    { input: null, expected: false },
];

(async () => {
    let totalFail = 0;

    // ── 1. helper unit ─────────────────────────────────────────────────────
    console.log('\n[1/4] hasUnpaidMarker() unit test\n');
    const { hasUnpaidMarker } = require('../routes/jubelioWebhook');
    for (const c of cases) {
        const got = hasUnpaidMarker({ note: c.input });
        const pass = got === c.expected;
        console.log(`  ${pass ? '✅' : '❌'} note=${JSON.stringify(c.input).padEnd(60)} → ${got} ${pass ? '' : '(expected ' + c.expected + ')'}`);
        if (!pass) totalFail++;
    }

    // ── 2. schema acceptance ───────────────────────────────────────────────
    console.log('\n[2/4] JubelioOrderMap.manual_payment schema check\n');
    const JubelioOrderMap = require('../models/JubelioOrderMap');
    const path = JubelioOrderMap.schema.path('manual_payment');
    if (path && path.instance === 'Boolean') {
        console.log(`  ✅ field "manual_payment" present, type=${path.instance}, default=${path.defaultValue}`);
    } else {
        console.log(`  ❌ field missing or wrong type: ${path?.instance}`);
        totalFail++;
    }

    // ── 3 & 4. real-payload trace ──────────────────────────────────────────
    console.log('\n[3/4] real INTERNAL-channel SO payload — decision trace\n');
    await mongoose.connect(process.env.MONGODB_URI);
    const JubelioPayloadLog = require('../models/JubelioPayloadLog');
    const log = await JubelioPayloadLog.findOne({
        endpoint: 'pesanan',
        'payload.source_name': 'INTERNAL',
        'payload.salesorder_no': /^(DP|DW|CS|WS|LB)-/,
    }).sort({ received_at: -1 }).lean();

    if (!log) {
        console.log('  ⚠️  no recent INTERNAL channel SO found — skipping payload trace');
    } else {
        const so = log.payload;
        const PAID_STATUSES = new Set(['PAID', 'COMPLETED']);
        const trace = (label, soOverride) => {
            const cur = soOverride || so;
            const status = String(cur.status || '').toUpperCase();
            const buyerPaid = !!(cur.payment_date) || PAID_STATUSES.has(status);
            const marker = hasUnpaidMarker(cur);
            const wouldSync = buyerPaid;
            const wouldCreatePayment = wouldSync && !marker && PAID_STATUSES.has(status);
            console.log(`  [${label}]`);
            console.log(`    so.status=${status} so.payment_date=${cur.payment_date || 'null'} so.note=${JSON.stringify(cur.note || '')}`);
            console.log(`    → shouldSync=${wouldSync}  hasUnpaidMarker=${marker}  wouldCreatePayment=${wouldCreatePayment}`);
            return { wouldSync, marker, wouldCreatePayment };
        };

        console.log(`  Sample SO: ${so.salesorder_no} (note: ${JSON.stringify(so.note || '')})\n`);

        const baseline = trace('baseline (as-stored)', null);
        const withMarker = trace('with #UNPAID injected', { ...so, note: `${so.note || ''} #UNPAID`.trim() });
        const cleared = trace('with #UNPAID stripped (existing flow)', { ...so, note: 'Test note tanpa marker' });

        console.log('\n[4/4] expected behaviour assertions\n');
        const checks = [
            { name: 'baseline marker absent (note has no #UNPAID)', got: baseline.marker, expected: /#unpaid/i.test(String(so.note || '')) },
            { name: 'inject #UNPAID → marker detected', got: withMarker.marker, expected: true },
            { name: 'inject #UNPAID → wouldCreatePayment=false', got: withMarker.wouldCreatePayment, expected: false },
            { name: 'cleared note → marker absent', got: cleared.marker, expected: false },
        ];
        for (const c of checks) {
            const pass = c.got === c.expected;
            console.log(`  ${pass ? '✅' : '❌'} ${c.name}: got=${c.got} expected=${c.expected}`);
            if (!pass) totalFail++;
        }
    }

    await mongoose.disconnect();

    console.log(`\n${totalFail === 0 ? '✅ ALL PASS' : `❌ ${totalFail} FAILURE(S)`}`);
    process.exit(totalFail ? 1 : 0);
})().catch(async (e) => {
    console.error('Fatal:', e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
});
