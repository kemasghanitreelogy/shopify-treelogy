// Re-link partially-applied QBO Payment to its Invoice so Invoice.Balance = 0.
//
// Background: scripts/canonicalSync.js (sync-integrated) on 2026-04-28 mis-
// identified bundle for invoice 69566, replaced its Line[] with components
// summing 860k. QBO auto-reduced Payment 69567's LinkedTxn amount from 1.180k
// to 860k and parked the 320k difference as Payment.UnappliedAmt. Later
// redirect-bundle-invoices.js restored Invoice.TotalAmt to 1.180k but did not
// touch Payment, leaving Invoice.Balance = 320k. Payment.TotalAmt = 1.180k
// (full money already received), so fix is purely re-application of the
// existing 320k credit — no money movement.
//
// Usage:
//   node scripts/relink-payment.js                 # dry-run
//   node scripts/relink-payment.js --apply         # apply
//
// Preconditions (refused if any fail):
//   - Payment.TotalAmt == expectedTotal
//   - Payment.UnappliedAmt == (expectedTotal - currentApplied)
//   - Invoice.TotalAmt == expectedTotal
//   - Invoice.Balance == (expectedTotal - currentApplied)
//   - Payment has exactly 1 Line linking to this Invoice
//
// Idempotent: if Invoice.Balance is already 0, skips.

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');

const apply = process.argv.includes('--apply');

const TARGETS = [
    {
        salesorder_no: 'SHF-7390-128887',
        qboInvoiceId: '69566',
        qboPaymentId: '69567',
        expectedTotal: 1180000,
        currentApplied: 860000,  // expected broken state
    },
];

