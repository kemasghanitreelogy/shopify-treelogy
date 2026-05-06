// Canonical timezone helpers for Jubelio timestamps.
//
// Semantic model (load-bearing):
//   • Jubelio sends real UTC timestamps. The trailing "Z" is accurate.
//   • Jubelio's admin UI displays them in WITA (UTC+8) — that's why
//     "2026-04-24T16:43:13.000Z" appears as "25 Apr 2026, 00:43" there.
//   • Treelogy operates on WIB (UTC+7). QBO TxnDate must reflect the
//     actual Jakarta business day when payment was received.
//
// Rule of thumb when picking a helper:
//   - WRITE to QBO TxnDate / financial date  → toQboTxnDate (= WIB, UTC+7)
//   - DISPLAY parity with Jubelio admin UI    → toWitaDate (UTC+8, legacy)
//   - LIST-fetch cutoff margin                → toWitaDate (wider net = safer)
//   - Tolerant compare in historical audits   → both, OR-match either
//
// History: pre-2026-05 the codebase used `isoDateJakarta` + +8h everywhere.
// That label said "Jakarta" but the offset was WITA, producing TxnDate that
// matched Jubelio admin UI but not Jakarta business calendar. Forward-only
// cutover: new invoices use toQboTxnDate (WIB). Historical invoices are NOT
// rewritten; audit logic uses tolerant compare so both old and new pass.

const WIB_OFFSET_HOURS = 7;
const WITA_OFFSET_HOURS = 8;
const HOUR_MS = 60 * 60 * 1000;

const _projectDate = (raw, offsetHours) => {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const s = String(raw).trim();
    if (!s || s === '-') return undefined;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s.substring(0, 10);
    return new Date(d.getTime() + offsetHours * HOUR_MS).toISOString().substring(0, 10);
};

// Primary: Jubelio raw UTC → WIB calendar date (YYYY-MM-DD string).
// Use for any value that becomes a financial date in QBO (Invoice TxnDate,
// Payment TxnDate, service date on lines, due-date base).
const toQboTxnDate = (raw) => _projectDate(raw, WIB_OFFSET_HOURS);

// Legacy: Jubelio raw UTC → WITA calendar date. Matches Jubelio admin UI.
// Kept for: tolerant audit-compare, retroactive WITA backfill consistency,
// and list-endpoint fetch margins where over-inclusion is safe.
const toWitaDate = (raw) => _projectDate(raw, WITA_OFFSET_HOURS);

// "Today" / "Yesterday" in WIB — used by daily reconcile windowing.
const todayWib = () => new Date(Date.now() + WIB_OFFSET_HOURS * HOUR_MS).toISOString().substring(0, 10);
const yesterdayWib = () => {
    const d = new Date(`${todayWib()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().substring(0, 10);
};

// Jubelio raw UTC → WIB time-of-day "HH:MM" (24h). Used for invoice memo
// to surface payment hour without consuming extra fields.
const toWibTime = (raw) => {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const s = String(raw).trim();
    if (!s || s === '-') return undefined;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return undefined;
    const wib = new Date(d.getTime() + WIB_OFFSET_HOURS * HOUR_MS);
    const hh = String(wib.getUTCHours()).padStart(2, '0');
    const mm = String(wib.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
};

module.exports = {
    toQboTxnDate,
    toWitaDate,
    toWibTime,
    todayWib,
    yesterdayWib,
    WIB_OFFSET_HOURS,
    WITA_OFFSET_HOURS,
};
