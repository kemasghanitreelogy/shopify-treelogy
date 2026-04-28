// End-to-end QA verification for Jubelio→QBO sync.
//
// For each JubelioOrderMap entry (every SO we've synced), verify:
//   1. QBO Invoice still exists and isn't voided
//   2. Invoice DocNumber matches salesorder_no (truncated to 21)
//   3. Invoice TxnDate matches Jubelio's payment_date (or transaction_date) per +8h
//   4. Invoice CustomerRef points to a valid, active customer
//   5. If SO status was PAID/COMPLETED → a Payment exists for that Invoice
//   6. Payment is fully applied (UnappliedAmt == 0, LinkedTxn includes invoice)
//   7. Payment.CustomerRef matches Invoice.CustomerRef (no orphan-customer)
//
// Reports each violation with full context so it can be triaged.

require('dotenv').config();
const mongoose = require('mongoose');
const QboService = require('../services/qboService');
const JubelioOrderMap = require('../models/JubelioOrderMap');

const TZ_OFFSET_MS = (Number(process.env.JUBELIO_TZ_OFFSET_HOURS) || 8) * 60 * 60 * 1000;
const isoDate = (raw) => {
    if (!raw) return null;
    const d = new Date(String(raw).trim());
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() + TZ_OFFSET_MS).toISOString().substring(0, 10);
};

const PAID_STATUSES = new Set(['PAID', 'COMPLETED']);

