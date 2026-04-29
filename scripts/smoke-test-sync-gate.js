// Read-only smoke test for the new sync gate.
// Pulls recent JubelioPayloadLog entries and simulates the gate decision
// (without touching QBO). Verifies:
//   - Marketplace orders with payment_date → sync (early sync working)
//   - Shopify PAID/COMPLETED orders → sync (status-based fallback working)
//   - Marketplace orders without payment_date → skip (still gated correctly)
//   - Bypass channels (LB/CS/DP/DW) → always sync

require('dotenv').config();
const mongoose = require('mongoose');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');

const PAID_STATUSES = new Set(['PAID', 'COMPLETED']);
const BYPASS_STATUS_PREFIXES = new Set((process.env.JUBELIO_BYPASS_STATUS_PREFIXES || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean));

const getSoPrefix = (so) => {
    const m = String(so?.salesorder_no || '').match(/^([A-Z]{2,5})-/);
    return m ? m[1] : '';
};
const hasPaymentSignal = (so) => {
    if (so && so.payment_date && String(so.payment_date).trim()) return true;
    const st = String(so?.status || '').toUpperCase();
    return PAID_STATUSES.has(st);
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const samples = await JubelioPayloadLog.find({ endpoint: 'pesanan' })
        .sort({ received_at: -1 })
        .limit(500)
        .lean();

    const stats = {
        total: samples.length,
        wouldSync: 0,
        wouldSkip: 0,
        wouldVoid: 0,
        bySrcAndStatus: {},
        skipReasonByChannel: {},
        wouldSyncByChannel: {},
    };

    for (const log of samples) {
        const so = log.payload || {};
        const statusUpper = String(so.status || '').toUpperCase();
        const prefix = getSoPrefix(so);
        const bypassStatus = BYPASS_STATUS_PREFIXES.has(prefix);
        const buyerPaid = hasPaymentSignal(so);
        const shouldVoid = !!so.is_canceled;
        const shouldSync = bypassStatus || buyerPaid;

        const k = `${log.source_name || prefix || '?'}/${statusUpper || '?'}`;
        stats.bySrcAndStatus[k] = stats.bySrcAndStatus[k] || { sync: 0, skip: 0, void: 0 };

        if (shouldVoid) {
            stats.wouldVoid++;
            stats.bySrcAndStatus[k].void++;
        } else if (shouldSync) {
            stats.wouldSync++;
            stats.bySrcAndStatus[k].sync++;
            stats.wouldSyncByChannel[prefix] = (stats.wouldSyncByChannel[prefix] || 0) + 1;
        } else {
            stats.wouldSkip++;
            stats.bySrcAndStatus[k].skip++;
            stats.skipReasonByChannel[prefix] = (stats.skipReasonByChannel[prefix] || 0) + 1;
        }
    }

    console.log(`\nSMOKE TEST  last ${stats.total} pesanan webhooks (read-only, no QBO calls)\n`);
    console.log(`OUTCOMES:`);
    console.log(`  wouldSync = ${stats.wouldSync}`);
    console.log(`  wouldSkip = ${stats.wouldSkip}`);
    console.log(`  wouldVoid = ${stats.wouldVoid}`);
    console.log();
    console.log(`Per-channel sync count:`);
    for (const [c, n] of Object.entries(stats.wouldSyncByChannel).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${c.padEnd(8)} ${n}`);
    }
    console.log(`\nPer-channel skip count:`);
    for (const [c, n] of Object.entries(stats.skipReasonByChannel).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${c.padEnd(8)} ${n}`);
    }
    console.log(`\nDecision matrix (top 15 by total):`);
    const rows = Object.entries(stats.bySrcAndStatus).map(([k, v]) => ({ k, total: v.sync + v.skip + v.void, ...v }));
    rows.sort((a, b) => b.total - a.total);
    console.log(`  ${'src/status'.padEnd(28)} sync  skip  void  total`);
    for (const r of rows.slice(0, 15)) {
        console.log(`  ${r.k.padEnd(28)} ${String(r.sync).padStart(4)}  ${String(r.skip).padStart(4)}  ${String(r.void).padStart(4)}  ${String(r.total).padStart(5)}`);
    }

    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
