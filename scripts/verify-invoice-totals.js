// Verify QBO invoice totals match Jubelio grand_total (read-only).
//
// For each invoice in JubelioOrderMap:
//   1. Resolve Jubelio source-of-truth (payload log first, Jubelio API fallback).
//   2. Fetch QBO invoice → TotalAmt + Balance.
//   3. Compare against so.grand_total with ±1 IDR tolerance.
//   4. Categorize: match / mismatch (over QBO, under QBO) / no-source / qbo-not-found.
//   5. Write summary + per-invoice CSV with mismatch detail.
//
// Bounded by --limit=N and DEADLINE_MS=240000 (override via env).
//
// Usage:
//   node scripts/verify-invoice-totals.js                 # verify all (read-only)
//   node scripts/verify-invoice-totals.js --limit=50      # first 50 only
//   DEADLINE_MS=580000 node scripts/verify-invoice-totals.js --limit=2000

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const { getQboInstance } = require('../services/qboService');
const jubelioApi = require('../services/jubelioApiService');

const args = process.argv.slice(2);
const limit = (() => {
    const a = args.find(x => x.startsWith('--limit='));
    return a ? Number(a.split('=')[1]) : Infinity;
})();
const skip = (() => {
    const a = args.find(x => x.startsWith('--skip='));
    return a ? Number(a.split('=')[1]) : 0;
})();
const deadlineMs = Number(process.env.DEADLINE_MS || 240_000);
const TOLERANCE = 1; // ±1 IDR — Jubelio rounds to integer rupiah

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID')}`;

const qboBaseUrl = (qbo) => `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
const qboFetch = async (qbo, p) => {
    const url = `${qboBaseUrl(qbo)}${p}${p.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
    const MAX_RETRY = 4;
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' },
            });
            const text = await res.text();
            let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
            if (res.status === 429 || res.status >= 500) {
                const wait = Math.min(30_000, 1500 * Math.pow(2, attempt));
                lastErr = new Error(`QBO GET ${p} (${res.status})`);
                await sleep(wait);
                continue;
            }
            if (!res.ok) throw new Error(`QBO GET ${p} (${res.status}): ${JSON.stringify(body).slice(0, 400)}`);
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