(async () => {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    const qbo = await QboService.getQboInstance();
    const baseUrl = qbo.useSandbox ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com';
    const realmId = String(qbo.realmId);

    const fetchQbo = async (path) => {
        const url = `${baseUrl}/v3/company/${realmId}${path}${path.includes('?') ? '&' : '?'}minorversion=65`;
        const r = await fetch(url, { headers: { Authorization: 'Bearer ' + qbo.token, Accept: 'application/json' }});
        const text = await r.text();
        let body; try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
        return { ok: r.ok, status: r.status, body };
    };

    const t0 = Date.now();
    const maps = await JubelioOrderMap.find({ qbo_realm_id: realmId, last_status: { $ne: 'VOIDED' } }).lean();
    console.log(`Scanning ${maps.length} JubelioOrderMap entries...`);

    // Bulk fetch all invoices once
    const invById = new Map();
    for (let s = 1; s < 30000; s += 200) {
        const r = await fetchQbo(`/query?query=${encodeURIComponent(`SELECT * FROM Invoice STARTPOSITION ${s} MAXRESULTS 200`)}`);
        const list = r.body?.QueryResponse?.Invoice || [];
        if (list.length === 0) break;
        for (const inv of list) invById.set(String(inv.Id), inv);
        if (list.length < 200) break;
    }
    console.log(`  Fetched ${invById.size} QBO invoices`);

    // Bulk fetch all payments
    const paymentsByInvoice = new Map(); // invoiceId → array of {payment, line}
    const paymentsByCustomer = new Map();
    for (let s = 1; s < 30000; s += 200) {
        const r = await fetchQbo(`/query?query=${encodeURIComponent(`SELECT * FROM Payment STARTPOSITION ${s} MAXRESULTS 200`)}`);
        const list = r.body?.QueryResponse?.Payment || [];
        if (list.length === 0) break;
        for (const p of list) {
            const cid = p.CustomerRef?.value;
            if (cid) {
                if (!paymentsByCustomer.has(cid)) paymentsByCustomer.set(cid, []);
                paymentsByCustomer.get(cid).push(p);
            }
            for (const l of p.Line || []) {
                for (const t of l.LinkedTxn || []) {
                    if (t.TxnType === 'Invoice') {
                        const k = String(t.TxnId);
                        if (!paymentsByInvoice.has(k)) paymentsByInvoice.set(k, []);
                        paymentsByInvoice.get(k).push({ payment: p, line: l });
                    }
                }
            }
        }
        if (list.length < 200) break;
    }
    console.log(`  Fetched payments — index by invoice=${paymentsByInvoice.size}, by customer=${paymentsByCustomer.size}`);

    // Bulk fetch customer Active flags
    const customerActive = new Map();
    for (let s = 1; s < 30000; s += 200) {
        const r = await fetchQbo(`/query?query=${encodeURIComponent(`SELECT Id, Active FROM Customer STARTPOSITION ${s} MAXRESULTS 200`)}`);
        const list = r.body?.QueryResponse?.Customer || [];
        if (list.length === 0) break;
        for (const c of list) customerActive.set(String(c.Id), c.Active !== false);
        if (list.length < 200) break;
    }

    const issues = {
        invoiceMissing: [],
        invoiceVoided: [],
        docNumberMismatch: [],
        txnDateDrift: [],
        customerInactive: [],
        paymentMissing: [],
        paymentUnapplied: [],
        paymentCustomerMismatch: [],
        balanceNotZero: [],
    };
    let okCount = 0;

    for (const m of maps) {
        const inv = invById.get(String(m.qbo_invoice_id));
        if (!inv) {
            issues.invoiceMissing.push({ so: m.salesorder_no, inv: m.qbo_invoice_id, lastStatus: m.last_status });
            continue;
        }
        if (inv.Voided === true) {
            issues.invoiceVoided.push({ so: m.salesorder_no, inv: inv.Id });
            continue;
        }
        const expectedDoc = String(m.salesorder_no || '').substring(0, 21);
        if (expectedDoc && String(inv.DocNumber || '') !== expectedDoc) {
            issues.docNumberMismatch.push({ so: m.salesorder_no, inv: inv.Id, qbo_doc: inv.DocNumber, expected: expectedDoc });
        }
        const dateRaw = m.last_payment_date_raw || m.last_transaction_date_raw;
        const expectedDate = dateRaw ? isoDate(dateRaw) : null;
        if (expectedDate && expectedDate !== inv.TxnDate) {
            issues.txnDateDrift.push({ so: m.salesorder_no, inv: inv.Id, qbo: inv.TxnDate, expected: expectedDate, src: m.last_payment_date_raw ? 'payment_date' : 'transaction_date' });
        }
        const custId = inv.CustomerRef?.value;
        if (custId && customerActive.has(custId) && !customerActive.get(custId)) {
            issues.customerInactive.push({ so: m.salesorder_no, inv: inv.Id, custId });
        }

        const wasPaid = PAID_STATUSES.has(String(m.last_status || '').toUpperCase());
        const linkedPmts = paymentsByInvoice.get(String(inv.Id)) || [];
        const balance = Number(inv.Balance || 0);

        if (wasPaid) {
            if (linkedPmts.length === 0) {
                issues.paymentMissing.push({ so: m.salesorder_no, inv: inv.Id, total: inv.TotalAmt, balance });
                continue;
            }
            // Find any payment that fully covers
            const sumLinked = linkedPmts.reduce((acc, x) => acc + Number(x.line?.Amount || 0), 0);
            if (Math.abs(sumLinked - Number(inv.TotalAmt || 0)) > 0.01) {
                issues.paymentUnapplied.push({ so: m.salesorder_no, inv: inv.Id, total: inv.TotalAmt, sumLinked });
            }
            // Cross-customer check on the first linked payment
            const firstP = linkedPmts[0].payment;
            if (firstP?.CustomerRef?.value && custId && String(firstP.CustomerRef.value) !== String(custId)) {
                issues.paymentCustomerMismatch.push({ so: m.salesorder_no, inv: inv.Id, invCust: custId, payCust: firstP.CustomerRef.value, payId: firstP.Id });
            }
            if (balance > 0.01) {
                issues.balanceNotZero.push({ so: m.salesorder_no, inv: inv.Id, balance, total: inv.TotalAmt });
            }
            okCount++;
        } else {
            // Not expected to be paid — invoice should still be open
            okCount++;
        }
    }

    console.log(`\n━━━ QA REPORT (${Date.now() - t0}ms) ━━━`);
    console.log(`Total scanned: ${maps.length}`);
    console.log(`OK (no issues): ${maps.length - Object.values(issues).reduce((a, x) => a + x.length, 0)}`);
    console.log();
    for (const [k, v] of Object.entries(issues)) {
        console.log(`${k}: ${v.length}`);
        for (const i of v.slice(0, 5)) console.log(`  ${JSON.stringify(i).slice(0, 240)}`);
        if (v.length > 5) console.log(`  ... and ${v.length - 5} more`);
    }

    await mongoose.disconnect();
    process.exit(Object.values(issues).reduce((a, x) => a + x.length, 0) > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
