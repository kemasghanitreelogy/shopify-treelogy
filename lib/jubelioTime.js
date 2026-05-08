// Canonical timezone helpers for Jubelio timestamps.
//
// Semantic model (load-bearing):
//   • Jubelio sends real UTC timestamps. The trailing "Z" is accurate.
//   • Jubelio + Shopee + Tokopedia + marketplace dashboards ALL display in
//     UTC+8 (= Singapore Time = same offset as WITA). Treelogy ops + finance
//     reconcile against THESE dashboards, so QBO TxnDate must align with the
//     dashboard date — i.e. UTC+8.
//   • Strictly, Treelogy is in WIB region (UTC+7), but every operational
//     tool they use shows UTC+8. Aligning QBO to dashboards (UTC+8) keeps
//     finance recon intuitive. PPN tax-strict edge cases handled separately.
//
// History:
//   • Pre-2026-05-06: used +8h ("isoDateJakarta") everywhere → operationally
//     correct but mislabeled as Jakarta.
//   • 2026-05-06 to 2026-05-08: tried switching to +7h (true WIB). Created
//     mismatch with all upstream dashboards. Elsa flagged 3 boundary-case
//     orders where QBO showed prev-day vs Jubelio/Shopee showed today.
//   • 2026-05-08 onwards: REVERTED to +8h. UTC+8 = canonical alignment.
//
// Rule of thumb:
//   - WRITE to QBO TxnDate / financial date  → toQboTxnDate (UTC+8)
//   - DISPLAY parity with Jubelio admin UI   → toWitaDate (UTC+8, alias)
//   - "WIB-strict" date (UTC+7) for special  → toWibDate (rare, edge cases only)
//     PPN reporting only

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

// Primary: Jubelio raw UTC → UTC+8 calendar date (YYYY-MM-DD string).
// Aligns with Jubelio + Shopee + marketplace dashboards. Use for any value
// that becomes a financial date in QBO (Invoice TxnDate, Payment TxnDate,
// service date on lines, due-date base).
const toQboTxnDate = (raw) => _projectDate(raw, WITA_OFFSET_HOURS);

// Explicit alias — same value as toQboTxnDate. Kept for code paths that
// want self-documenting "this is WITA / dashboard-aligned" intent.
const toWitaDate = (raw) => _projectDate(raw, WITA_OFFSET_HOURS);

// Strict WIB (UTC+7). Reserved for edge cases like PPN reporting where
// Jakarta calendar is required regardless of dashboard semantic. Do NOT
// use for QBO TxnDate writes — that role belongs to toQboTxnDate (UTC+8).
const toWibDate = (raw) => _projectDate(raw, WIB_OFFSET_HOURS);

// "Today" / "Yesterday" calendar boundary — uses UTC+8 to match QBO TxnDate
// semantic and Jubelio dashboard date. Daily reconcile filters Jubelio orders
// against QBO invoices both anchored on UTC+8 day boundaries.
const todayQbo = () => new Date(Date.now() + WITA_OFFSET_HOURS * HOUR_MS).toISOString().substring(0, 10);
const yesterdayQbo = () => {
    const d = new Date(`${todayQbo()}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().substring(0, 10);
};

// Jubelio raw UTC → UTC+8 time-of-day "HH:MM" (24h). Used for invoice memo
// `paid=HH:MM`. Aligned with Jubelio/Shopee dashboard display.
const toQboTime = (raw) => {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const s = String(raw).trim();
    if (!s || s === '-') return undefined;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return undefined;
    const wita = new Date(d.getTime() + WITA_OFFSET_HOURS * HOUR_MS);
    const hh = String(wita.getUTCHours()).padStart(2, '0');
    const mm = String(wita.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
};

module.exports = {
    toQboTxnDate,
    toWitaDate,
    toWibDate,
    toQboTime,
    todayQbo,
    yesterdayQbo,
    WIB_OFFSET_HOURS,
    WITA_OFFSET_HOURS,
};
