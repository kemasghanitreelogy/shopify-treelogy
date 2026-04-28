// Backfill marketplace fee adjustment lines on historical Jubelio invoices.
//
// For each invoice in JubelioOrderMap:
//   1. Resolve Jubelio source-of-truth (payload log first, fall back to
//      Jubelio API if payload TTL expired).
//   2. Read so.grand_total + the fee fields (service_fee, order_processing_fee,
//      insurance_cost, add_fee/add_disc, discount_marketplace, shipping_cost_discount).
//   3. Compute adjustment = QBO invoice linesTotal − grand_total.
//   4. Idempotency: skip if invoice already has a "Marketplace fees & adjustments"
//      DiscountLineDetail row (forward-fix already covered it).
//   5. If adjustment > 0, append DiscountLineDetail. Total drops to grand_total.
//
// Bounded: --limit=N · DEADLINE_MS=240000 (override via env).
//
// Usage:
//   node scripts/backfill-marketplace-fees.js                # dry-run all
//   node scripts/backfill-marketplace-fees.js --limit=50     # dry-run first 50
//   node scripts/backfill-marketplace-fees.js --apply        # apply
//   DEADLINE_MS=580000 node scripts/backfill-marketplace-fees.js --apply --limit=2000

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

const MARKETPLACE_FEE_DESC_PREFIX = 'Marketplace fees & adjustments';

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
                console.log(`     ⏳ ${res.status} on ${opts.method || 'GET'} ${p} — retry in ${wait}ms (attempt ${attempt + 1}/${MAX_RETRY + 1})`);
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const fmt = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID')}`;

// Resolve Jubelio source-of-truth for an invoice. Try payload log first
// (cheap, no API call); fall back to Jubelio API by salesorder_id.
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

const buildFeeLineDescription = (so) => {
    const parts = [];
    if (Number(so.service_fee) > 0) parts.push(`service_fee ${fmt(so.service_fee)}`);
    if (Number(so.order_processing_fee) > 0) parts.push(`order_processing_fee ${fmt(so.order_processing_fee)}`);
    if (Number(so.insurance_cost) > 0) parts.push(`insurance ${fmt(so.insurance_cost)}`);
    if (Number(so.add_fee) > 0) parts.push(`add_fee ${fmt(so.add_fee)}`);
    if (Number(so.add_disc) > 0) parts.push(`add_disc ${fmt(so.add_disc)}`);
    if (Number(so.discount_marketplace) > 0) parts.push(`discount_marketplace ${fmt(so.discount_marketplace)}`);
    if (Number(so.shipping_cost_discount) > 0) parts.push(`shipping_disc ${fmt(so.shipping_cost_discount)}`);
    return `${MARKETPLACE_FEE_DESC_PREFIX}${parts.length ? ` (${parts.join(' + ')})` : ''}`;
};

