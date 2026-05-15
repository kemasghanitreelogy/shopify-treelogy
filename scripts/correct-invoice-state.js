// CORRECTIVE: set every modified QBO invoice to its IDEAL state per Jubelio
// source-of-truth + the per-channel policy (Shopee-only fee strip).
//
// Idempotent — re-running is safe. Skips invoices that already match expected.
//
// Per-invoice rule:
//   customerPaid = grand_total + (SP ? service_fee + order_processing_fee : 0)
//   target_TotalAmt   = customerPaid
//   target_Discount   = qboGross − customerPaid   (must be >= 0)
//
// Then: if current state ≠ target, sparse-update the DiscountLineDetail Amount
// (or add/remove the line) to reach the target.
//
// Why this fixes the multi-apply mess: it doesn't care about history of
// previous applies. It just sets each invoice to its ideal state per Jubelio.
// Drop-discount cases will already match (idempotent); rewrite-discount
// cases get their discount restored to the correct value.
//
// Anomaly handling: if computed expDisc < 0, log + skip (means Jubelio shows
// customer paid MORE than gross items — implies missing items in QBO or
// data drift; needs manual review).
//
// Usage:
//   node scripts/correct-invoice-state.js                # dry-run all modified
//   node scripts/correct-invoice-state.js --apply --limit=20
//   DEADLINE_MS=540000 node scripts/correct-invoice-state.js --apply

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const { getQboInstance } = require('../services/qboService');
const jubelioApi = require('../services/jubelioApiService');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limit = (() => { const a = args.find(x => x.startsWith('--limit=')); return a ? Number(a.split('=')[1]) : Infinity; })();
const deadlineMs = Number(process.env.DEADLINE_MS || 540_000);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmt = (n) => `Rp ${Number(n || 0).toLocaleString('id-ID')}`;
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

const qboBaseUrl = (qbo) => `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
const qboFetch = async (qbo, p, opts = {}) => {
    const url = `${qboBaseUrl(qbo)}${p}${p.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
    const MAX_RETRY = 4;
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
        try {
            const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(opts.headers || {}) } });
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

