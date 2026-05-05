// Comprehensive read-only sweep: find every Jubelio integration invoice in
// QBO whose total has NOT been reduced by marketplace + service fees yet.
//
// Why this exists:
//   verify-invoice-totals (28 Apr) found 14 mismatched invoices. fix-mismatched-
//   invoices auto-fixed 8, sent 6 to finance. But that was a one-shot list —
//   new invoices created since then could have the same bug if (a) the webhook
//   shipped before the merge fix in commit a579839, or (b) marketplace-fee-
//   aware logic mis-fires on edge cases (multi-currency, $0 fee fields, etc).
//
//   This script re-checks the WHOLE JubelioOrderMap live — nothing missed.
//
// Logic per invoice:
//   1. Read Jubelio source-of-truth: payload log first, fall back to Jubelio API.
//   2. Compute target = so.grand_total (= net escrow Treelogy receives).
//   3. Fetch QBO invoice. Sum SalesItemLineDetail and existing DiscountLineDetail.
//   4. Categorize:
//        match              — |TotalAmt - grand_total| ≤ 1 IDR
//        qbo-over           — TotalAmt > grand_total (missing fee deduction)
//        qbo-under          — TotalAmt < grand_total (over-deducted; rare)
//        already-merged     — DiscountLineDetail with "Marketplace fees" desc
//                             AND total matches → we count as match
//        no-source          — can't resolve Jubelio grand_total
//        invoice-not-found  — QBO invoice deleted/voided
//
// Read-only. No writes. Bounded by --limit and DEADLINE_MS.
//
// Usage:
//   node scripts/audit-invoices-missing-fees.js
//   node scripts/audit-invoices-missing-fees.js --days=30           # narrow window
//   node scripts/audit-invoices-missing-fees.js --limit=200
//   node scripts/audit-invoices-missing-fees.js --csv=out.csv
//   DEADLINE_MS=580000 node scripts/audit-invoices-missing-fees.js  # full sweep

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const { getQboInstance } = require('../services/qboService');
const jubelioApi = require('../services/jubelioApiService');

const args = process.argv.slice(2);
const arg = (k, def) => {
    const hit = args.find(a => a.startsWith(`--${k}=`));
    return hit ? hit.split('=')[1] : def;
};

const days = Number(arg('days', '0'));
const limit = Number(arg('limit', '0')) || Infinity;
const skip = Number(arg('skip', '0'));
const csvPath = arg('csv', '');
const deadlineMs = Number(process.env.DEADLINE_MS || 280_000);

const MARKETPLACE_FEE_DESC_PREFIX = 'Marketplace fees & adjustments';
const MERGED_DESC_PREFIX = 'Bundle discount + Marketplace fees';
const TOLERANCE_IDR = 1;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n) => Number(n || 0).toLocaleString('id-ID');