(async () => {
    const start = Date.now();
    await mongoose.connect(process.env.MONGODB_URI);
    if (jubelioApi.isConfigured()) await jubelioApi.login();
    const qbo = await getQboInstance();

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const auditFile = `verify-invoice-totals-${ts}.jsonl`;
    const csvFile = `verify-invoice-totals-mismatches-${ts}.csv`;
    const audit = (e) => fs.appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');

    fs.writeFileSync(csvFile, 'salesorder_no,qbo_invoice_id,channel,jubelio_grand_total,qbo_total,qbo_balance,diff,direction,is_paid,has_marketplace_fee_line\n');

    console.log(`\n🔍 Verify invoice totals · read-only · limit=${limit === Infinity ? '∞' : limit} · deadline=${deadlineMs / 1000}s · tolerance=±${TOLERANCE} IDR`);
    console.log(`📝 ${auditFile}`);
    console.log(`📊 ${csvFile}\n`);

    const allMaps = await JubelioOrderMap.find({ qbo_invoice_id: { $exists: true, $ne: null } })
        .sort({ _id: -1 }).lean();
    const maps = skip > 0 ? allMaps.slice(skip) : allMaps;
    console.log(`📦 ${allMaps.length} invoices total · skip=${skip} · scanning ${maps.length}\n`);

    const stats = {
        total: maps.length, scanned: 0,
        match: 0,
        mismatchOver: 0,    // QBO > Jubelio
        mismatchUnder: 0,   // QBO < Jubelio
        sourceMissing: 0,
        invoiceNotFound: 0,
        errors: 0,
        hitDeadline: false,
        sumDiffOver: 0,
        sumDiffUnder: 0,
    };
    const mismatches = [];

    let processed = 0;
    for (const m of maps) {
        if (processed >= limit) break;
        if (Date.now() - start > deadlineMs) { stats.hitDeadline = true; break; }
        processed++;
        stats.scanned++;

        const sn = m.salesorder_no;
        try {
            const src = await resolveJubelioSource(m);
            if (!src || src.error || !src.source) {
                stats.sourceMissing++;
                audit({ sn, status: 'no-source', error: src?.error });
                continue;
            }
            const so = src.source;
            const grandTotal = Number(so.grand_total);
            if (!Number.isFinite(grandTotal)) {
                stats.errors++;
                audit({ sn, status: 'no-grand_total' });
                continue;
            }

            const body = await qboFetch(qbo, `/invoice/${m.qbo_invoice_id}`);
            const inv = body?.Invoice;
            if (!inv) {
                stats.invoiceNotFound++;
                audit({ sn, status: 'invoice-not-found', qboId: m.qbo_invoice_id });
                continue;
            }

            const qboTotal = Number(inv.TotalAmt || 0);
            const qboBalance = Number(inv.Balance || 0);
            const diff = Math.round((qboTotal - grandTotal) * 100) / 100;
            const isPaid = qboBalance === 0 && qboTotal > 0;
            const hasMarketplaceFeeLine = (inv.Line || []).some(l =>
                l.DetailType === 'DiscountLineDetail' &&
                String(l.Description || '').startsWith('Marketplace fees & adjustments'));

            if (Math.abs(diff) <= TOLERANCE) {
                stats.match++;
                audit({ sn, status: 'match', qboTotal, grandTotal, diff });
                continue;
            }

            const direction = diff > 0 ? 'qbo-over' : 'qbo-under';
            if (diff > 0) { stats.mismatchOver++; stats.sumDiffOver += diff; }
            else { stats.mismatchUnder++; stats.sumDiffUnder += Math.abs(diff); }

            const channel = sn.split('-')[0];
            const row = {
                sn, qboId: inv.Id, channel,
                grandTotal, qboTotal, qboBalance, diff, direction,
                isPaid, hasMarketplaceFeeLine,
            };
            mismatches.push(row);

            fs.appendFileSync(csvFile,
                `${sn},${inv.Id},${channel},${grandTotal},${qboTotal},${qboBalance},${diff},${direction},${isPaid},${hasMarketplaceFeeLine}\n`);

            audit({ sn, status: 'mismatch', ...row });
        } catch (e) {
            stats.errors++;
            audit({ sn, status: 'error', error: e.message });
        }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log('\n────────── SUMMARY ──────────');
    console.log(`Scanned         : ${stats.scanned} / ${stats.total}`);
    console.log(`✅ Match         : ${stats.match}`);
    console.log(`❌ Mismatch over : ${stats.mismatchOver}  (QBO > Jubelio, sum ${fmt(stats.sumDiffOver)})`);
    console.log(`❌ Mismatch under: ${stats.mismatchUnder} (QBO < Jubelio, sum ${fmt(stats.sumDiffUnder)})`);
    console.log(`⚠️  No source    : ${stats.sourceMissing}`);
    console.log(`⚠️  Invoice 404  : ${stats.invoiceNotFound}`);
    console.log(`💥 Errors        : ${stats.errors}`);
    console.log(`Hit deadline     : ${stats.hitDeadline ? 'YES' : 'no'} (elapsed ${elapsed}s)`);

    if (stats.mismatchOver + stats.mismatchUnder > 0) {
        console.log('\n🔝 Top 10 mismatches by diff:');
        mismatches.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
        for (const r of mismatches.slice(0, 10)) {
            console.log(`  ${r.sn} (${r.channel}) qbo=${fmt(r.qboTotal)} jub=${fmt(r.grandTotal)} diff=${fmt(r.diff)} ${r.direction} paid=${r.isPaid} mktFeeLine=${r.hasMarketplaceFeeLine}`);
        }

        const byChannel = {};
        for (const r of mismatches) {
            byChannel[r.channel] = (byChannel[r.channel] || 0) + 1;
        }
        console.log('\n📊 Mismatches by channel:');
        for (const [ch, n] of Object.entries(byChannel).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${ch}: ${n}`);
        }
    }

    console.log(`\n📝 Audit log: ${auditFile}`);
    console.log(`📊 CSV: ${csvFile}\n`);

    await mongoose.disconnect();
    process.exit(0);
})().catch(e => {
    console.error(e);
    process.exit(1);
});
