// Read-only sweep: find all QBO invoices from Jubelio integration with
// Balance > 0, classify the cause, export CSV for finance + JSON for tooling.
//
// Categories:
//   A. UNDERAPPLIED       — has linked Payment, sum(Payment.Line.Amount) < Invoice.TotalAmt
//                          (the relink-payment.js fix pattern — bug)
//   B. PARTIAL_PAYMENT    — has linked Payment but Payment.TotalAmt itself is < Invoice.TotalAmt
//                          (Jubelio sent partial payment, or marketplace fee adjustment)
//   C. NO_PAYMENT         — no linked Payment at all (legitimate unpaid: term=Net14/COD/etc)
//   D. OVERPAYMENT_DELTA  — Payment.TotalAmt > Invoice.TotalAmt but UnappliedAmt > 0
//                          (over-applied due to backfill marketplace fee, finance manual)
//   E. OTHER              — anything else (worth manual look)
//
// Usage:
//   node scripts/sweep-balance-due.js

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');

const CHANNEL_PREFIXES = ['SHF-', 'SP-', 'TP-', 'LB-', 'CS-', 'DP-', 'DW-'];
const PAGE_SIZE = 200;
const MAX_PAGES = 100;  // hard upper bound to avoid runaway

const qboBaseUrl = (qbo) => `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;

const qboFetch = async (qbo, p) => {
    const url = `${qboBaseUrl(qbo)}${p}${p.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${qbo.token}`,
            Accept: 'application/json',
        },
    });
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(`QBO GET ${p} (${res.status}): ${JSON.stringify(body).slice(0, 600)}`);
    return body;
};

const fmt = (n) => (n || 0).toLocaleString('id-ID');

const isJubelioInvoice = (inv) => {
    const doc = inv.DocNumber || '';
    if (CHANNEL_PREFIXES.some(p => doc.startsWith(p))) return true;
    const stmt = (inv.CustomerMemo?.value || '') + ' ' + (inv.PrivateNote || '');
    return stmt.includes('Jubelio SO');
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const csvFile = `sweep-balance-due-${ts}.csv`;
    const jsonFile = `sweep-balance-due-${ts}.json`;

    console.log(`\nSWEEP balance-due invoices (Jubelio channel filter)\n`);

    // 1. Page through all unpaid invoices
    const all = [];
    let startPos = 1;
    for (let page = 0; page < MAX_PAGES; page++) {
        const q = `SELECT Id, DocNumber, TxnDate, TotalAmt, Balance, CustomerRef, PrivateNote, CustomerMemo, LinkedTxn FROM Invoice WHERE Balance > '0' STARTPOSITION ${startPos} MAXRESULTS ${PAGE_SIZE}`;
        const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const batch = body?.QueryResponse?.Invoice || [];
        if (!batch.length) break;
        all.push(...batch);
        process.stdout.write(`  page ${page + 1}: +${batch.length} (running total ${all.length})\r`);
        if (batch.length < PAGE_SIZE) break;
        startPos += PAGE_SIZE;
    }
    console.log(`\n  fetched ${all.length} invoices with Balance > 0 across all customers\n`);

    const jubelio = all.filter(isJubelioInvoice);
    console.log(`  ${jubelio.length} are Jubelio integration invoices (channel prefix or memo)\n`);

    // 2. For each, fetch linked Payments to classify
    const records = [];
    let n = 0;
    for (const inv of jubelio) {
        n++;
        process.stdout.write(`  inspecting ${n}/${jubelio.length}: ${inv.DocNumber}                    \r`);
        const linkedPayments = (inv.LinkedTxn || []).filter(lt => lt.TxnType === 'Payment');

        let category = 'OTHER';
        let appliedSum = 0;
        let paymentTotalSum = 0;
        let paymentUnappliedSum = 0;
        const paymentSummaries = [];

        for (const lt of linkedPayments) {
            try {
                const payBody = await qboFetch(qbo, `/payment/${lt.TxnId}`);
                const pay = payBody?.Payment;
                paymentTotalSum += pay.TotalAmt || 0;
                paymentUnappliedSum += pay.UnappliedAmt || 0;
                const linesForThisInv = (pay.Line || []).filter(pl =>
                    (pl.LinkedTxn || []).some(plt => plt.TxnId === inv.Id && plt.TxnType === 'Invoice')
                );
                const sumApplied = linesForThisInv.reduce((s, pl) => s + (pl.Amount || 0), 0);
                appliedSum += sumApplied;
                paymentSummaries.push({
                    paymentId: pay.Id,
                    paymentTotalAmt: pay.TotalAmt,
                    paymentUnappliedAmt: pay.UnappliedAmt,
                    appliedToThisInvoice: sumApplied,
                });
            } catch (e) {
                paymentSummaries.push({ paymentId: lt.TxnId, error: e.message.slice(0, 200) });
            }
        }

        if (linkedPayments.length === 0) {
            category = 'NO_PAYMENT';
        } else if (appliedSum < (inv.TotalAmt || 0) && paymentUnappliedSum > 0) {
            // Has unapplied credit on Payment side — the relink-payment.js bug pattern
            category = 'UNDERAPPLIED';
        } else if (appliedSum < (inv.TotalAmt || 0) && paymentTotalSum < (inv.TotalAmt || 0)) {
            // Payment itself is smaller than invoice — partial payment scenario
            category = 'PARTIAL_PAYMENT';
        } else if (paymentUnappliedSum > 0 && appliedSum >= (inv.TotalAmt || 0)) {
            category = 'OVERPAYMENT_DELTA';
        }

        records.push({
            invoiceId: inv.Id,
            docNumber: inv.DocNumber,
            txnDate: inv.TxnDate,
            customer: inv.CustomerRef?.name,
            totalAmt: inv.TotalAmt,
            balance: inv.Balance,
            linkedPaymentCount: linkedPayments.length,
            paymentTotalSum,
            appliedSum,
            paymentUnappliedSum,
            category,
            payments: paymentSummaries,
        });
    }
    console.log(`\n`);

    // 3. Categorize + summarize
    const byCategory = {};
    for (const r of records) {
        byCategory[r.category] = byCategory[r.category] || [];
        byCategory[r.category].push(r);
    }

    console.log(`SUMMARY by category:`);
    for (const [cat, arr] of Object.entries(byCategory).sort()) {
        const sumBalance = arr.reduce((s, r) => s + (r.balance || 0), 0);
        console.log(`  ${cat.padEnd(20)} count=${String(arr.length).padStart(4)}  sum(Balance)=Rp ${fmt(sumBalance)}`);
    }
    console.log();

    if (byCategory.UNDERAPPLIED?.length) {
        console.log(`UNDERAPPLIED (bug pattern — fixable via relink-payment.js):`);
        for (const r of byCategory.UNDERAPPLIED.slice(0, 30)) {
            console.log(`  ${r.docNumber.padEnd(28)}  inv=${r.invoiceId.padStart(6)}  total=Rp ${fmt(r.totalAmt).padStart(12)}  applied=Rp ${fmt(r.appliedSum).padStart(12)}  balance=Rp ${fmt(r.balance).padStart(11)}  unapplied(pay)=Rp ${fmt(r.paymentUnappliedSum).padStart(11)}  pays=${r.payments.map(p => p.paymentId).join(',')}`);
        }
        if (byCategory.UNDERAPPLIED.length > 30) console.log(`  ... and ${byCategory.UNDERAPPLIED.length - 30} more (see CSV)`);
        console.log();
    }

    if (byCategory.PARTIAL_PAYMENT?.length) {
        console.log(`PARTIAL_PAYMENT (Payment.TotalAmt < Invoice.TotalAmt — possibly mkt-fee backfill side effect):`);
        for (const r of byCategory.PARTIAL_PAYMENT.slice(0, 20)) {
            console.log(`  ${r.docNumber.padEnd(28)}  inv=${r.invoiceId.padStart(6)}  total=Rp ${fmt(r.totalAmt).padStart(12)}  paymentTotal=Rp ${fmt(r.paymentTotalSum).padStart(12)}  balance=Rp ${fmt(r.balance).padStart(11)}`);
        }
        if (byCategory.PARTIAL_PAYMENT.length > 20) console.log(`  ... and ${byCategory.PARTIAL_PAYMENT.length - 20} more (see CSV)`);
        console.log();
    }

    if (byCategory.OVERPAYMENT_DELTA?.length) {
        console.log(`OVERPAYMENT_DELTA (rare):`);
        for (const r of byCategory.OVERPAYMENT_DELTA.slice(0, 20)) {
            console.log(`  ${r.docNumber.padEnd(28)}  inv=${r.invoiceId.padStart(6)}  balance=Rp ${fmt(r.balance).padStart(11)}`);
        }
        console.log();
    }

    if (byCategory.NO_PAYMENT?.length) {
        console.log(`NO_PAYMENT count=${byCategory.NO_PAYMENT.length}  (likely legitimate unpaid Net14/COD — verify by sample)`);
        for (const r of byCategory.NO_PAYMENT.slice(0, 10)) {
            console.log(`  ${r.docNumber.padEnd(28)}  inv=${r.invoiceId.padStart(6)}  date=${r.txnDate}  total=Rp ${fmt(r.totalAmt)}`);
        }
        if (byCategory.NO_PAYMENT.length > 10) console.log(`  ... and ${byCategory.NO_PAYMENT.length - 10} more (see CSV)`);
        console.log();
    }

    if (byCategory.OTHER?.length) {
        console.log(`OTHER count=${byCategory.OTHER.length}  (need manual review):`);
        for (const r of byCategory.OTHER.slice(0, 10)) {
            console.log(`  ${r.docNumber.padEnd(28)}  inv=${r.invoiceId}  total=${fmt(r.totalAmt)} applied=${fmt(r.appliedSum)} balance=${fmt(r.balance)} unapplied(pay)=${fmt(r.paymentUnappliedSum)}`);
        }
        console.log();
    }

    // 4. Write outputs
    const csvHeader = 'invoice_id,doc_number,txn_date,customer,total_amt,balance,linked_payment_count,payment_total_sum,applied_sum,payment_unapplied_sum,category,linked_payment_ids\n';
    const csvBody = records.map(r =>
        [
            r.invoiceId, r.docNumber, r.txnDate, JSON.stringify(r.customer || ''),
            r.totalAmt, r.balance, r.linkedPaymentCount,
            r.paymentTotalSum, r.appliedSum, r.paymentUnappliedSum,
            r.category, `"${r.payments.map(p => p.paymentId).join(';')}"`,
        ].join(',')
    ).join('\n');
    fs.writeFileSync(csvFile, csvHeader + csvBody + '\n');
    fs.writeFileSync(jsonFile, JSON.stringify(records, null, 2));
    console.log(`output: ${csvFile}`);
    console.log(`        ${jsonFile}`);

    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
