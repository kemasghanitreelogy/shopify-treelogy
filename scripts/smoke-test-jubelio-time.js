// Smoke test for lib/jubelioTime.js — table-driven assertions.
// Run: node scripts/smoke-test-jubelio-time.js
const { toQboTxnDate, toWitaDate, toWibTime, todayWib, yesterdayWib } = require('../lib/jubelioTime');

let pass = 0, fail = 0;
const check = (label, got, want) => {
    const ok = got === want;
    if (ok) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.error(`  ✗ ${label}\n      got=${JSON.stringify(got)}\n      want=${JSON.stringify(want)}`); }
};

console.log('toQboTxnDate (WIB) — boundary cases');
//   raw UTC          | WIB add 7h          | expected
check('16:43 UTC → next day WIB',  toQboTxnDate('2026-04-24T16:43:13.000Z'), '2026-04-24'); // 16:43 + 7h = 23:43 → same day Apr 24 WIB
check('17:00 UTC → next day WIB',  toQboTxnDate('2026-04-24T17:00:00.000Z'), '2026-04-25'); // 17:00 + 7h = 00:00 next day
check('15:59 UTC → same day WIB',  toQboTxnDate('2026-05-04T15:59:59.000Z'), '2026-05-04');
check('00:00 UTC → same day WIB',  toQboTxnDate('2026-05-04T00:00:00.000Z'), '2026-05-04');
check('16:00 UTC → same day WIB',  toQboTxnDate('2026-05-04T16:00:00.000Z'), '2026-05-04'); // 16:00 + 7h = 23:00 same day
check('16:59 UTC → same day WIB',  toQboTxnDate('2026-05-04T16:59:59.000Z'), '2026-05-04'); // 16:59 + 7h = 23:59 same day

console.log('\ntoWitaDate (legacy +8h) — boundary cases');
check('16:43 UTC → next day WITA', toWitaDate('2026-04-24T16:43:13.000Z'), '2026-04-25'); // 16:43 + 8h = 00:43 next day
check('15:59 UTC → same day WITA', toWitaDate('2026-05-04T15:59:59.000Z'), '2026-05-04');
check('16:00 UTC → next day WITA', toWitaDate('2026-05-04T16:00:00.000Z'), '2026-05-05'); // 16:00 + 8h = 00:00 next day

console.log('\nWITA vs WIB diverge (forward-shift records)');
//   These are the records that current code marks as one day later than WIB.
check('16:00 UTC: WITA=05-05, WIB=05-04', toWitaDate('2026-05-04T16:00:00.000Z'), '2026-05-05');
check('16:30 UTC: WITA=05-05, WIB=05-04', toWitaDate('2026-05-04T16:30:00.000Z'), '2026-05-05');
check('16:30 UTC: WIB  side',             toQboTxnDate('2026-05-04T16:30:00.000Z'), '2026-05-04');

console.log('\nNull / empty / sentinel handling');
check('null',      toQboTxnDate(null), undefined);
check('undefined', toQboTxnDate(undefined), undefined);
check('empty',     toQboTxnDate(''), undefined);
check('whitespace',toQboTxnDate('   '), undefined);
check('dash',      toQboTxnDate('-'), undefined);
check('garbage (NaN parse) → first 10 chars', toQboTxnDate('zzzzzzzzzzz'), 'zzzzzzzzzz');

console.log('\nReal samples from production probe');
check('SP transaction 16:18:53', toQboTxnDate('2026-05-02T16:18:53.000Z'), '2026-05-02');
check('TP transaction 16:43:13', toQboTxnDate('2026-04-24T16:43:13.000Z'), '2026-04-24');
check('SHF transaction 16:11:26', toQboTxnDate('2026-04-27T16:11:26.000Z'), '2026-04-27');

console.log('\ntoWibTime — payment hour for invoice memo');
// CRITICAL: ensure WIB (+7h), NOT WITA (+8h). See lib/jubelioTime.js header.
//   Raw 14:58 UTC → WIB 21:58 (correct). WITA would be 22:58 (wrong).
check('14:58 UTC → 21:58 WIB',  toWibTime('2026-05-03T14:58:05.000Z'), '21:58');
check('00:00 UTC → 07:00 WIB',  toWibTime('2026-05-04T00:00:00.000Z'), '07:00');
check('16:00 UTC → 23:00 WIB',  toWibTime('2026-05-04T16:00:00.000Z'), '23:00');
check('17:00 UTC → 00:00 WIB next day', toWibTime('2026-05-04T17:00:00.000Z'), '00:00');
check('23:59 UTC → 06:59 WIB next day', toWibTime('2026-05-04T23:59:00.000Z'), '06:59');
// Anti-WITA assertions: same raw must NOT produce the WITA hour.
check('14:58 UTC ≠ 22:58 (would be WITA)', toWibTime('2026-05-03T14:58:05.000Z') === '22:58', false);
check('null', toWibTime(null), undefined);
check('empty', toWibTime(''), undefined);
check('dash', toWibTime('-'), undefined);
check('garbage', toWibTime('zzzzz'), undefined);

console.log('\ntodayWib / yesterdayWib basic format');
const today = todayWib();
const yesterday = yesterdayWib();
check('today format',     /^\d{4}-\d{2}-\d{2}$/.test(today), true);
check('yesterday format', /^\d{4}-\d{2}-\d{2}$/.test(yesterday), true);
check('yesterday < today', yesterday < today, true);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
