// Admin endpoints — protected by ADMIN_TOKEN (header `x-admin-token` or query
// `?token=`). Used by Vercel Cron and manual ops.

const express = require('express');
const router = express.Router();
const JubelioOrderMap = require('../models/JubelioOrderMap');
const { getQboInstance } = require('../services/qboService');
const { alertAuditReport } = require('../services/alertService');

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

// GET/POST /api/admin/audit-txndate?days=14&fix=1
// Scans recent JubelioOrderMap entries, fetches each QBO Invoice, verifies
// TxnDate, and (if fix=1) auto-patches mismatches that have ground truth.
router.all('/audit-txndate', requireAdmin, async (req, res) => {
    const days = Number(req.query.days || 14);
    const doFix = String(req.query.fix || '0') === '1';
    const t0 = Date.now();

    try {
        const qbo = await getQboInstance();
        const filter = days > 0 ? { last_synced_at: { $gte: new Date(Date.now() - days * 86400000) } } : {};
        const rows = await JubelioOrderMap.find(filter)
            .select('salesorder_no qbo_invoice_id last_transaction_date_raw')
            .lean();

        const shopeeFix = [], verifiedFix = [], legacyReport = [], errors = [];
        for (const r of rows) {
            const { inv, err } = await getInvoice(qbo, r.qbo_invoice_id);
            if (err) {
                if (!/Object Not Found|6240|404/i.test(err)) errors.push({ so: r.salesorder_no, inv: r.qbo_invoice_id, err });
                continue;
            }
            const shopeeDate = parseShopeeDate(r.salesorder_no);
            if (shopeeDate) {
                if (inv.TxnDate !== shopeeDate) shopeeFix.push({ so: r.salesorder_no, inv: r.qbo_invoice_id, qbo: inv.TxnDate, expected: shopeeDate, syncToken: inv.SyncToken });
                continue;
            }
            if (r.last_transaction_date_raw) {
                const expected = isoDateJakarta(r.last_transaction_date_raw);
                if (expected && inv.TxnDate !== expected) verifiedFix.push({ so: r.salesorder_no, inv: r.qbo_invoice_id, qbo: inv.TxnDate, expected, syncToken: inv.SyncToken });
                continue;
            }
            const jktCreate = isoDateJakarta(inv.MetaData?.CreateTime);
            if (jktCreate && inv.TxnDate && dayDiff(jktCreate, inv.TxnDate) === 1) {
                legacyReport.push({ so: r.salesorder_no, inv: r.qbo_invoice_id, qbo: inv.TxnDate, jktCreate });
            }
        }

        const fixed = [];
        if (doFix) {
            for (const m of [...shopeeFix, ...verifiedFix]) {
                try {
                    const updated = await updateInvoice(qbo, { Id: m.inv, SyncToken: m.syncToken, sparse: true, TxnDate: m.expected });
                    fixed.push({ so: m.so, inv: m.inv, from: m.qbo, to: updated.TxnDate });
                } catch (e) {
                    errors.push({ so: m.so, inv: m.inv, err: e.message || 'updateInvoice failed' });
                }
            }
        }

        const totalMismatch = shopeeFix.length + verifiedFix.length + legacyReport.length;
        alertAuditReport({
            scope: `${days}d (cron)`,
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
            legacyFlagOnly: legacyReport.length,
            errors: errors.length,
            fixed: fixed.length,
            durationMs: Date.now() - t0,
            details: doFix ? { fixed, errors: errors.slice(0, 20) } : { shopeeFix, verifiedFix, legacyReport: legacyReport.slice(0, 20), errors: errors.slice(0, 20) },
        });
    } catch (e) {
        console.error('❌ audit-txndate failed:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

module.exports = router;
