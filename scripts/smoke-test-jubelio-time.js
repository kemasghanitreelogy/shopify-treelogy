// Smoke test for lib/jubelioTime.js — table-driven assertions.
// Run: node scripts/smoke-test-jubelio-time.js
const { toQboTxnDate, toWitaDate, toWibDate, toQboTime, todayQbo, yesterdayQbo } = require('../lib/jubelioTime');

let pass = 0, fail = 0;
const check = (label, got, want) => {
    const ok = got === want;
    if (ok) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.error(`  ✗ ${label}\n      got=${JSON.stringify(got)}\n      want=${JSON.stringify(want)}`); }
};

console.log('toQboTxnDate (UTC+8 / dashboard-aligned) — boundary cases');
//   raw UTC          | + 8h                | expected
check('16:43 UTC → next day',  toQboTxnDate('2026-04-24T16:43:13.000Z'), '2026-04-25'); // 16:43 + 8h = 00:43 next day
check('16:00 UTC → next day',  toQboTxnDate('2026-05-04T16:00:00.000Z'), '2026-05-05'); // 16:00 + 8h = 00:00 next day
check('15:59 UTC → same day',  toQboTxnDate('2026-05-04T15:59:59.000Z'), '2026-05-04');
check('00:00 UTC → same day',  toQboTxnDate('2026-05-04T00:00:00.000Z'), '2026-05-04');
check('17:00 UTC → next day',  toQboTxnDate('2026-04-24T17:00:00.000Z'), '2026-04-25');

console.log('\ntoWitaDate (alias for toQboTxnDate, same offset)');
check('alias matches', toWitaDate('2026-04-24T16:43:13.000Z') === toQboTxnDate('2026-04-24T16:43:13.000Z'), true);
check('16:00 UTC → next day', toWitaDate('2026-05-04T16:00:00.000Z'), '2026-05-05');

console.log('\ntoWibDate (UTC+7, edge-case PPN only — NOT for QBO writes)');
check('16:43 UTC → same day WIB',  toWibDate('2026-04-24T16:43:13.000Z'), '2026-04-24'); // 16:43 + 7h = 23:43 same day
check('17:00 UTC → next day WIB',  toWibDate('2026-04-24T17:00:00.000Z'), '2026-04-25');
check('16:30 UTC: WITA=next day, WIB=same day', toWibDate('2026-05-04T16:30:00.000Z'), '2026-05-04');
check('16:30 UTC: WITA side',                   toQboTxnDate('2026-05-04T16:30:00.000Z'), '2026-05-05');

console.log('\nNull / empty / sentinel handling');
check('null',      toQboTxnDate(null), undefined);
check('undefined', toQboTxnDate(undefined), undefined);
check('empty',     toQboTxnDate(''), undefined);
check('whitespace',toQboTxnDate('   '), undefined);
check('dash',      toQboTxnDate('-'), undefined);
check('garbage (NaN parse) → first 10 chars', toQboTxnDate('zzzzzzzzzzz'), 'zzzzzzzzzz');

console.log('\nReal samples from production probe (post-revert: WITA semantic)');
//   Yuni's order — Shopee dashboard shows "06/05 00:21", Jubelio raw is 16:21Z
check('Yuni payment 16:21:30 → 06 May (matches Shopee dashboard)', toQboTxnDate('2026-05-05T16:21:30.000Z'), '2026-05-06');
//   Fenny's order — Jubelio shows "06 May, 00:35"
check('Fenny payment 16:35:34 → 06 May', toQboTxnDate('2026-05-05T16:35:34.000Z'), '2026-05-06');
//   R**a's order — Shopee shows "07 May, 00:07"
check('R**a payment 16:07:59 → 07 May', toQboTxnDate('2026-05-06T16:07:59.000Z'), '2026-05-07');

console.log('\ntoQboTime — payment hour for invoice memo (UTC+8 = matches dashboard)');
//   Raw 16:21 UTC → 00:21 dashboard → memo shows paid=00:21
check('Yuni 16:21:30 → paid=00:21',  toQboTime('2026-05-05T16:21:30.000Z'), '00:21');
check('14:58 UTC → 22:58 (UTC+8)',   toQboTime('2026-05-03T14:58:05.000Z'), '22:58');
check('00:00 UTC → 08:00',           toQboTime('2026-05-04T00:00:00.000Z'), '08:00');
check('16:00 UTC → 00:00 next day',  toQboTime('2026-05-04T16:00:00.000Z'), '00:00');
check('17:00 UTC → 01:00 next day',  toQboTime('2026-05-04T17:00:00.000Z'), '01:00');
check('23:59 UTC → 07:59 next day',  toQboTime('2026-05-04T23:59:00.000Z'), '07:59');
check('null', toQboTime(null), undefined);
check('empty', toQboTime(''), undefined);
check('dash', toQboTime('-'), undefined);
check('garbage', toQboTime('zzzzz'), undefined);

console.log('\ntodayQbo / yesterdayQbo basic format');
const today = todayQbo();
const yesterday = yesterdayQbo();
check('today format',     /^\d{4}-\d{2}-\d{2}$/.test(today), true);
check('yesterday format', /^\d{4}-\d{2}-\d{2}$/.test(yesterday), true);
check('yesterday < today', yesterday < today, true);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