const qboBaseUrl = (qbo) => `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;

const qboFetch = async (qbo, p, opts = {}) => {
    const url = `${qboBaseUrl(qbo)}${p}${p.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
    const res = await fetch(url, {
        ...opts,
        headers: {
            Authorization: `Bearer ${qbo.token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(opts.headers || {}),
        },
    });
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(`QBO ${opts.method || 'GET'} ${p} (${res.status}): ${JSON.stringify(body).slice(0, 600)}`);
    return body;
};

const fmt = (n) => (n || 0).toLocaleString('id-ID');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const auditFile = `relink-payment-audit-${ts}.jsonl`;
    const audit = (e) => fs.appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');

    console.log(`\nRELINK  ${TARGETS.length} payment(s)  mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
    console.log(`audit: ${auditFile}\n`);

    const stats = { ok: 0, skipped: 0, refused: 0, applied: 0, errors: 0 };

    for (const t of TARGETS) {
        try {
            const invBody = await qboFetch(qbo, `/invoice/${t.qboInvoiceId}`);
            const inv = invBody?.Invoice;
            const payBody = await qboFetch(qbo, `/payment/${t.qboPaymentId}`);
            const pay = payBody?.Payment;
            if (!inv || !pay) throw new Error('invoice or payment not found');

            console.log(`━━━ ${t.salesorder_no}`);
            console.log(`    Invoice ${inv.Id} (doc=${inv.DocNumber})  TotalAmt=Rp ${fmt(inv.TotalAmt)}  Balance=Rp ${fmt(inv.Balance)}  syncToken=${inv.SyncToken}`);
            console.log(`    Payment ${pay.Id} (date=${pay.TxnDate})  TotalAmt=Rp ${fmt(pay.TotalAmt)}  UnappliedAmt=Rp ${fmt(pay.UnappliedAmt)}  syncToken=${pay.SyncToken}`);

            // Idempotency check — already healthy
            if (inv.Balance === 0) {
                console.log(`    SKIP: Invoice.Balance already 0\n`);
                audit({ ...t, status: 'skipped_already_healthy', invoiceBalance: inv.Balance });
                stats.skipped++;
                continue;
            }

            // Locate target payLine (the one linking to THIS invoice)
            const paymentLines = pay.Line || [];
            const linesForThisInv = paymentLines.filter(pl =>
                (pl.LinkedTxn || []).some(plt => plt.TxnId === inv.Id && plt.TxnType === 'Invoice')
            );
            if (linesForThisInv.length !== 1) {
                console.log(`    REFUSE: Payment has ${linesForThisInv.length} Line(s) linking to invoice (expected exactly 1)\n`);
                audit({ ...t, status: 'refused_unexpected_line_count', count: linesForThisInv.length });
                stats.refused++;
                continue;
            }
            const currentLineAmount = linesForThisInv[0].Amount || 0;

            // Hard precondition checks — refuse if any state diverges
            const checks = [
                { name: 'Payment.TotalAmt == expected', ok: pay.TotalAmt === t.expectedTotal, got: pay.TotalAmt, want: t.expectedTotal },
                { name: 'Invoice.TotalAmt == expected', ok: inv.TotalAmt === t.expectedTotal, got: inv.TotalAmt, want: t.expectedTotal },
                { name: 'Payment.Line.Amount == currentApplied', ok: currentLineAmount === t.currentApplied, got: currentLineAmount, want: t.currentApplied },
                { name: 'Invoice.Balance == expected - applied', ok: inv.Balance === (t.expectedTotal - t.currentApplied), got: inv.Balance, want: t.expectedTotal - t.currentApplied },
                { name: 'Payment.UnappliedAmt == diff', ok: (pay.UnappliedAmt || 0) === (t.expectedTotal - t.currentApplied), got: pay.UnappliedAmt || 0, want: t.expectedTotal - t.currentApplied },
            ];
            const failed = checks.filter(c => !c.ok);
            if (failed.length) {
                console.log(`    REFUSE: precondition failed:`);
                for (const f of failed) console.log(`      • ${f.name}  got=${fmt(f.got)} want=${fmt(f.want)}`);
                console.log();
                audit({ ...t, status: 'refused_precondition', failed });
                stats.refused++;
                continue;
            }

            console.log(`    PLAN: Payment.Line[0].Amount  Rp ${fmt(currentLineAmount)} → Rp ${fmt(t.expectedTotal)}`);
            console.log(`          Invoice.Balance         Rp ${fmt(inv.Balance)} → Rp 0`);

            // Build sparse update payload — keep PrivateNote, CustomerRef, TxnDate intact
            const updatedLine = {
                ...linesForThisInv[0],
                Amount: t.expectedTotal,
                LinkedTxn: [{ TxnId: inv.Id, TxnType: 'Invoice' }],
            };
            const newLines = paymentLines.map(pl => pl === linesForThisInv[0] ? updatedLine : pl);
            // QBO Payment sparse update still requires CustomerRef + TotalAmt
            // explicitly (validation quirk, code=2020). TotalAmt MUST equal
            // sum of Line[].Amount or QBO will recompute and reject.
            const payload = {
                Id: pay.Id,
                SyncToken: pay.SyncToken,
                sparse: true,
                CustomerRef: pay.CustomerRef,
                TotalAmt: pay.TotalAmt,
                Line: newLines,
            };

            audit({ ...t, action: 'plan', dryRun: !apply, payload });

            if (!apply) {
                console.log(`    DRY-RUN — no changes\n`);
                stats.ok++;
                continue;
            }

            const updated = await qboFetch(qbo, '/payment', { method: 'POST', body: JSON.stringify(payload) });
            const newPay = updated?.Payment;

            // Verify post-state
            const verifyInvBody = await qboFetch(qbo, `/invoice/${inv.Id}`);
            const verifyInv = verifyInvBody?.Invoice;
            const newApplied = (newPay.Line || [])
                .filter(pl => (pl.LinkedTxn || []).some(plt => plt.TxnId === inv.Id))
                .reduce((s, pl) => s + (pl.Amount || 0), 0);

            console.log(`    APPLIED  newPaymentSyncToken=${newPay?.SyncToken}  newPayment.UnappliedAmt=Rp ${fmt(newPay.UnappliedAmt)}  newApplied=Rp ${fmt(newApplied)}`);
            console.log(`             invoice.Balance after = Rp ${fmt(verifyInv?.Balance)}  ${verifyInv?.Balance === 0 ? '✓' : '⚠️'}`);

            audit({
                ...t, status: verifyInv?.Balance === 0 ? 'applied' : 'applied_balance_nonzero',
                newPaymentSyncToken: newPay?.SyncToken,
                newApplied,
                invoiceBalanceAfter: verifyInv?.Balance,
                paymentUnappliedAfter: newPay.UnappliedAmt,
            });

            if (verifyInv?.Balance === 0) stats.applied++;
            else stats.errors++;
            console.log();
        } catch (e) {
            console.error(`    ERROR  ${t.salesorder_no}: ${e.message.slice(0, 500)}`);
            audit({ ...t, status: 'error', error: e.message });
            stats.errors++;
            console.log();
        }
    }

    console.log(`SUMMARY  ok=${stats.ok}  skipped=${stats.skipped}  refused=${stats.refused}  applied=${stats.applied}  errors=${stats.errors}`);
    console.log(`audit: ${auditFile}`);
    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
