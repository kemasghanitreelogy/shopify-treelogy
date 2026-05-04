// Read-only: dump first/last raw /faktur payloads to understand the actual
// shape Jubelio sends. The current handler relies on action=/delete/i, but
// audit-faktur-events.js shows all 610 events come in as action="hook-invoice".
// We need to know what field actually signals delete (is_canceled? a status?
// or does Jubelio simply not send delete via /faktur at all?).

require('dotenv').config();
const mongoose = require('mongoose');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);

    const samples = await JubelioPayloadLog.find({ endpoint: 'faktur' })
        .sort({ received_at: -1 })
        .limit(5)
        .lean();

    console.log(`\n=== Last 5 /faktur payloads ===\n`);
    for (const s of samples) {
        console.log(`--- ${s.received_at.toISOString()} action=${s.action} ---`);
        console.log(JSON.stringify(s.payload, null, 2));
        console.log('');
    }

    // Also: distinct top-level keys observed
    const all = await JubelioPayloadLog.find({ endpoint: 'faktur' }).select('payload').lean();
    const keyCounts = new Map();
    for (const r of all) {
        for (const k of Object.keys(r.payload || {})) {
            keyCounts.set(k, (keyCounts.get(k) || 0) + 1);
        }
    }
    console.log(`\n=== Distinct top-level keys across ${all.length} /faktur events ===`);
    for (const [k, n] of [...keyCounts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k.padEnd(28)} ${n}`);
    }

    // Distinct values for fields that might signal delete
    const interesting = ['action', 'status', 'is_canceled', 'is_deleted', 'is_void', 'event'];
    console.log(`\n=== Distinct values for likely-delete-signal fields ===`);
    for (const f of interesting) {
        const dist = new Map();
        for (const r of all) {
            if (!(f in (r.payload || {}))) continue;
            const v = String(r.payload[f]);
            dist.set(v, (dist.get(v) || 0) + 1);
        }
        if (dist.size === 0) {
            console.log(`  ${f.padEnd(15)} (field never present)`);
        } else {
            console.log(`  ${f.padEnd(15)} ${[...dist.entries()].map(([v, n]) => `"${v}"=${n}`).join(', ')}`);
        }
    }

    await mongoose.disconnect();
    process.exit(0);
})().catch(e => {
    console.error('Inspect failed:', e);
    process.exit(1);
});