(async () => {
    const start = Date.now();
    await mongoose.connect(process.env.MONGODB_URI);
    if (jubelioApi.isConfigured()) await jubelioApi.login();
    const qbo = await getQboInstance();

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const auditFile = `backfill-marketplace-fees-audit-${ts}.jsonl`;
    const audit = (e) => fs.appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');

    console.log(`\n🚀 Backfill marketplace fees · mode=${apply ? 'APPLY' : 'DRY-RUN'} · limit=${limit === Infinity ? '∞' : limit} · deadline=${deadlineMs / 1000}s`);
    console.log(`📝 ${auditFile}\n`);

    const maps = await JubelioOrderMap.find({ qbo_invoice_id: { $exists: true, $ne: null } })
        .sort({ _id: -1 }).lean();
    console.log(`🔍 ${maps.length} invoices in scope\n`);

    const stats = {
        total: maps.length, scanned: 0,
        sourceFromPayload: 0, sourceFromApi: 0, sourceMissing: 0,
        skippedAlreadyAdjusted: 0, skippedNoFees: 0, skippedAlreadyMatchesGrandTotal: 0,
        planned: 0, applied: 0, errors: 0,
        paidNeedsAdjust: 0, unpaidNeedsAdjust: 0,
        totalAdjustmentRp: 0,
        hitDeadline: false,
    };
    const flaggedPaidOverapply = [];
    const sourceMissingSO = [];

    let processed = 0;
    for (const m of maps) {
        if (processed >= limit) break;
        if (Date.now() - start > deadlineMs) { stats.hitDeadline = true; break; }
        processed++;
        stats.scanned++;

        const sn = m.salesorder_no;
        try {
            // Fetch Jubelio source data
            const src = await resolveJubelioSource(m);
            if (!src || src.error || !src.source) {
                stats.sourceMissing++;
                sourceMissingSO.push(sn);
                audit({ sn, status: 'no-source', error: src?.error });
                continue;
            }
            const so = src.source;
            if (src.origin === 'payload') stats.sourceFromPayload++; else stats.sourceFromApi++;

            // Fetch QBO invoice
            const body = await qboFetch(qbo, `/invoice/${m.qbo_invoice_id}`);
            const inv = body?.Invoice;
            if (!inv) { stats.errors++; audit({ sn, status: 'invoice-not-found' }); continue; }

            // Idempotency: already has marketplace fee discount line?
            const alreadyAdjusted = (inv.Line || []).some(l =>
                l.DetailType === 'DiscountLineDetail' &&
                String(l.Description || '').startsWith(MARKETPLACE_FEE_DESC_PREFIX));
            if (alreadyAdjusted) {
                stats.skippedAlreadyAdjusted++;
                audit({ sn, status: 'already-adjusted' });
                continue;
            }

            const grandTotal = Number(so.grand_total ?? NaN);
            if (!Number.isFinite(grandTotal)) {
                stats.errors++;
                audit({ sn, status: 'no-grand_total' });
                continue;
            }

            // Compute adjustment from QBO invoice's CURRENT line totals
            const linesTotal = (inv.Line || []).reduce((s, l) => {
                if (l.DetailType === 'DiscountLineDetail') return s - Number(l.Amount || 0);
                if (l.DetailType === 'SalesItemLineDetail') return s + Number(l.Amount || 0);
                return s;
            }, 0);
            const adjustment = Math.round((linesTotal - grandTotal) * 100) / 100;

            if (adjustment <= 0.01) {
                if (adjustment >= -0.01) stats.skippedAlreadyMatchesGrandTotal++;
                else stats.skippedNoFees++;  // negative adjustment = customer paid more (rare)
                audit({ sn, status: 'no-adjustment-needed', linesTotal, grandTotal, adjustment });
                continue;
            }

            // Track paid-vs-unpaid for over-apply risk
            const isPaid = Number(inv.Balance || 0) === 0 && Number(inv.TotalAmt || 0) > 0;
            if (isPaid) {
                stats.paidNeedsAdjust++;
                flaggedPaidOverapply.push({ sn, qboId: inv.Id, oldTotal: inv.TotalAmt, newTotal: grandTotal, overApplyAmount: adjustment });
            } else {
                stats.unpaidNeedsAdjust++;
            }

            stats.planned++;
            stats.totalAdjustmentRp += adjustment;

            const newLine = {
                Description: buildFeeLineDescription(so).substring(0, 4000),
                Amount: adjustment,
                DetailType: 'DiscountLineDetail',
                DiscountLineDetail: { PercentBased: false },
            };

            console.log(`  🔧 ${sn} (id=${inv.Id}, source=${src.origin}, paid=${isPaid}) total ${fmt(inv.TotalAmt)} → ${fmt(grandTotal)} · adj=${fmt(adjustment)}`);
            audit({ sn, qboId: inv.Id, source: src.origin, oldTotal: inv.TotalAmt, grandTotal, adjustment, isPaid, dryRun: !apply });

            if (!apply) continue;

            // Build new Line[] = existing lines + DiscountLineDetail. Preserve order; QBO regenerates SubTotal.
            const newLines = (inv.Line || []).filter(l => l.DetailType !== 'SubTotalLineDetail');
            newLines.push(newLine);

            try {
                const updated = await qboFetch(qbo, '/invoice', {
                    method: 'POST',
                    body: JSON.stringify({
                        Id: inv.Id, SyncToken: inv.SyncToken, sparse: true,
                        Line: newLines, TxnTaxDetail: {},
                    }),
                });
                const newInv = updated?.Invoice;
                stats.applied++;
                audit({ sn, qboId: inv.Id, status: 'applied', newSyncToken: newInv?.SyncToken, newTotal: newInv?.TotalAmt, newBalance: newInv?.Balance });
                await sleep(120);
            } catch (e) {
                console.error(`     💥 update failed: ${e.message.slice(0, 250)}`);
                stats.errors++;
                audit({ sn, qboId: inv.Id, status: 'error', error: e.message });
            }
        } catch (e) {
            console.error(`  💥 ${sn}: ${e.message.slice(0, 250)}`);
            stats.errors++;
            audit({ sn, status: 'fatal', error: e.message });
        }
    }

    console.log(`\n📊 SUMMARY`);
    for (const [k, v] of Object.entries(stats)) {
        if (k === 'totalAdjustmentRp') console.log(`  ${k.padEnd(28)} ${fmt(v)}`);
        else console.log(`  ${k.padEnd(28)} ${v}`);
    }
    console.log(`  runMs                        ${Date.now() - start}`);
    console.log(`  remaining                    ${maps.length - processed}`);

    if (flaggedPaidOverapply.length) {
        console.log(`\n⚠️  ${flaggedPaidOverapply.length} PAID invoice(s) would over-apply by adjustment amount (finance follow-up required):`);
        for (const f of flaggedPaidOverapply.slice(0, 15)) {
            console.log(`  • ${f.sn} (qbo ${f.qboId}): total ${fmt(f.oldTotal)} → ${fmt(f.newTotal)}, payment over by ${fmt(f.overApplyAmount)}`);
        }
        if (flaggedPaidOverapply.length > 15) console.log(`  …and ${flaggedPaidOverapply.length - 15} more (see audit log)`);
    }
    if (sourceMissingSO.length) {
        console.log(`\n⚠️  ${sourceMissingSO.length} invoice(s) without Jubelio source data (skipped):`);
        for (const s of sourceMissingSO.slice(0, 10)) console.log(`  • ${s}`);
        if (sourceMissingSO.length > 10) console.log(`  …and ${sourceMissingSO.length - 10} more`);
    }
    console.log(`\n📝 Audit: ${auditFile}`);
    await mongoose.disconnect();
})().catch(async e => { console.error('💥 FATAL:', e); try { await mongoose.disconnect(); } catch {} process.exit(1); });
