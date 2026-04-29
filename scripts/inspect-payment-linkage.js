// Read-only diagnostic for payment-linkage anomalies introduced by
// scripts/redirect-bundle-invoices.js (28/04). Dumps Invoice + Payment state
// for SHF bundle-redirected invoices so we can verify the exact mechanism by
// which Invoice.Balance > 0 despite a fully-paid Jubelio SO.
//
// Usage:
//   node scripts/inspect-payment-linkage.js

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');

const TARGETS = [
    { salesorder_no: 'SHF-7390-128887', qboInvoiceId: '69566', expectedTotal: 1180000, restructured: '2026-04-28' },
    { salesorder_no: 'SHF-7410-128887', qboInvoiceId: '69791', expectedTotal: 1180000, restructured: '2026-04-28' },
];

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

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = `inspect-payment-linkage-${ts}.json`;
    const dump = [];

    console.log(`\nINSPECT  ${TARGETS.length} invoice(s) — read-only\n`);

    for (const t of TARGETS) {
        const record = { target: t, invoice: null, payments: [], deposits: [], analysis: {} };

        try {
            const invBody = await qboFetch(qbo, `/invoice/${t.qboInvoiceId}`);
            const inv = invBody?.Invoice;
            if (!inv) { console.log(`  ${t.salesorder_no}: invoice ${t.qboInvoiceId} NOT FOUND`); dump.push(record); continue; }

            record.invoice = {
                Id: inv.Id, DocNumber: inv.DocNumber, SyncToken: inv.SyncToken,
                TotalAmt: inv.TotalAmt, Balance: inv.Balance,
                TxnDate: inv.TxnDate, MetaData: inv.MetaData,
                CustomerRef: inv.CustomerRef,
                LinkedTxn: inv.LinkedTxn || [],
                Lines: (inv.Line || []).map(l => ({
                    DetailType: l.DetailType,
                    Amount: l.Amount,
                    Description: (l.Description || '').slice(0, 80),
                    ItemRef: l.SalesItemLineDetail?.ItemRef || l.GroupLineDetail?.GroupItemRef,
                    UnitPrice: l.SalesItemLineDetail?.UnitPrice,
                    Qty: l.SalesItemLineDetail?.Qty,
                    TaxCodeRef: l.SalesItemLineDetail?.TaxCodeRef,
                })),
            };

            console.log(`━━━ ${t.salesorder_no}  (qboInvoiceId=${inv.Id}, doc=${inv.DocNumber})`);
            console.log(`    TotalAmt = Rp ${fmt(inv.TotalAmt)}    Balance = Rp ${fmt(inv.Balance)}`);
            console.log(`    SyncToken = ${inv.SyncToken}    LastModified = ${inv.MetaData?.LastUpdatedTime}`);
            console.log(`    Created      = ${inv.MetaData?.CreateTime}`);
            console.log(`    Lines:`);
            for (const l of record.invoice.Lines) {
                const ref = l.ItemRef ? `item=${l.ItemRef.value}` : '';
                console.log(`      • ${l.DetailType.padEnd(22)} amt=${fmt(l.Amount).padStart(11)}  ${ref}  ${l.Description}`);
            }

            const linkedPayments = (inv.LinkedTxn || []).filter(lt => lt.TxnType === 'Payment');
            const linkedDeposits = (inv.LinkedTxn || []).filter(lt => lt.TxnType === 'Deposit');
            console.log(`    LinkedTxn: ${linkedPayments.length} Payment(s), ${linkedDeposits.length} Deposit(s)`);

            for (const lt of linkedPayments) {
                try {
                    const payBody = await qboFetch(qbo, `/payment/${lt.TxnId}`);
                    const pay = payBody?.Payment;
                    const linesForThisInv = (pay.Line || []).filter(pl =>
                        (pl.LinkedTxn || []).some(plt => plt.TxnId === inv.Id && plt.TxnType === 'Invoice')
                    );
                    const sumAppliedToThisInv = linesForThisInv.reduce((s, pl) => s + (pl.Amount || 0), 0);

                    record.payments.push({
                        Id: pay.Id, TxnDate: pay.TxnDate, TotalAmt: pay.TotalAmt,
                        UnappliedAmt: pay.UnappliedAmt, PrivateNote: pay.PrivateNote,
                        DepositToAccountRef: pay.DepositToAccountRef,
                        SyncToken: pay.SyncToken,
                        MetaData: pay.MetaData,
                        Lines: (pay.Line || []).map(pl => ({
                            Amount: pl.Amount,
                            LinkedTxn: pl.LinkedTxn,
                        })),
                        sumAppliedToThisInv,
                    });

                    console.log(`    └─ Payment id=${pay.Id} date=${pay.TxnDate}`);
                    console.log(`       TotalAmt = Rp ${fmt(pay.TotalAmt)}    UnappliedAmt = Rp ${fmt(pay.UnappliedAmt)}`);
                    console.log(`       Applied to THIS invoice = Rp ${fmt(sumAppliedToThisInv)}`);
                    console.log(`       PrivateNote = ${(pay.PrivateNote || '').slice(0, 90)}`);
                    console.log(`       Created = ${pay.MetaData?.CreateTime}    LastModified = ${pay.MetaData?.LastUpdatedTime}`);
                    for (const pl of pay.Line || []) {
                        const lts = (pl.LinkedTxn || []).map(x => `${x.TxnType}#${x.TxnId}`).join(', ');
                        console.log(`         · payLine amt=Rp ${fmt(pl.Amount).padStart(11)}  → ${lts}`);
                    }
                } catch (e) {
                    console.log(`    └─ Payment id=${lt.TxnId}: FETCH ERROR ${e.message.slice(0, 200)}`);
                    record.payments.push({ Id: lt.TxnId, error: e.message });
                }
            }

            // Also look for "orphan" payments referencing this invoice via memo (just in case
            // there's a Payment created for this SO that isn't reflected in Invoice.LinkedTxn).
            try {
                const q = `SELECT Id, TxnDate, TotalAmt, UnappliedAmt, PrivateNote FROM Payment WHERE PrivateNote LIKE '%${t.salesorder_no}%' MAXRESULTS 20`;
                const found = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
                const allMatching = found?.QueryResponse?.Payment || [];
                const linkedIds = new Set(linkedPayments.map(lt => lt.TxnId));
                const orphans = allMatching.filter(p => !linkedIds.has(p.Id));
                if (orphans.length) {
                    console.log(`    ORPHAN payments (memo refs SO but not in Invoice.LinkedTxn):`);
                    for (const p of orphans) {
                        console.log(`      • Payment id=${p.Id} date=${p.TxnDate} TotalAmt=Rp ${fmt(p.TotalAmt)} Unapplied=Rp ${fmt(p.UnappliedAmt)}`);
                        record.payments.push({ ...p, _orphan: true });
                    }
                }
            } catch (e) {
                console.log(`    Orphan-payment query failed: ${e.message.slice(0, 150)}`);
            }

            // Also check for Deposits referencing this SO in memo
            try {
                const q = `SELECT Id, TxnDate, TotalAmt, PrivateNote FROM Deposit WHERE PrivateNote LIKE '%${t.salesorder_no}%' MAXRESULTS 20`;
                const found = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
                const dpts = found?.QueryResponse?.Deposit || [];
                if (dpts.length) {
                    console.log(`    DEPOSITS referencing this SO in memo:`);
                    for (const d of dpts) {
                        console.log(`      • Deposit id=${d.Id} date=${d.TxnDate} TotalAmt=Rp ${fmt(d.TotalAmt)}`);
                        record.deposits.push(d);
                    }
                }
            } catch (e) {
                console.log(`    Deposit query failed: ${e.message.slice(0, 150)}`);
            }

            // Analysis
            const subtotalSalesItems = record.invoice.Lines
                .filter(l => l.DetailType === 'SalesItemLineDetail').reduce((s, l) => s + (l.Amount || 0), 0);
            const sumDiscount = record.invoice.Lines
                .filter(l => l.DetailType === 'DiscountLineDetail').reduce((s, l) => s + (l.Amount || 0), 0);
            const totalApplied = record.payments
                .filter(p => !p._orphan).reduce((s, p) => s + (p.sumAppliedToThisInv || 0), 0);

            record.analysis = {
                subtotalSalesItems,
                sumDiscount,
                computedTotal: subtotalSalesItems - sumDiscount,
                qboTotalAmt: inv.TotalAmt,
                qboBalance: inv.Balance,
                totalAppliedFromPayments: totalApplied,
                computedBalance: (inv.TotalAmt || 0) - totalApplied,
                expectedTotal: t.expectedTotal,
                healthy: inv.Balance === 0,
            };

            console.log(`    ANALYSIS:`);
            console.log(`      subtotal SalesItem  = Rp ${fmt(subtotalSalesItems)}`);
            console.log(`      sum Discount        = Rp ${fmt(sumDiscount)}`);
            console.log(`      computed Total      = Rp ${fmt(subtotalSalesItems - sumDiscount)}`);
            console.log(`      QBO TotalAmt        = Rp ${fmt(inv.TotalAmt)}`);
            console.log(`      QBO Balance         = Rp ${fmt(inv.Balance)}`);
            console.log(`      sum Applied         = Rp ${fmt(totalApplied)}`);
            console.log(`      computedBalance     = Rp ${fmt((inv.TotalAmt || 0) - totalApplied)}`);
            console.log(`      healthy             = ${inv.Balance === 0 ? 'YES' : 'NO ⚠️'}\n`);

        } catch (e) {
            console.error(`  ${t.salesorder_no}: ERROR ${e.message.slice(0, 400)}`);
            record.error = e.message;
        }

        dump.push(record);
    }

    fs.writeFileSync(outFile, JSON.stringify(dump, null, 2));
    console.log(`\nDump written: ${outFile}\n`);
    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
