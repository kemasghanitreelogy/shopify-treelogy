// Cross-reference the 308 NO_PAYMENT invoices from sweep-balance-due.js with
// JubelioOrderMap.last_status to determine which are legitimately unpaid
// (SHIPPED waiting buyer-confirm) vs missed Payment creation (COMPLETED but
// no Payment in QBO = bug).
//
// Usage:
//   node scripts/cross-ref-balance-due.js <sweep-json-path>

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');

const sweepFile = process.argv[2];
if (!sweepFile) { console.error('usage: node scripts/cross-ref-balance-due.js <sweep-json-path>'); process.exit(1); }

const fmt = (n) => (n || 0).toLocaleString('id-ID');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const sweep = JSON.parse(fs.readFileSync(sweepFile, 'utf-8'));
    const realmId = process.env.QBO_REALM_ID || (await JubelioOrderMap.findOne())?.qbo_realm_id;

    console.log(`\nCROSS-REF  ${sweep.length} invoices  realm=${realmId}\n`);

    const noPayment = sweep.filter(r => r.category === 'NO_PAYMENT');
    const enriched = [];

    for (const r of noPayment) {
        const map = await JubelioOrderMap.findOne({
            salesorder_no: r.docNumber,
            qbo_realm_id: String(realmId),
        }).lean();
        enriched.push({
            ...r,
            jubelio_status: map?.last_status || '__NOT_IN_MAP__',
            jubelio_grand_total: map?.last_grand_total,
            jubelio_payment_date: map?.last_payment_date_raw,
            jubelio_synced_at: map?.last_synced_at,
            grand_total_match: map ? (map.last_grand_total === r.totalAmt) : null,
        });
    }

    // Categorize by status
    const byStatus = {};
    for (const r of enriched) {
        const k = r.jubelio_status;
        byStatus[k] = byStatus[k] || [];
        byStatus[k].push(r);
    }

    console.log(`Distribution by Jubelio.last_status:`);
    for (const [s, arr] of Object.entries(byStatus).sort((a, b) => b[1].length - a[1].length)) {
        const sumBalance = arr.reduce((acc, r) => acc + (r.balance || 0), 0);
        console.log(`  ${s.padEnd(20)}  count=${String(arr.length).padStart(4)}  sum_balance=Rp ${fmt(sumBalance)}`);
    }
    console.log();

    // Show problematic categories with detail
    const completedNoPay = enriched.filter(r => ['COMPLETED', 'PAID'].includes((r.jubelio_status || '').toUpperCase()));
    if (completedNoPay.length) {
        console.log(`⚠️  COMPLETED/PAID but no Payment in QBO (BUG candidates) — ${completedNoPay.length} invoices`);
        console.log(`    sum_balance = Rp ${fmt(completedNoPay.reduce((s, r) => s + r.balance, 0))}`);
        for (const r of completedNoPay.slice(0, 30)) {
            console.log(`    ${r.docNumber.padEnd(28)} inv=${String(r.invoiceId).padStart(6)} status=${r.jubelio_status.padEnd(10)} total=Rp ${fmt(r.totalAmt).padStart(11)} balance=Rp ${fmt(r.balance).padStart(10)} synced=${r.jubelio_synced_at?.toISOString?.().slice(0,10)}`);
        }
        if (completedNoPay.length > 30) console.log(`    ... and ${completedNoPay.length - 30} more`);
        console.log();
    }

    const notInMap = enriched.filter(r => r.jubelio_status === '__NOT_IN_MAP__');
    if (notInMap.length) {
        console.log(`⚠️  Not in JubelioOrderMap — ${notInMap.length} invoices (created outside webhook?)`);
        for (const r of notInMap.slice(0, 10)) {
            console.log(`    ${r.docNumber.padEnd(28)} inv=${String(r.invoiceId).padStart(6)} total=Rp ${fmt(r.totalAmt)}`);
        }
        if (notInMap.length > 10) console.log(`    ... and ${notInMap.length - 10} more`);
        console.log();
    }

    const grandTotalMismatch = enriched.filter(r => r.grand_total_match === false);
    if (grandTotalMismatch.length) {
        console.log(`⚠️  Jubelio.grand_total ≠ QBO.TotalAmt — ${grandTotalMismatch.length} invoices`);
        for (const r of grandTotalMismatch.slice(0, 10)) {
            console.log(`    ${r.docNumber.padEnd(28)} jubelio=Rp ${fmt(r.jubelio_grand_total)} qbo=Rp ${fmt(r.totalAmt)} balance=Rp ${fmt(r.balance)}`);
        }
        if (grandTotalMismatch.length > 10) console.log(`    ... and ${grandTotalMismatch.length - 10} more`);
        console.log();
    }

    // Save enriched
    const outFile = sweepFile.replace('.json', '-cross-ref.json');
    fs.writeFileSync(outFile, JSON.stringify(enriched, null, 2));
    console.log(`enriched output: ${outFile}`);

    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
