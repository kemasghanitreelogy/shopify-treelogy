// Audit /faktur webhook events.
//
// Why this exists (R1):
//   routes/jubelioWebhook.js:1801 currently no-ops on every /faktur action
//   that is NOT a delete (action !== /delete/i). If finance edits an invoice
//   directly in Jubelio (e.g., changes invoice_no, due_date, items), Jubelio
//   POSTs /faktur with action=update or action=create, and our handler
//   silently returns 200 without touching QBO. That can cause silent drift
//   between Jubelio and QBO at the invoice level.
//
//   This script reads JubelioPayloadLog (endpoint='faktur') for the last N
//   days and reports the action distribution + lists every non-delete event,
//   so we can decide whether to enable a /faktur create/edit handler.
//
// Read-only. No QBO calls. No writes anywhere.
//
// Usage:
//   node scripts/audit-faktur-events.js                  # last 30 days (TTL window)
//   node scripts/audit-faktur-events.js --days=14
//   node scripts/audit-faktur-events.js --csv=out.csv    # also write CSV of non-delete events

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');

const args = process.argv.slice(2);
const arg = (k, def) => {
    const hit = args.find(a => a.startsWith(`--${k}=`));
    return hit ? hit.split('=')[1] : def;
};

const days = Number(arg('days', '30'));
const csvPath = arg('csv', '');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);

    const since = new Date(Date.now() - days * 86400000);
    const rows = await JubelioPayloadLog.find({
        endpoint: 'faktur',
        received_at: { $gte: since },
    })
        .select('received_at action invoice_no salesorder_no payload')
        .sort({ received_at: -1 })
        .lean();

    console.log(`\n=== /faktur Webhook Audit (last ${days}d) ===`);
    console.log(`Scanned ${rows.length} entries from JubelioPayloadLog\n`);

    const byAction = new Map();
    const nonDelete = [];

    for (const r of rows) {
        const a = String(r.action || '(none)').toLowerCase();
        byAction.set(a, (byAction.get(a) || 0) + 1);
        if (!/delete/i.test(a)) {
            nonDelete.push(r);
        }
    }

    console.log(`Action distribution:`);
    const sorted = [...byAction.entries()].sort((a, b) => b[1] - a[1]);
    for (const [a, n] of sorted) {
        const marker = /delete/i.test(a) ? '✅ handled' : '⚠️  no-op (silent skip)';
        console.log(`  ${a.padEnd(20)} ${String(n).padStart(5)}  ${marker}`);
    }

    console.log(`\nSummary:`);
    console.log(`  Total /faktur events:        ${rows.length}`);
    console.log(`  Delete (currently handled):  ${rows.length - nonDelete.length}`);
    console.log(`  Non-delete (currently silent skip): ${nonDelete.length}`);

    if (nonDelete.length > 0) {
        console.log(`\nFirst 30 non-delete events (silent skip — might be missed updates):`);
        for (const r of nonDelete.slice(0, 30)) {
            const refNo = r.payload?.ref_no || r.salesorder_no || '-';
            console.log(`  ${r.received_at.toISOString()}  action=${r.action}  invoice=${r.invoice_no || '-'}  ref_no=${refNo}`);
        }
        if (nonDelete.length > 30) {
            console.log(`  ... and ${nonDelete.length - 30} more`);
        }
    }

    if (csvPath && nonDelete.length > 0) {
        const header = 'received_at,action,invoice_no,ref_no,salesorder_no,payload_keys\n';
        const lines = nonDelete.map(r => {
            const refNo = r.payload?.ref_no || '';
            const keys = r.payload ? Object.keys(r.payload).join('|') : '';
            return [
                r.received_at.toISOString(),
                r.action || '',
                r.invoice_no || '',
                refNo,
                r.salesorder_no || '',
                `"${keys}"`,
            ].join(',');
        });
        fs.writeFileSync(csvPath, header + lines.join('\n') + '\n');
        console.log(`\nCSV written: ${csvPath} (${lines.length} rows)`);
    }

    if (nonDelete.length === 0) {
        console.log(`\n✅ No non-delete /faktur events in window. Current silent-skip is safe.`);
    } else {
        console.log(`\n💡 Decision input: ${nonDelete.length} non-delete events were silently skipped.`);
        console.log(`   If any of these correspond to real Jubelio invoice edits that should`);
        console.log(`   have updated QBO, we need a /faktur create/edit handler (Sprint B1).`);
    }

    await mongoose.disconnect();
    process.exit(0);
})().catch(e => {
    console.error('Audit failed:', e);
    process.exit(1);
});
