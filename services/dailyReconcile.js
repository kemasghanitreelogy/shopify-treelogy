// Daily reconciliation: compare Jubelio orders for a given WIB day vs QBO
// invoices, scoped to "what should have synced per our algorithm".
//
// Three sources are joined by salesorder_no (= QBO DocNumber):
//   A) Jubelio API   — authoritative list of orders for the day per channel
//   B) Mongo map     — internal record of every webhook we processed
//   C) QBO query     — actual invoices in QBO with TxnDate = the day
//
// Output is detailed: every mismatch carries full per-SO context so the
// operator can debug without having to dig in MongoDB or Jubelio UI.

const JubelioOrderMap = require('../models/JubelioOrderMap');
const jubelio = require('./jubelioApiService');

// Mirror webhook constants. Marketplace channels (SP, TP, SHF, …) gate sync on
// SHIPPED/COMPLETED. Direct-sale prefixes bypass the status check.
const SYNC_STATUSES = new Set(
    (process.env.JUBELIO_SYNC_STATUSES || 'SHIPPED,COMPLETED')
        .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
);
const BYPASS_STATUS_PREFIXES = new Set(
    (process.env.JUBELIO_BYPASS_STATUS_PREFIXES || 'LB,CS,DP,DW')
        .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
);

const JKT_OFFSET_MS = 7 * 60 * 60 * 1000;

const yesterdayWib = () => {
    const nowJkt = new Date(Date.now() + JKT_OFFSET_MS);
    const y = new Date(nowJkt);
    y.setUTCDate(y.getUTCDate() - 1);
    return y.toISOString().substring(0, 10);
};

const isoDateJakarta = (raw) => {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s || s === '-') return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s.substring(0, 10);
    return new Date(d.getTime() + JKT_OFFSET_MS).toISOString().substring(0, 10);
};

const getSoPrefix = (soNo) => {
    const m = String(soNo || '').match(/^([A-Z]{2,5})-/);
    return m ? m[1] : 'UNKNOWN';
};

// Mirrors the webhook decision at routes/jubelioWebhook.js:893-897.
// Returns { expected, reason } — reason is human-readable explanation.
const applySyncRule = (so) => {
    if (so.is_canceled) {
        return { expected: false, reason: 'is_canceled=true' };
    }
    const prefix = getSoPrefix(so.salesorder_no);
    if (BYPASS_STATUS_PREFIXES.has(prefix)) {
        return { expected: true, reason: `bypass-prefix=${prefix}` };
    }
    const status = String(so.status || so.internal_status || so.wms_status || '').toUpperCase();
    if (SYNC_STATUSES.has(status)) {
        return { expected: true, reason: `marketplace status=${status}` };
    }
    return { expected: false, reason: `status=${status || 'EMPTY'} ∉ ${[...SYNC_STATUSES].join('/')}` };
};

// Filter Jubelio item to the target WIB date. Different endpoints have
// different "primary" date fields — we check transaction_date first (the
// canonical order date used by /completed and /cancel), then shipment_date
// for shipped lists.
const itemMatchesDate = (so, date) => {
    const fields = ['transaction_date', 'shipment_date', 'created_date'];
    for (const f of fields) {
        const raw = so?.[f];
        if (!raw) continue;
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) continue;
        const wib = new Date(d.getTime() + JKT_OFFSET_MS).toISOString().substring(0, 10);
        if (wib === date) return true;
    }
    return false;
};

// Fetch SOs from Jubelio. Jubelio list endpoints don't accept date filters
// in query — we pull paginated, sorted by date desc, stopping early once
// items fall before the target date, then filter to exact-match. Each
// endpoint failure is logged but doesn't fail the whole reconcile — partial
// data is better than none for triage purposes.
const fetchJubelioOrdersForDate = async (date) => {
    const errors = [];

    const fetchSafe = async (label, fn) => {
        try {
            const rows = await fn();
            const filtered = rows.filter(so => itemMatchesDate(so, date));
            console.log(`  📥 Jubelio ${label}: fetched=${rows.length} matched_date=${filtered.length}`);
            return filtered;
        } catch (e) {
            console.warn(`  ⚠️ Jubelio ${label} failed: ${e.message}`);
            errors.push({ source: label, error: e.message });
            return [];
        }
    };

    const [shipped, completed, canceled] = await Promise.all([
        fetchSafe('shipped', () => jubelio.listShippedOrders({ dateFrom: date })),
        fetchSafe('completed', () => jubelio.listCompletedOrders({ dateFrom: date })),
        fetchSafe('canceled', () => jubelio.listCanceledOrders({ dateFrom: date })),
    ]);

    const dedup = new Map();
    for (const so of [...shipped, ...completed, ...canceled]) {
        if (!so?.salesorder_id) continue;
        const existing = dedup.get(so.salesorder_id);
        // Prefer the entry with most fields populated; keep first if tied.
        if (!existing || Object.keys(so).length > Object.keys(existing).length) {
            dedup.set(so.salesorder_id, so);
        }
    }

    return { orders: [...dedup.values()], fetchErrors: errors };
};

