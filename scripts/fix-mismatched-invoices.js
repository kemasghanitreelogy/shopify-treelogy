// Fix the 14 invoices where QBO total ≠ Jubelio grand_total.
//
// Root cause: QBO Indonesia accepts only ONE DiscountLineDetail per invoice;
// multi-discount writes (bundle disc + marketplace fee disc) silently collapse,
// dropping one of them. Fix = merge the required discounts into a SINGLE
// DiscountLineDetail per invoice.
//
// Behavior:
//   • For invoices with NO payment applied → modify directly (replace existing
//     DiscountLineDetail with merged-amount line). Total drops to grand_total.
//   • For invoices that have ANY payment applied (partial or full) → SKIP and
//     write to a separate CSV for finance to handle manually (since modifying
//     would create an over-applied/under-applied state on a payment they've
//     already reconciled to bank).
//
// Bounded: --limit=N · DEADLINE_MS=240000 · dry-run by default.
//
// Usage:
//   node scripts/fix-mismatched-invoices.js                    # dry-run all
//   node scripts/fix-mismatched-invoices.js --apply            # apply unpaid, list paid
//   node scripts/fix-mismatched-invoices.js --apply --limit=3  # apply first 3 only

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const { getQboInstance } = require('../services/qboService');
const jubelioApi = require('../services/jubelioApiService');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limit = (() => {
    const a = args.find(x => x.startsWith('--limit='));
    return a ? Number(a.split('=')[1]) : Infinity;
})();
const deadlineMs = Number(process.env.DEADLINE_MS || 240_000);

// 14 known mismatches from verify-invoice-totals-mismatches-*.csv
const MISMATCHES = [
    'SP-260426TNCQN2AF', 'SP-260426TFRW7U6W', 'SP-260425QHEYC1WA',
    'SP-260425QA3P272R', 'SP-260425Q78RDWJT', 'SP-260425PHT0VE69',
    'SP-260424MM1WMQ92', 'SP-260421CSQM3TER', 'SP-260426TMFQQY61',
    'SP-2604198MHG81Y4', 'SP-26042700188GWC',
    'SP-260423J7NBGSPS', 'SP-260423HAJVWVWN', 'SP-260421DNC0D4CY',
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID')}`;

const qboBaseUrl = (qbo) => `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
const qboFetch = async (qbo, p, opts = {}) => {
    const url = `${qboBaseUrl(qbo)}${p}${p.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
    const MAX_RETRY = 4;
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
        try {
            const res = await fetch(url, {
                ...opts,
                headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(opts.headers || {}) },
            });
            const text = await res.text();
            let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
            if (res.status === 429 || res.status >= 500) {
                const wait = Math.min(30_000, 1500 * Math.pow(2, attempt));
                lastErr = new Error(`QBO ${opts.method || 'GET'} ${p} (${res.status})`);
                await sleep(wait);
                continue;
            }
            if (!res.ok) throw new Error(`QBO ${opts.method || 'GET'} ${p} (${res.status}): ${JSON.stringify(body).slice(0, 400)}`);
            return body;
        } catch (e) {
            lastErr = e;
            if (attempt === MAX_RETRY) throw e;
            await sleep(1500);
        }
    }
    throw lastErr;
};

const resolveJubelioSource = async (map) => {
    const log = await JubelioPayloadLog.findOne({ salesorder_no: map.salesorder_no })
        .sort({ _id: -1 }).lean();
    if (log?.payload?.grand_total != null) return { source: log.payload, origin: 'payload' };
    if (!map.salesorder_id || !jubelioApi.isConfigured()) return null;
    try {
        const so = await jubelioApi.getOrderDetail(map.salesorder_id);
        if (so?.grand_total != null) return { source: so, origin: 'api' };
    } catch (e) {
        return { error: e.message };
    }
    return null;
};

const buildMergedDiscountDescription = (so) => {
    const parts = [];
    if (Number(so.service_fee) > 0) parts.push(`service_fee ${fmt(so.service_fee)}`);
    if (Number(so.order_processing_fee) > 0) parts.push(`order_processing_fee ${fmt(so.order_processing_fee)}`);
    if (Number(so.insurance_cost) > 0) parts.push(`insurance ${fmt(so.insurance_cost)}`);
    if (Number(so.add_fee) > 0) parts.push(`add_fee ${fmt(so.add_fee)}`);
    if (Number(so.add_disc) > 0) parts.push(`add_disc ${fmt(so.add_disc)}`);
    if (Number(so.discount_marketplace) > 0) parts.push(`discount_marketplace ${fmt(so.discount_marketplace)}`);
    if (Number(so.shipping_cost_discount) > 0) parts.push(`shipping_disc ${fmt(so.shipping_cost_discount)}`);
    return `Bundle discount + Marketplace fees & adjustments${parts.length ? ` (${parts.join(' + ')})` : ''}`;
};

