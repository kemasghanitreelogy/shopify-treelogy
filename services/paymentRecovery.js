// Recover Payments that exist in QBO but aren't applied to any Invoice.
//
// Common cause: integration created Payment for a customer (e.g. id 14151
// "A*** y***nto" — the redacted Tokopedia name), then someone manually
// merged/edited the Invoice to point at a different customer record (e.g.
// id 14324 "TP - Adha Yuwanto"). The Payment's CustomerRef stayed at 14151,
// while the Invoice's CustomerRef became 14324 — QBO will not apply a payment
// across customers, so it shows as "Unapplied".
//
// Recovery strategy per orphan Payment:
//   1. Parse Jubelio SO# from PrivateNote ("Auto-paid from Jubelio SO #...")
//   2. Look up qbo_invoice_id via JubelioOrderMap
//   3. Verify Invoice exists, balance matches Payment amount, customer differs
//   4. Update Payment: change CustomerRef to invoice.CustomerRef + add LinkedTxn
//   5. (Optional) report stale customer record (the original Payment customer)
//      so operator can inactivate / merge in QBO UI
//
// Dry-run by default; ?apply=1 to write.

const JubelioOrderMap = require('../models/JubelioOrderMap');

const qboBaseUrl = (qbo) => {
    const host = qbo.useSandbox ? 'sandbox-quickbooks.api.intuit.com' : 'quickbooks.api.intuit.com';
    return `https://${host}/v3/company/${qbo.realmId}`;
};

