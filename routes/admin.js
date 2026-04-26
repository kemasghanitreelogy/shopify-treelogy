// Admin endpoints — protected by ADMIN_TOKEN (header `x-admin-token` or query
// `?token=`). Used by Vercel Cron and manual ops.

const express = require('express');
const router = express.Router();
const JubelioOrderMap = require('../models/JubelioOrderMap');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const { getQboInstance } = require('../services/qboService');
const { alertAuditReport, alertResyncResult, alertDailyReconcile } = require('../services/alertService');
const { runDailyReconcile, yesterdayWib } = require('../services/dailyReconcile');

// Accepts EITHER the manual ADMIN_TOKEN (for ops-driven calls) OR the Vercel-
// managed CRON_SECRET (auto-attached by Vercel Cron as Bearer token). At
// least one of the two env vars must be set.
const requireAdmin = (req, res, next) => {
    const adminToken = process.env.ADMIN_TOKEN;
    const cronSecret = process.env.CRON_SECRET;
    if (!adminToken && !cronSecret) return res.status(500).json({ error: 'No admin auth configured (set ADMIN_TOKEN or CRON_SECRET)' });
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const got = req.headers['x-admin-token'] || req.query.token || bearer;
    if (!got) return res.status(401).json({ error: 'Unauthorized' });
    if (adminToken && got === adminToken) return next();
    if (cronSecret && got === cronSecret) return next();
    return res.status(401).json({ error: 'Unauthorized' });
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
const parseShopeeDate = (soNo) => {
    const m = String(soNo || '').match(/^SP-(\d{2})(\d{2})(\d{2})/);
    if (!m) return null;
    const [, yy, mm, dd] = m;
    const year = Number(yy) >= 70 ? `19${yy}` : `20${yy}`;
    const date = `${year}-${mm}-${dd}`;
    const d = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    return date;
};

const getInvoice = (qbo, id) => new Promise((resolve) => {
    qbo.getInvoice(id, (err, body) => err ? resolve({ err: String(err.message || err).slice(0, 200) }) : resolve({ inv: body }));
});
const updateInvoice = (qbo, payload) => new Promise((resolve, reject) => {
    qbo.updateInvoice(payload, (err, body) => err ? reject(err) : resolve(body));
});

// GET/POST /api/admin/audit-txndate?days=14&fix=1&all=1&notify=1
//   days   — lookback window (default 14, 0 = all time)
//   fix    — set to 1 to auto-patch mismatches (default report-only)
//   all    — also auto-fix legacy non-Shopee gap=1d (default off)
//   notify — set to 0 to suppress per-invoice Telegram alerts (default on if fix=1)
//
// Scans JubelioOrderMap, fetches each QBO Invoice, verifies TxnDate, and
// (when fix=1) re-syncs the invoice via sparse update. Per-invoice resync
// outcome is sent to Telegram so the operator gets a granular trail.
router.all('/audit-txndate', requireAdmin, async (req, res) => {
    const days = Number(req.query.days || 14);
    const doFix = String(req.query.fix || '0') === '1';
    const allChannels = String(req.query.all || '0') === '1';
    const notify = String(req.query.notify ?? '1') === '1';
    const t0 = Date.now();

    try {
        const qbo = await getQboInstance();
        const filter = days > 0 ? { last_synced_at: { $gte: new Date(Date.now() - days * 86400000) } } : {};
        const rows = await JubelioOrderMap.find(filter)
            .select('salesorder_no qbo_invoice_id last_transaction_date_raw')
            .lean();

        const shopeeFix = [], verifiedFix = [], legacyFix = [], legacyReport = [], errors = [];
        for (const r of rows) {
            const { inv, err } = await getInvoice(qbo, r.qbo_invoice_id);
            if (err) {
                if (!/Object Not Found|6240|404/i.test(err)) errors.push({ so: r.salesorder_no, inv: r.qbo_invoice_id, err });
                continue;
            }
            const shopeeDate = parseShopeeDate(r.salesorder_no);
            if (shopeeDate) {
                if (inv.TxnDate !== shopeeDate) shopeeFix.push({ so: r.salesorder_no, inv: r.qbo_invoice_id, qbo: inv.TxnDate, expected: shopeeDate, syncToken: inv.SyncToken, layer: 'SHOPEE' });
                continue;
            }
            if (r.last_transaction_date_raw) {
                const expected = isoDateJakarta(r.last_transaction_date_raw);
                if (expected && inv.TxnDate !== expected) verifiedFix.push({ so: r.salesorder_no, inv: r.qbo_invoice_id, qbo: inv.TxnDate, expected, syncToken: inv.SyncToken, layer: 'VERIFIED' });
                continue;
            }
            const jktCreate = isoDateJakarta(inv.MetaData?.CreateTime);
            if (!jktCreate || !inv.TxnDate) continue;
            if (dayDiff(jktCreate, inv.TxnDate) === 1) {
                if (allChannels) {
                    legacyFix.push({ so: r.salesorder_no, inv: r.qbo_invoice_id, qbo: inv.TxnDate, expected: jktCreate, syncToken: inv.SyncToken, layer: 'LEGACY' });
                } else {
                    legacyReport.push({ so: r.salesorder_no, inv: r.qbo_invoice_id, qbo: inv.TxnDate, jktCreate });
                }
            }
        }

        const fixed = [];
        if (doFix) {
            const queue = [...shopeeFix, ...verifiedFix, ...(allChannels ? legacyFix : [])];
            for (const m of queue) {
                try {
                    const updated = await updateInvoice(qbo, { Id: m.inv, SyncToken: m.syncToken, sparse: true, TxnDate: m.expected });
                    fixed.push({ so: m.so, inv: m.inv, layer: m.layer, from: m.qbo, to: updated.TxnDate });
                    if (notify) alertResyncResult({ ok: true, so: m.so, invoiceId: m.inv, layer: m.layer, fromDate: m.qbo, toDate: updated.TxnDate });
                } catch (e) {
                    const errMsg = e.message || 'updateInvoice failed';
                    errors.push({ so: m.so, inv: m.inv, err: errMsg });
                    if (notify) alertResyncResult({ ok: false, so: m.so, invoiceId: m.inv, layer: m.layer, fromDate: m.qbo, toDate: m.expected, error: errMsg });
                }
            }
        }

        const totalMismatch = shopeeFix.length + verifiedFix.length + legacyFix.length + legacyReport.length;
        alertAuditReport({
            scope: `${days}d${allChannels ? ' all-channels' : ''} (cron)`,
            scanned: rows.length,
            mismatches: totalMismatch,
            fixed: fixed.length,
            errors: errors.length,
        });

        res.json({
            ok: true,
            scanned: rows.length,
            shopeeMismatches: shopeeFix.length,
            verifiedMismatches: verifiedFix.length,
            legacyFix: legacyFix.length,
            legacyFlagOnly: legacyReport.length,
            errors: errors.length,
            fixed: fixed.length,
            durationMs: Date.now() - t0,
            details: doFix
                ? { fixed, errors: errors.slice(0, 20) }
                : { shopeeFix, verifiedFix, legacyFix, legacyReport: legacyReport.slice(0, 20), errors: errors.slice(0, 20) },
        });
    } catch (e) {
        console.error('❌ audit-txndate failed:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET /api/admin/order-raw?so=SHF-7378-128887 (or ?id=431)
//   so     — salesorder_no (exact match)
//   id     — salesorder_id (numeric)
//   limit  — max payload logs to return (default 10, max 50)
//
// Returns the JubelioOrderMap entry + full captured webhook payloads (newest
// first). Use to inspect raw `transaction_date`, `created_date`, channel info,
// etc. for any synced SO. Payload capture retention = 30 days (TTL).
router.get('/order-raw', requireAdmin, async (req, res) => {
    const so = req.query.so ? String(req.query.so).trim() : null;
    const id = req.query.id ? Number(req.query.id) : null;
    const limit = Math.min(Number(req.query.limit || 10), 50);

    if (!so && !id) {
        return res.status(400).json({ error: 'Provide ?so=<salesorder_no> or ?id=<salesorder_id>' });
    }

    try {
        const mapFilter = so ? { salesorder_no: so } : { salesorder_id: id };
        const logFilter = {};
        if (so) logFilter.salesorder_no = so;
        if (id) logFilter.salesorder_id = id;

        const [map, logs] = await Promise.all([
            JubelioOrderMap.findOne(mapFilter).lean(),
            JubelioPayloadLog.find(logFilter).sort({ received_at: -1 }).limit(limit).lean(),
        ]);

        res.json({
            ok: true,
            query: { so, id, limit },
            map: map || null,
            payloadCount: logs.length,
            payloads: logs,
        });
    } catch (e) {
        console.error('❌ order-raw failed:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// GET/POST /api/admin/daily-reconcile?date=YYYY-MM-DD&notify=1&debug=0
//   date   — target date in WIB (YYYY-MM-DD). Defaults to yesterday WIB.
//   notify — 1 (default) sends Telegram report; 0 returns JSON only
//   debug  — 1 includes full mismatch detail in JSON response (default 1)
//
// Daily run reconciles Jubelio orders for the target date against QBO invoices,
// applying our sync algorithm to determine which SOs *should* have made it
// into QBO. Mismatches are returned with full per-SO debug context (status,
// raw transaction_date, tracking, customer, etc.) so the operator can debug
// without digging into MongoDB or Jubelio UI manually.
router.all('/daily-reconcile', requireAdmin, async (req, res) => {
    const targetDate = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
        ? req.query.date
        : yesterdayWib();
    const notify = String(req.query.notify ?? '1') === '1';
    const debug = String(req.query.debug ?? '1') === '1';

    try {
        const qbo = await getQboInstance();
        const report = await runDailyReconcile({ qbo, date: targetDate });

        if (notify) alertDailyReconcile(report);

        const response = {
            ok: true,
            date: report.date,
            runMs: report.runMs,
            summary: report.summary,
            perChannel: report.perChannel,
            fetchErrors: report.fetchErrors,
        };
        if (debug) {
            response.mismatches = report.mismatches;
            response.notExpectedSample = report.notExpectedSample;
        }
        res.json(response);
    } catch (e) {
        console.error('❌ daily-reconcile failed:', e.message);
        res.status(500).json({ ok: false, date: targetDate, error: e.message, stack: e.stack?.split('\n').slice(0, 6).join('\n') });
    }
});

module.exports = router;