(async () => {
    const start = Date.now();
    await mongoose.connect(process.env.MONGODB_URI);
    if (jubelioApi.isConfigured()) await jubelioApi.login();
    const qbo = await getQboInstance();

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const auditFile = `fix-mismatched-invoices-audit-${ts}.jsonl`;
    const manualCsvFile = `finance-manual-overapplied-${ts}.csv`;
    const audit = (e) => fs.appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');

    fs.writeFileSync(manualCsvFile,
        'salesorder_no,qbo_invoice_id,doc_number,customer_name,txn_date,current_total,target_total,diff,payment_applied,balance,linked_payment_ids,recommended_action\n');

    console.log(`\n🔧 Fix mismatched invoices · mode=${apply ? 'APPLY' : 'DRY-RUN'} · limit=${limit === Infinity ? '∞' : limit} · deadline=${deadlineMs / 1000}s`);
    console.log(`📝 ${auditFile}`);
    console.log(`📋 ${manualCsvFile}\n`);

    const stats = {
        scanned: 0,
        appliedFix: 0,
        skippedHasPayment: 0,
        skippedAlreadyMatch: 0,
        notFound: 0,
        errors: 0,
        hitDeadline: false,
    };
    const fixed = [];
    const manual = [];

    let processed = 0;
    for (const sn of MISMATCHES) {
        if (processed >= limit) break;
        if (Date.now() - start > deadlineMs) { stats.hitDeadline = true; break; }
        processed++;
        stats.scanned++;

        try {
            const map = await JubelioOrderMap.findOne({ salesorder_no: sn }).lean();
            if (!map) { stats.notFound++; audit({ sn, status: 'map-not-found' }); continue; }

            const src = await resolveJubelioSource(map);
            if (!src?.source) { stats.errors++; audit({ sn, status: 'no-source', error: src?.error }); continue; }
            const so = src.source;
            const grandTotal = Number(so.grand_total);

            const body = await qboFetch(qbo, `/invoice/${map.qbo_invoice_id}`);
            const inv = body?.Invoice;
            if (!inv) { stats.notFound++; audit({ sn, status: 'invoice-not-found' }); continue; }

            // Sum non-discount lines
            const itemLinesTotal = (inv.Line || []).reduce((s, l) => {
                if (l.DetailType === 'SalesItemLineDetail') return s + Number(l.Amount || 0);
                return s;
            }, 0);
            const requiredDisc = Math.round((itemLinesTotal - grandTotal) * 100) / 100;

            // Idempotency: invoice already at correct total?
            const currentTotal = Number(inv.TotalAmt || 0);
            if (Math.abs(currentTotal - grandTotal) <= 1) {
                stats.skippedAlreadyMatch++;
                audit({ sn, status: 'already-matches', currentTotal, grandTotal });
                continue;
            }

            const balance = Number(inv.Balance || 0);
            const paymentApplied = Math.round((currentTotal - balance) * 100) / 100;
            const linkedPayments = (inv.LinkedTxn || [])
                .filter(t => t.TxnType === 'Payment')
                .map(t => t.TxnId);

            const customerName = inv.CustomerRef?.name || '';
            const docNumber = inv.DocNumber || '';
            const txnDate = inv.TxnDate || '';

            // Categorize: any payment applied → manual (finance handle)
            if (paymentApplied > 0.01 || linkedPayments.length > 0) {
                stats.skippedHasPayment++;
                const isFullyPaid = balance === 0;
                const recommendedAction = isFullyPaid
                    ? 'Create Credit Memo or apply customer credit'
                    : 'Reduce invoice + reconcile partial payment';
                const row = {
                    sn, qboId: inv.Id, docNumber, customerName, txnDate,
                    currentTotal, targetTotal: grandTotal, diff: requiredDisc - getCurrentDisc(inv),
                    paymentApplied, balance, linkedPayments,
                };
                manual.push(row);
                fs.appendFileSync(manualCsvFile,
                    `${sn},${inv.Id},${docNumber},"${customerName.replace(/"/g, '""')}",${txnDate},${currentTotal},${grandTotal},${currentTotal - grandTotal},${paymentApplied},${balance},"${linkedPayments.join('|')}",${recommendedAction}\n`);
                audit({ sn, status: 'manual-finance', ...row, recommendedAction });
                console.log(`  📋 ${sn} (id=${inv.Id}) PAYMENT APPLIED ${fmt(paymentApplied)} balance=${fmt(balance)} → manual`);
                continue;
            }

            // No payment → safe to modify
            console.log(`  🔧 ${sn} (id=${inv.Id}) total ${fmt(currentTotal)} → ${fmt(grandTotal)} · merging discounts to ${fmt(requiredDisc)}`);

            // Capture full before-state for rollback
            audit({
                sn, status: 'will-fix', qboId: inv.Id,
                beforeSyncToken: inv.SyncToken,
                beforeTotal: currentTotal,
                beforeBalance: balance,
                beforeLines: inv.Line, // full snapshot for rollback
                grandTotal,
                requiredDisc,
                dryRun: !apply,
            });

            if (!apply) continue;

            // Build new lines: keep all non-discount lines, replace discount with merged
            const newLines = (inv.Line || []).filter(l =>
                l.DetailType !== 'SubTotalLineDetail' &&
                l.DetailType !== 'DiscountLineDetail');

            if (requiredDisc > 0.01) {
                newLines.push({
                    Description: buildMergedDiscountDescription(so).substring(0, 4000),
                    Amount: requiredDisc,
                    DetailType: 'DiscountLineDetail',
                    DiscountLineDetail: { PercentBased: false },
                });
            }

            try {
                const updated = await qboFetch(qbo, '/invoice', {
                    method: 'POST',
                    body: JSON.stringify({
                        Id: inv.Id, SyncToken: inv.SyncToken, sparse: true,
                        Line: newLines, TxnTaxDetail: {},
                    }),
                });
                const newInv = updated?.Invoice;
                stats.appliedFix++;
                fixed.push({ sn, qboId: inv.Id, oldTotal: currentTotal, newTotal: newInv?.TotalAmt, newBalance: newInv?.Balance });
                audit({ sn, qboId: inv.Id, status: 'applied', newSyncToken: newInv?.SyncToken, newTotal: newInv?.TotalAmt, newBalance: newInv?.Balance });
                await sleep(150);
            } catch (e) {
                console.error(`     💥 update failed: ${e.message.slice(0, 250)}`);
                stats.errors++;
                audit({ sn, status: 'apply-error', error: e.message });
            }
        } catch (e) {
            console.error(`  💥 ${sn}: ${e.message.slice(0, 250)}`);
            stats.errors++;
            audit({ sn, status: 'fatal', error: e.message });
        }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log('\n────────── SUMMARY ──────────');
    console.log(`Scanned                  : ${stats.scanned} / ${MISMATCHES.length}`);
    console.log(`✅ Applied fix           : ${stats.appliedFix}`);
    console.log(`📋 Skipped (has payment) : ${stats.skippedHasPayment} → see ${manualCsvFile}`);
    console.log(`✓  Already matches       : ${stats.skippedAlreadyMatch}`);
    console.log(`⚠️  Not found            : ${stats.notFound}`);
    console.log(`💥 Errors                : ${stats.errors}`);
    console.log(`Hit deadline             : ${stats.hitDeadline ? 'YES' : 'no'} (${elapsed}s)`);

    if (fixed.length) {
        console.log(`\n🔧 Applied (${fixed.length}):`);
        for (const f of fixed) console.log(`  • ${f.sn} (id=${f.qboId}): ${fmt(f.oldTotal)} → ${fmt(f.newTotal)}, balance=${fmt(f.newBalance)}`);
    }
    if (manual.length) {
        console.log(`\n📋 Finance manual handling (${manual.length}):`);
        for (const m of manual) {
            console.log(`  • ${m.sn} (qbo ${m.qboId}, ${m.customerName.slice(0, 40)})`);
            console.log(`      current=${fmt(m.currentTotal)} target=${fmt(m.targetTotal)} paid=${fmt(m.paymentApplied)} balance=${fmt(m.balance)}`);
        }
    }

    console.log(`\n📝 Audit:  ${auditFile}`);
    console.log(`📋 Manual: ${manualCsvFile}\n`);

    await mongoose.disconnect();
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

function getCurrentDisc(inv) {
    return (inv.Line || []).reduce((s, l) =>
        l.DetailType === 'DiscountLineDetail' ? s + Number(l.Amount || 0) : s, 0);
}