const qboFetch = async (qbo, path, opts = {}) => {
    const url = `${qboBaseUrl(qbo)}${path}${path.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
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
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) {
        const err = new Error(`QBO ${opts.method || 'GET'} ${path} (${res.status}): ${JSON.stringify(body).slice(0, 400)}`);
        err.status = res.status;
        err.body = body;
        throw err;
    }
    return body;
};

// 1) Find all unapplied/orphan Payments — UnappliedAmt > 0 OR no LinkedTxn.
const findOrphanPayments = async (qbo) => {
    const out = [];
    const PAGE = 200;
    for (let startPosition = 1; startPosition < 5000; startPosition += PAGE) {
        const q = `SELECT * FROM Payment STARTPOSITION ${startPosition} MAXRESULTS ${PAGE}`;
        const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const payments = body?.QueryResponse?.Payment || [];
        if (payments.length === 0) break;
        for (const p of payments) {
            const linkedAny = (p.Line || []).some(l => (l.LinkedTxn || []).length > 0);
            const isOrphan = !linkedAny || Number(p.UnappliedAmt || 0) > 0;
            if (isOrphan) out.push(p);
        }
        if (payments.length < PAGE) break;
    }
    return out;
};

// 2) Parse Jubelio SO# from PrivateNote (we put it there at creation time).
const extractSoNoFromPrivateNote = (note) => {
    if (!note) return null;
    const m = String(note).match(/Jubelio SO #([A-Z0-9-]+)/i);
    return m ? m[1] : null;
};

// 3) Update a Payment: rewire CustomerRef + LinkedTxn (sparse update).
const rewirePayment = async (qbo, payment, newCustomerId, invoiceId, invoiceTotal) => {
    const newLines = [{
        Amount: Number(payment.TotalAmt),
        LinkedTxn: [{ TxnId: String(invoiceId), TxnType: 'Invoice' }],
    }];
    return qboFetch(qbo, '/payment', {
        method: 'POST',
        body: JSON.stringify({
            Id: payment.Id,
            SyncToken: payment.SyncToken,
            sparse: true,
            CustomerRef: { value: String(newCustomerId) },
            Line: newLines,
        }),
    });
};

const runOrphanPaymentRecovery = async ({ qbo, apply = false }) => {
    const t0 = Date.now();
    const mode = apply ? 'APPLY' : 'DRY-RUN';
    console.log(`\n🔧 Orphan payment recovery (${mode})\n`);

    const orphans = await findOrphanPayments(qbo);
    console.log(`Found ${orphans.length} orphan/unapplied payments`);

    const report = {
        apply, mode, runMs: 0,
        totalOrphans: orphans.length,
        actions: [],
        summary: {
            recovered: 0,
            skippedNoSoNote: 0,
            skippedNoMap: 0,
            skippedInvoiceMissing: 0,
            skippedAmountMismatch: 0,
            skippedSameCustomer: 0,
            skippedInvoicePaid: 0,
            errors: 0,
        },
    };

    for (const p of orphans) {
        const action = {
            paymentId: p.Id,
            currentCustomerId: p.CustomerRef?.value,
            currentCustomerName: p.CustomerRef?.name,
            totalAmt: Number(p.TotalAmt),
            unappliedAmt: Number(p.UnappliedAmt || 0),
            note: (p.PrivateNote || '').slice(0, 100),
        };

        try {
            const soNo = extractSoNoFromPrivateNote(p.PrivateNote);
            if (!soNo) {
                action.skipped = 'no Jubelio SO# in PrivateNote';
                report.summary.skippedNoSoNote++;
                report.actions.push(action);
                continue;
            }
            action.soNo = soNo;

            const map = await JubelioOrderMap.findOne({ salesorder_no: soNo, qbo_realm_id: String(qbo.realmId) }).lean();
            if (!map?.qbo_invoice_id) {
                action.skipped = 'no JubelioOrderMap entry for SO';
                report.summary.skippedNoMap++;
                report.actions.push(action);
                continue;
            }
            action.invoiceId = map.qbo_invoice_id;

            let inv;
            try {
                const invBody = await qboFetch(qbo, `/invoice/${map.qbo_invoice_id}`);
                inv = invBody?.Invoice;
            } catch (e) {
                action.skipped = `invoice fetch failed: ${e.message?.slice(0, 100)}`;
                report.summary.skippedInvoiceMissing++;
                report.actions.push(action);
                continue;
            }
            if (!inv) {
                action.skipped = 'invoice not found';
                report.summary.skippedInvoiceMissing++;
                report.actions.push(action);
                continue;
            }

            action.invoiceCustomerId = inv.CustomerRef?.value;
            action.invoiceCustomerName = inv.CustomerRef?.name;
            action.invoiceBalance = Number(inv.Balance || 0);
            action.invoiceTotal = Number(inv.TotalAmt || 0);

            // Skip if invoice already paid (Balance=0) — then payment unapplied
            // is harmless extra credit; needs operator review, not auto-rewire.
            if (Number(inv.Balance || 0) <= 0) {
                action.skipped = 'invoice already fully paid (Balance=0); payment is overpayment';
                report.summary.skippedInvoicePaid++;
                report.actions.push(action);
                continue;
            }

            if (Math.abs(Number(p.TotalAmt) - Number(inv.Balance)) > 0.01) {
                action.skipped = `amount mismatch: payment=${p.TotalAmt} invoice.balance=${inv.Balance}`;
                report.summary.skippedAmountMismatch++;
                report.actions.push(action);
                continue;
            }

            if (String(p.CustomerRef?.value) === String(inv.CustomerRef?.value)) {
                // Same customer — just need to add the LinkedTxn.
                action.action = 'relink-same-customer';
            } else {
                action.action = 'rewire-customer-and-link';
            }

            if (apply) {
                try {
                    await rewirePayment(qbo, p, inv.CustomerRef.value, map.qbo_invoice_id, inv.TotalAmt);
                    action.applied = true;
                    report.summary.recovered++;
                    console.log(`  ✅ Payment ${p.Id} rewired: cust ${action.currentCustomerId}→${action.invoiceCustomerId}, linked to invoice ${map.qbo_invoice_id}`);
                } catch (e) {
                    action.applied = false;
                    action.error = e.message?.slice(0, 300);
                    report.summary.errors++;
                    console.log(`  ❌ Payment ${p.Id}: ${action.error}`);
                }
            } else {
                console.log(`  📝 Would rewire Payment ${p.Id}: cust ${action.currentCustomerId} (${action.currentCustomerName}) → ${action.invoiceCustomerId} (${action.invoiceCustomerName}) + link to invoice ${map.qbo_invoice_id}`);
            }
        } catch (e) {
            action.error = e.message?.slice(0, 300);
            report.summary.errors++;
            console.error(`  💥 Payment ${p.Id}: ${e.message}`);
        }

        report.actions.push(action);
    }

    report.runMs = Date.now() - t0;
    console.log(`\n✅ ${mode} done in ${report.runMs}ms · recovered=${report.summary.recovered} errors=${report.summary.errors}`);
    return report;
};

module.exports = { runOrphanPaymentRecovery };