(async () => {
    const start = Date.now();
    await mongoose.connect(process.env.MONGODB_URI);
    if (jubelioApi.isConfigured()) await jubelioApi.login();
    const qbo = await getQboInstance();

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const auditFile = `correct-invoice-state-${ts}.jsonl`;
    const audit = (e) => fs.appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');

    // Build target set: all qboIds that were ever modified by backfill or revert.
    const targetQboIds = new Map();
    for (const f of fs.readdirSync('.').filter(f => (f.startsWith('backfill-remove-mkt-fee-') || f.startsWith('revert-non-sp-')) && f.endsWith('.jsonl'))) {
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
                const o = JSON.parse(line);
                if (o.qboId && (o.action || o.status === 'reverted')) {
                    targetQboIds.set(String(o.qboId), { sn: o.sn });
                }
            } catch { /* */ }
        }
    }

    // Skip-set: already-corrected in prior runs.
    const skipIds = new Set();
    for (const f of fs.readdirSync('.').filter(f => f.startsWith('correct-invoice-state-') && f.endsWith('.jsonl') && f !== auditFile)) {
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
                const o = JSON.parse(line);
                if (o.qboId && (o.status === 'corrected' || o.status === 'already-correct' || o.status === 'voided' || o.status === 'anomaly')) {
                    skipIds.add(String(o.qboId));
                }
            } catch { /* */ }
        }
    }

    const targets = [...targetQboIds.entries()].map(([qboId, m]) => ({ qboId, ...m })).sort((a, b) => Number(b.qboId) - Number(a.qboId));

    console.log(`\n🚀 Correct invoice state · mode=${apply ? 'APPLY' : 'DRY-RUN'} · limit=${limit === Infinity ? '∞' : limit} · deadline=${deadlineMs / 1000}s`);
    console.log(`📝 ${auditFile}`);
    console.log(`🎯 ${targets.length} modified invoices to check`);
    console.log(`⏩ skip-set: ${skipIds.size} already corrected in prior runs\n`);

    const stats = { targets: targets.length, scanned: 0, skipped: 0, alreadyCorrect: 0, corrected: 0, anomalies: 0, noSource: 0, notFound: 0, voided: 0, errors: 0, totalChangeRp: 0, hitDeadline: false };
    const anomalies = [];

    let processed = 0;
    for (const t of targets) {
        if (processed >= limit) break;
        if (Date.now() - start > deadlineMs) { stats.hitDeadline = true; break; }
        if (skipIds.has(String(t.qboId))) { stats.skipped++; continue; }
        processed++;
        stats.scanned++;

        const sn = t.sn;
        try {
            const log = await JubelioPayloadLog.findOne({ salesorder_no: sn }).sort({ _id: -1 }).lean();
            let so = log?.payload;
            if (!so?.grand_total && jubelioApi.isConfigured()) {
                // Fallback: hit Jubelio API directly when payload log expired
                try {
                    const map = await mongoose.connection.db.collection('jubelioordermaps').findOne({ salesorder_no: sn });
                    if (map?.salesorder_id) {
                        const apiSo = await jubelioApi.getOrderDetail(map.salesorder_id);
                        if (apiSo?.grand_total != null) so = apiSo;
                    }
                } catch (e) {
                    // fall through; will be flagged as no-source below
                }
            }
            if (!so?.grand_total) {
                stats.noSource++;
                audit({ sn, qboId: t.qboId, status: 'no-source' });
                continue;
            }

            const body = await qboFetch(qbo, `/invoice/${t.qboId}`);
            const inv = body?.Invoice;
            if (!inv) { stats.notFound++; audit({ sn, qboId: t.qboId, status: 'invoice-not-found' }); continue; }
            if (Number(inv.TotalAmt || 0) === 0) { stats.voided++; audit({ sn, qboId: inv.Id, status: 'voided' }); continue; }

            let gross = 0;
            const filteredLines = (inv.Line || []).filter(l => l.DetailType !== 'SubTotalLineDetail');
            for (const l of filteredLines) if (l.DetailType === 'SalesItemLineDetail') gross += Number(l.Amount || 0);
            gross = r2(gross);

            const isSP = sn.startsWith('SP-');
            const sFee = r2((Number(so.service_fee) || 0) + (Number(so.order_processing_fee) || 0));
            const grandTotal = r2(so.grand_total);
            const customerPaid = r2(grandTotal + (isSP ? sFee : 0));
            const expDisc = r2(gross - customerPaid);

            const currentTotal = r2(inv.TotalAmt);
            let currentDisc = 0;
            for (const l of filteredLines) if (l.DetailType === 'DiscountLineDetail') currentDisc += Number(l.Amount || 0);
            currentDisc = r2(currentDisc);

            // Anomaly: expDisc < 0 means customerPaid > gross. Means either:
            //   - Items are missing in QBO (line removed?), OR
            //   - Jubelio data drift / wrong payload. Skip + flag.
            if (expDisc < -0.01) {
                stats.anomalies++;
                anomalies.push({ sn, qboId: inv.Id, gross, customerPaid, expDisc, currentTotal, currentDisc });
                audit({ sn, qboId: inv.Id, status: 'anomaly', gross, customerPaid, expDisc, currentTotal, currentDisc });
                continue;
            }

            const targetTotal = customerPaid;
            const totalMatches = Math.abs(currentTotal - targetTotal) < 1;
            const discMatches = Math.abs(currentDisc - expDisc) < 1;
            if (totalMatches && discMatches) {
                stats.alreadyCorrect++;
                audit({ sn, qboId: inv.Id, status: 'already-correct', currentTotal, currentDisc });
                continue;
            }

            // Build new Line[]: replace/add/drop DLL to reach expDisc.
            let newLines;
            const existingDiscIdx = filteredLines.findIndex(l => l.DetailType === 'DiscountLineDetail');
            if (expDisc < 0.01) {
                // Target disc is 0 → drop the line if present.
                newLines = existingDiscIdx >= 0 ? filteredLines.filter((_, i) => i !== existingDiscIdx) : filteredLines;
            } else if (existingDiscIdx >= 0) {
                // Rewrite existing DLL amount.
                newLines = filteredLines.map((l, i) => i === existingDiscIdx ? { ...l, Amount: expDisc, Description: `Discount (corrected 2026-05-14)`.substring(0, 4000) } : l);
            } else {
                // Add DLL.
                newLines = [...filteredLines, {
                    Description: `Discount (corrected 2026-05-14)`.substring(0, 4000),
                    Amount: expDisc,
                    DetailType: 'DiscountLineDetail',
                    DiscountLineDetail: { PercentBased: false },
                }];
            }

            stats.totalChangeRp = r2(stats.totalChangeRp + Math.abs(currentTotal - targetTotal));

            console.log(`  🔧 ${sn} (id=${inv.Id}) ${isSP ? '[SP]' : '[non-SP]'} total ${fmt(currentTotal)} → ${fmt(targetTotal)} · disc ${fmt(currentDisc)} → ${fmt(expDisc)}`);
            audit({ sn, qboId: inv.Id, action: 'correct', isSP, currentTotal, targetTotal, currentDisc, expDisc, gross, grandTotal, shopeeFee: sFee, dryRun: !apply });

            if (!apply) continue;

            try {
                const updated = await qboFetch(qbo, '/invoice', {
                    method: 'POST',
                    body: JSON.stringify({ Id: inv.Id, SyncToken: inv.SyncToken, sparse: true, Line: newLines, TxnTaxDetail: {} }),
                });
                const newInv = updated?.Invoice;
                stats.corrected++;
                audit({ sn, qboId: inv.Id, status: 'corrected', newTotal: newInv?.TotalAmt, newBalance: newInv?.Balance, newSyncToken: newInv?.SyncToken });
                await sleep(120);
            } catch (e) {
                stats.errors++;
                audit({ sn, qboId: inv.Id, status: 'error', error: e.message });
                console.error(`     💥 update failed: ${e.message.slice(0, 250)}`);
            }
        } catch (e) {
            stats.errors++;
            audit({ sn, status: 'fatal', error: e.message });
            console.error(`  💥 ${sn}: ${e.message.slice(0, 250)}`);
        }
    }

    console.log(`\n📊 SUMMARY`);
    for (const [k, v] of Object.entries(stats)) {
        if (k === 'totalChangeRp') console.log(`  ${k.padEnd(28)} ${fmt(v)}`);
        else console.log(`  ${k.padEnd(28)} ${v}`);
    }
    console.log(`  runMs                        ${Date.now() - start}`);
    if (anomalies.length) {
        console.log(`\n🚧 ${anomalies.length} anomaly(s) need manual review:`);
        for (const a of anomalies.slice(0, 10)) console.log(`    ${a.sn} (id=${a.qboId}) gross=${fmt(a.gross)} cp=${fmt(a.customerPaid)} expDisc=${fmt(a.expDisc)}`);
    }
    console.log(`\n${apply ? '✅ Correction complete.' : '🧪 Dry-run complete. Re-run with --apply when ready.'}`);
    await mongoose.disconnect();
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