// Query QBO for all invoices with TxnDate = date. Uses the realm-scoped query.
// Returns array of { Id, DocNumber, TxnDate, TotalAmt, Balance, CustomerRef }.
const fetchQboInvoicesForDate = async (qbo, date) => {
    const baseUrl = qbo.useSandbox
        ? `https://sandbox-quickbooks.api.intuit.com/v3/company/${qbo.realmId}`
        : `https://quickbooks.api.intuit.com/v3/company/${qbo.realmId}`;

    const out = [];
    const PAGE = 200;
    for (let startPosition = 1; startPosition < 5000; startPosition += PAGE) {
        const q = `SELECT Id, DocNumber, TxnDate, TotalAmt, Balance, CustomerRef FROM Invoice WHERE TxnDate = '${date}' STARTPOSITION ${startPosition} MAXRESULTS ${PAGE}`;
        const url = `${baseUrl}/query?query=${encodeURIComponent(q)}&minorversion=${qbo.minorversion || '65'}`;
        const res = await fetch(url, {
            headers: {
                Authorization: `Bearer ${qbo.token}`,
                Accept: 'application/json',
            },
        });
        const text = await res.text();
        let body;
        try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
        if (!res.ok) {
            throw new Error(`QBO query Invoice TxnDate=${date} (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
        }
        const invoices = body?.QueryResponse?.Invoice || [];
        if (invoices.length === 0) break;
        out.push(...invoices);
        if (invoices.length < PAGE) break;
    }
    return out;
};

// Channel label heuristic (so the report reads naturally).
const channelLabel = (prefix, sourceName) => {
    const m = {
        SP: 'Shopee', TP: 'Tokopedia', SHF: 'Shopify',
        LB: 'La Brisa', CS: 'Consignment', DP: 'Direct/POS', DW: 'Walk-in',
    };
    return m[prefix] || sourceName || prefix || 'Unknown';
};

const runDailyReconcile = async ({ qbo, date }) => {
    const t0 = Date.now();
    const targetDate = date || yesterdayWib();
    console.log(`\n🌅 Daily reconcile · target=${targetDate}`);

    // 1) Pull from all three sources in parallel.
    const [{ orders: jubelioOrders, fetchErrors }, qboInvoices, mapEntries] = await Promise.all([
        fetchJubelioOrdersForDate(targetDate),
        fetchQboInvoicesForDate(qbo, targetDate),
        JubelioOrderMap.find({
            qbo_realm_id: String(qbo.realmId),
            last_txn_date: targetDate,
        }).lean(),
    ]);

    console.log(`📊 sources: jubelio=${jubelioOrders.length} qbo=${qboInvoices.length} mongo=${mapEntries.length}`);

    // 2) Index for fast lookup.
    const mapBySoNo = new Map(mapEntries.map(m => [m.salesorder_no, m]));
    const qboByDocNum = new Map(qboInvoices.map(inv => [inv.DocNumber, inv]));

    // 3) Apply sync rule to every Jubelio order, classify into expected vs not.
    const expected = []; // { so, prefix, reason }
    const notExpected = []; // { so, prefix, reason }

    for (const so of jubelioOrders) {
        const prefix = getSoPrefix(so.salesorder_no);
        const { expected: shouldSync, reason } = applySyncRule(so);
        const entry = { so, prefix, reason };
        (shouldSync ? expected : notExpected).push(entry);
    }

    // 4) Three-way join — classify each "expected" SO.
    const matched = [];        // expected ✓ map ✓ qbo ✓
    const missingInQbo = [];   // expected ✓ map ✗ qbo ✗ (NEVER SYNCED — likely bug)
    const voidedInQbo = [];    // expected ✓ map ✓ qbo ✗ (deleted/voided in QBO)
    const mapMissingQbo = [];  // expected ✓ map ✗ qbo ✓ (manual create matches by chance)

    for (const e of expected) {
        const so = e.so;
        const map = mapBySoNo.get(so.salesorder_no);
        // QBO truncates DocNumber to 21 chars. Match by prefix.
        const docNumberKey = String(so.salesorder_no).substring(0, 21);
        const inv = qboByDocNum.get(docNumberKey);

        const debugCtx = {
            salesorder_no: so.salesorder_no,
            salesorder_id: so.salesorder_id,
            prefix: e.prefix,
            channel: channelLabel(e.prefix, so.source_name || so.source),
            source_name: so.source_name || so.source || null,
            store_name: so.store_name || null,
            customer_name: so.customer_name || so.shipping_full_name || null,
            status: so.status || so.internal_status || so.wms_status || null,
            transaction_date_raw: so.transaction_date || null,
            transaction_date_jkt: isoDateJakarta(so.transaction_date),
            grand_total: so.grand_total != null ? Number(so.grand_total) : null,
            invoice_no: so.invoice_no || null,
            tracking_no: so.tracking_no || so.tracking_number || null,
            map_qbo_invoice_id: map?.qbo_invoice_id || null,
            map_last_status: map?.last_status || null,
            map_last_synced_at: map?.last_synced_at || null,
            qbo_invoice_id: inv?.Id || null,
            qbo_total: inv?.TotalAmt || null,
            qbo_balance: inv?.Balance || null,
            sync_rule_reason: e.reason,
        };

        if (map && inv) {
            matched.push(debugCtx);
        } else if (!map && !inv) {
            missingInQbo.push({ ...debugCtx, why: 'No JubelioOrderMap entry AND no QBO invoice — webhook never fired or never reached SHIPPED/COMPLETED before query window' });
        } else if (map && !inv) {
            voidedInQbo.push({ ...debugCtx, why: 'JubelioOrderMap exists but QBO invoice not found — likely deleted/voided in QBO directly' });
        } else if (!map && inv) {
            mapMissingQbo.push({ ...debugCtx, why: 'QBO invoice exists with matching DocNumber but no JubelioOrderMap — possibly manual entry or out-of-window webhook' });
        }
    }

    // 5) Stale: canceled SOs that still have an active QBO invoice (should have been voided).
    const stale = [];
    for (const e of notExpected) {
        if (!e.so.is_canceled) continue;
        const map = mapBySoNo.get(e.so.salesorder_no);
        const inv = qboByDocNum.get(String(e.so.salesorder_no).substring(0, 21));
        if (!inv) continue;
        const isVoidLike = inv.Balance === 0 && inv.TotalAmt === 0;
        if (isVoidLike) continue;
        stale.push({
            salesorder_no: e.so.salesorder_no,
            salesorder_id: e.so.salesorder_id,
            prefix: e.prefix,
            channel: channelLabel(e.prefix, e.so.source_name),
            customer_name: e.so.customer_name || null,
            cancel_reason: e.so.cancel_reason || e.so.cancel_reason_detail || null,
            qbo_invoice_id: inv.Id,
            qbo_total: inv.TotalAmt,
            qbo_balance: inv.Balance,
            map_qbo_invoice_id: map?.qbo_invoice_id || null,
            why: 'Jubelio is_canceled=true but QBO invoice still active (not voided) — webhook for cancellation may have failed',
        });
    }

    // 6) Orphans: QBO invoices for the day with no Jubelio match (manual entries).
    const expectedSoNos = new Set(expected.map(e => String(e.so.salesorder_no).substring(0, 21)));
    const allJubelioSoNos = new Set(jubelioOrders.map(s => String(s.salesorder_no).substring(0, 21)));
    const orphan = [];
    for (const inv of qboInvoices) {
        if (allJubelioSoNos.has(inv.DocNumber)) continue;
        // Skip Jubelio-prefixed invoices that just don't appear in our 3 list endpoints (could be a different status not covered).
        // We still surface them — operator can spot real orphans vs status-coverage gaps.
        orphan.push({
            qbo_invoice_id: inv.Id,
            doc_number: inv.DocNumber,
            qbo_total: inv.TotalAmt,
            qbo_balance: inv.Balance,
            customer_ref: inv.CustomerRef?.value || null,
            why: 'QBO invoice for the day with DocNumber not present in Jubelio shipped+completed+canceled lists',
        });
    }

    // 7) Per-channel summary.
    const perChannel = {};
    for (const e of expected) {
        const k = e.prefix;
        perChannel[k] ??= { prefix: k, channel: channelLabel(k, e.so.source_name), expected: 0, matched: 0, missing: 0, voided: 0 };
        perChannel[k].expected++;
    }
    for (const m of matched) {
        perChannel[m.prefix].matched++;
    }
    for (const m of missingInQbo) {
        perChannel[m.prefix].missing++;
    }
    for (const m of voidedInQbo) {
        perChannel[m.prefix].voided++;
    }

    const report = {
        date: targetDate,
        runMs: Date.now() - t0,
        summary: {
            jubelioOrders: jubelioOrders.length,
            jubelioExpected: expected.length,
            jubelioNotExpected: notExpected.length,
            mongoMap: mapEntries.length,
            qboActual: qboInvoices.length,
            matched: matched.length,
            missing: missingInQbo.length,
            voided: voidedInQbo.length,
            stale: stale.length,
            orphan: orphan.length,
        },
        perChannel: Object.values(perChannel).sort((a, b) => b.expected - a.expected),
        mismatches: {
            missingInQbo,
            voidedInQbo,
            mapMissingQbo,
            stale,
            orphan,
        },
        fetchErrors,
        // notExpected is large (PENDING/PAID/PROCESSING) — only return count + sample.
        notExpectedSample: notExpected.slice(0, 20).map(e => ({
            salesorder_no: e.so.salesorder_no,
            prefix: e.prefix,
            status: e.so.status,
            is_canceled: e.so.is_canceled || false,
            reason: e.reason,
        })),
    };

    console.log(`✅ reconcile done in ${report.runMs}ms · matched=${report.summary.matched} missing=${report.summary.missing} voided=${report.summary.voided} stale=${report.summary.stale} orphan=${report.summary.orphan}`);
    return report;
};

module.exports = {
    runDailyReconcile,
    yesterdayWib,
    applySyncRule,
    channelLabel,
    getSoPrefix,
    fetchJubelioOrdersForDate,    // exported for QA tests
    itemMatchesDate,
};