const qboBaseUrl = (qbo) => `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
const qboFetch = async (qbo, p, opts = {}) => {
    const url = `${qboBaseUrl(qbo)}${p}${p.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
    const MAX_RETRY = 3;
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
        try {
            const res = await fetch(url, {
                ...opts,
                headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json', ...(opts.headers || {}) },
            });
            const text = await res.text();
            let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
            if (res.status === 429 || res.status >= 500) {
                const wait = Math.min(15_000, 1000 * Math.pow(2, attempt));
                lastErr = new Error(`QBO ${p} (${res.status})`);
                await sleep(wait);
                continue;
            }
            if (!res.ok) {
                const e = new Error(`QBO ${p} (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
                e.status = res.status;
                throw e;
            }
            return body;
        } catch (e) {
            lastErr = e;
            if (e.status === 404) throw e;
            if (attempt === MAX_RETRY) throw e;
            await sleep(800);
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

const channelOf = (sn) => {
    const m = String(sn || '').match(/^([A-Z]{2,3})-/);
    return m ? m[1] : '?';
};

const expectedFeeBreakdown = (so) => {
    const fees = {
        service_fee: Number(so.service_fee || 0),
        order_processing_fee: Number(so.order_processing_fee || 0),
        insurance_cost: Number(so.insurance_cost || 0),
        add_fee: Number(so.add_fee || 0),
        add_disc: Number(so.add_disc || 0),
        discount_marketplace: Number(so.discount_marketplace || 0),
        shipping_cost_discount: Number(so.shipping_cost_discount || 0),
    };
    const total = Object.values(fees).reduce((s, n) => s + n, 0);
    return { fees, totalFees: total };
};

(async () => {
    const start = Date.now();
    await mongoose.connect(process.env.MONGODB_URI);
    if (jubelioApi.isConfigured()) await jubelioApi.login();
    const qbo = await getQboInstance();

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const auditFile = `audit-missing-fees-${ts}.jsonl`;
    const audit = (e) => fs.appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');

    const filter = days > 0 ? { last_synced_at: { $gte: new Date(Date.now() - days * 86400000) } } : {};
    let maps = await JubelioOrderMap.find(filter)
        .sort({ last_synced_at: -1 })
        .lean();
    if (skip > 0) maps = maps.slice(skip);

    const scope = days > 0 ? `last ${days}d` : 'ALL TIME';
    console.log(`\n=== Missing Marketplace Fee Audit (${scope}) ===`);
    console.log(`📋 Scope: ${maps.length} JubelioOrderMap entries (skip=${skip}) · limit=${limit === Infinity ? '∞' : limit} · deadline=${deadlineMs / 1000}s`);
    console.log(`📝 Audit file: ${auditFile}\n`);

    const stats = {
        scanned: 0,
        match: 0,
        alreadyMerged: 0,
        qboOver: 0,         // ← THE BUG: invoice total > grand_total (fee not deducted)
        qboOverWithPayment: 0,
        qboOverNoPayment: 0,
        qboUnder: 0,
        noSource: 0,
        invoiceNotFound: 0,
        errors: 0,
        zeroFees: 0,
        hitDeadline: false,
    };
    const findings = []; // qbo-over rows (the bug)
    const byChannel = {}; // channel → { count, totalGapIdr }
    const noSource = [];

    let processed = 0;
    for (const m of maps) {
        if (processed >= limit) break;
        if (Date.now() - start > deadlineMs) { stats.hitDeadline = true; break; }
        processed++;
        stats.scanned++;
        if (processed % 25 === 0) {
            const pct = ((processed / Math.min(maps.length, limit)) * 100).toFixed(0);
            process.stdout.write(`\r  scanned ${processed}/${Math.min(maps.length, limit)} (${pct}%)...`);
        }

        const sn = m.salesorder_no;
        const channel = channelOf(sn);

        try {
            const src = await resolveJubelioSource(m);
            if (!src || src.error || !src.source) {
                stats.noSource++;
                noSource.push({ sn, qboId: m.qbo_invoice_id, error: src?.error });
                audit({ sn, status: 'no-source', error: src?.error });
                continue;
            }
            const so = src.source;
            const grandTotal = Number(so.grand_total ?? NaN);
            if (!Number.isFinite(grandTotal)) {
                stats.errors++;
                audit({ sn, status: 'no-grand-total' });
                continue;
            }

            const { fees, totalFees } = expectedFeeBreakdown(so);

            let inv;
            try {
                const body = await qboFetch(qbo, `/invoice/${m.qbo_invoice_id}`);
                inv = body?.Invoice;
            } catch (e) {
                if (e.status === 404 || /Object Not Found|6240/i.test(String(e.message))) {
                    stats.invoiceNotFound++;
                    audit({ sn, qboId: m.qbo_invoice_id, status: 'invoice-not-found' });
                    continue;
                }
                throw e;
            }
            if (!inv) {
                stats.invoiceNotFound++;
                audit({ sn, qboId: m.qbo_invoice_id, status: 'invoice-not-found-empty' });
                continue;
            }

            const totalAmt = Number(inv.TotalAmt || 0);
            const balance = Number(inv.Balance || 0);
            const paymentApplied = Math.round((totalAmt - balance) * 100) / 100;
            const linkedPayments = (inv.LinkedTxn || []).filter(t => t.TxnType === 'Payment').map(t => t.TxnId);

            const lines = inv.Line || [];
            const itemLinesTotal = lines.reduce((s, l) =>
                l.DetailType === 'SalesItemLineDetail' ? s + Number(l.Amount || 0) : s, 0);
            const currentDiscount = lines.reduce((s, l) =>
                l.DetailType === 'DiscountLineDetail' ? s + Number(l.Amount || 0) : s, 0);
            const requiredDiscount = Math.round((itemLinesTotal - grandTotal) * 100) / 100;
            const discountGap = Math.round((requiredDiscount - currentDiscount) * 100) / 100;

            const hasMarketplaceFeeLine = lines.some(l =>
                l.DetailType === 'DiscountLineDetail' &&
                (String(l.Description || '').startsWith(MARKETPLACE_FEE_DESC_PREFIX) ||
                 String(l.Description || '').startsWith(MERGED_DESC_PREFIX)));

            const totalDelta = Math.round((totalAmt - grandTotal) * 100) / 100;

            // Idempotent match: total within tolerance OR (total > target but already has merged disc — script edge case)
            if (Math.abs(totalDelta) <= TOLERANCE_IDR) {
                stats.match++;
                if (hasMarketplaceFeeLine) stats.alreadyMerged++;
                audit({ sn, qboId: inv.Id, channel, status: 'match', totalAmt, grandTotal });
                continue;
            }

            if (totalDelta > TOLERANCE_IDR) {
                // QBO over-stated. Marketplace fee not yet deducted (or partially deducted)
                stats.qboOver++;
                if (paymentApplied > 0.01 || linkedPayments.length > 0) stats.qboOverWithPayment++;
                else stats.qboOverNoPayment++;
                if (totalFees < TOLERANCE_IDR) stats.zeroFees++;

                byChannel[channel] = byChannel[channel] || { count: 0, totalGapIdr: 0, withPayment: 0 };
                byChannel[channel].count++;
                byChannel[channel].totalGapIdr += totalDelta;
                if (linkedPayments.length > 0) byChannel[channel].withPayment++;

                const finding = {
                    sn,
                    qboId: inv.Id,
                    channel,
                    docNumber: inv.DocNumber || '',
                    customerName: inv.CustomerRef?.name || '',
                    txnDate: inv.TxnDate || '',
                    totalAmt,
                    grandTotal,
                    gap: totalDelta,
                    itemLinesTotal,
                    currentDiscount,
                    requiredDiscount,
                    discountGap,
                    expectedFees: fees,
                    expectedTotalFees: totalFees,
                    hasMarketplaceFeeLine,
                    paymentApplied,
                    balance,
                    linkedPayments,
                    isPaid: balance === 0 && totalAmt > 0,
                };
                findings.push(finding);
                audit({ status: 'qbo-over', ...finding });
                continue;
            }

            // totalDelta < -TOLERANCE → QBO total < Jubelio grand_total (over-deducted)
            stats.qboUnder++;
            audit({
                sn, qboId: inv.Id, channel, status: 'qbo-under',
                totalAmt, grandTotal, gap: totalDelta,
                currentDiscount, requiredDiscount,
            });
        } catch (e) {
            stats.errors++;
            audit({ sn, qboId: m.qbo_invoice_id, status: 'fatal', error: String(e.message || e).slice(0, 300) });
            if (/refresh token invalid|401/i.test(String(e.message))) {
                console.error(`\n💥 Auth failed mid-scan: ${e.message}`);
                break;
            }
        }
    }
    process.stdout.write('\r');

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n────────── SUMMARY (${elapsed}s) ──────────`);
    console.log(`Scanned                          : ${stats.scanned}`);
    console.log(`✅ Match (within ${TOLERANCE_IDR} IDR)        : ${stats.match}`);
    console.log(`   └─ already-merged disc line   : ${stats.alreadyMerged}`);
    console.log(`🛑 QBO OVER (missing fee deduction): ${stats.qboOver}`);
    console.log(`   ├─ has Payment (manual care)  : ${stats.qboOverWithPayment}`);
    console.log(`   └─ no Payment (auto-fixable)  : ${stats.qboOverNoPayment}`);
    console.log(`   └─ zero-fee SOs (different bug): ${stats.zeroFees}`);
    console.log(`⚠️  QBO UNDER (over-deducted)     : ${stats.qboUnder}`);
    console.log(`❓ No Jubelio source              : ${stats.noSource}`);
    console.log(`🚫 Invoice not found in QBO       : ${stats.invoiceNotFound}`);
    console.log(`💥 Errors                         : ${stats.errors}`);
    console.log(`Hit deadline                      : ${stats.hitDeadline ? 'YES — re-run for remainder' : 'no'}`);

    if (Object.keys(byChannel).length > 0) {
        console.log(`\nQBO-OVER per channel:`);
        const rows = Object.entries(byChannel).sort((a, b) => b[1].count - a[1].count);
        for (const [ch, d] of rows) {
            console.log(`  ${ch.padEnd(4)} count=${String(d.count).padStart(4)}  gap_total=Rp ${fmt(d.totalGapIdr).padStart(12)}  with-payment=${d.withPayment}`);
        }
    }

    if (findings.length > 0) {
        console.log(`\nFirst 30 findings (most recent first):`);
        const sorted = findings.sort((a, b) => String(b.txnDate).localeCompare(String(a.txnDate)));
        for (const f of sorted.slice(0, 30)) {
            const payTag = f.linkedPayments.length > 0 ? `paid(${f.linkedPayments.length})` : 'unpaid';
            console.log(`  ${f.txnDate}  ${f.sn.padEnd(28)} qbo=${f.qboId}  total=Rp ${fmt(f.totalAmt).padStart(11)} → Rp ${fmt(f.grandTotal).padStart(11)}  gap=Rp ${fmt(f.gap).padStart(9)}  ${payTag}`);
        }
        if (findings.length > 30) console.log(`  ... and ${findings.length - 30} more (full list in audit JSONL)`);
    }

    if (csvPath && findings.length > 0) {
        const header = 'salesorder_no,qbo_invoice_id,channel,doc_number,customer_name,txn_date,total_amt,grand_total_jubelio,gap,item_lines_total,current_discount,required_discount,discount_gap,expected_total_fees,has_marketplace_fee_line,payment_applied,balance,linked_payment_ids,is_paid\n';
        const rows = findings.map(f => [
            f.sn,
            f.qboId,
            f.channel,
            f.docNumber,
            `"${(f.customerName || '').replace(/"/g, '""')}"`,
            f.txnDate,
            f.totalAmt,
            f.grandTotal,
            f.gap,
            f.itemLinesTotal,
            f.currentDiscount,
            f.requiredDiscount,
            f.discountGap,
            f.expectedTotalFees,
            f.hasMarketplaceFeeLine,
            f.paymentApplied,
            f.balance,
            `"${f.linkedPayments.join('|')}"`,
            f.isPaid,
        ].join(','));
        fs.writeFileSync(csvPath, header + rows.join('\n') + '\n');
        console.log(`\n📋 CSV written: ${csvPath} (${rows.length} rows)`);
    }

    if (noSource.length > 0) {
        console.log(`\n❓ ${noSource.length} invoice(s) without Jubelio source (skipped — payload TTL expired?):`);
        for (const ns of noSource.slice(0, 10)) console.log(`  ${ns.sn} qbo=${ns.qboId}${ns.error ? ' err=' + ns.error.slice(0, 80) : ''}`);
        if (noSource.length > 10) console.log(`  ... and ${noSource.length - 10} more`);
    }

    console.log(`\n📝 Full audit: ${auditFile}`);
    await mongoose.disconnect();
    process.exit(0);
})().catch(async e => {
    console.error('💥 FATAL:', e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
});
