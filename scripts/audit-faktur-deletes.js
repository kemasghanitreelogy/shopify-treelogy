// Audit /faktur delete handling.
//
// Why this exists (R5):
//   routes/jubelioWebhook.js:1812 calls voidMappedInvoice() on /faktur delete.
//   Failure modes:
//     - Mapping missing → void silently no-ops (no JubelioOrderMap entry).
//     - QBO invoice already voided (idempotent, fine).
//     - QBO invoice still active → void should have flipped it; if not, drift.
//   This script scans every /faktur delete event in the window and verifies
//   the linked QBO invoice is actually voided/absent. Lists drift cases.
//
// Read-only. Does QBO GET only. No writes.
//
// Usage:
//   node scripts/audit-faktur-deletes.js
//   node scripts/audit-faktur-deletes.js --days=14
//   node scripts/audit-faktur-deletes.js --csv=out.csv

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const { getQboInstance } = require('../services/qboService');

const args = process.argv.slice(2);
const arg = (k, def) => {
    const hit = args.find(a => a.startsWith(`--${k}=`));
    return hit ? hit.split('=')[1] : def;
};

const days = Number(arg('days', '30'));
const csvPath = arg('csv', '');

const getInvoice = (qbo, id) => new Promise((resolve) => {
    qbo.getInvoice(id, (err, body) =>
        err ? resolve({ err: String(err.message || err).slice(0, 200) }) : resolve({ inv: body }));
});

const isVoided = (inv) => {
    if (!inv) return null; // unknown
    // QBO marks voided invoices with TotalAmt=0 and PrivateNote prefix "Voided",
    // or status field. Most reliable: TotalAmt=0 AND DocNumber retained.
    if (Number(inv.TotalAmt || 0) === 0 && Number(inv.Balance || 0) === 0) return true;
    const note = String(inv.PrivateNote || '');
    if (/voided|void/i.test(note)) return true;
    return false;
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    const since = new Date(Date.now() - days * 86400000);
    const rows = await JubelioPayloadLog.find({
        endpoint: 'faktur',
        received_at: { $gte: since },
    })
        .select('received_at action invoice_no salesorder_no payload')
        .sort({ received_at: -1 })
        .lean();

    const deletes = rows.filter(r => /delete/i.test(String(r.action || '')));
    console.log(`\n=== /faktur Delete Drift Audit (last ${days}d) ===`);
    console.log(`Found ${deletes.length} delete events out of ${rows.length} total /faktur events\n`);

    if (deletes.length === 0) {
        console.log('No delete events to audit.');
        await mongoose.disconnect();
        return process.exit(0);
    }

    const cases = {
        voided: [],         // QBO invoice exists and is voided — OK
        active: [],         // QBO invoice still active despite delete event — DRIFT
        notFound: [],       // QBO invoice not in QBO at all — could be hard-deleted (rare) or never existed
        noMapping: [],      // Mapping missing → void was no-op, but might have been correct if invoice never created
        error: [],
    };

    let processed = 0;
    for (const r of deletes) {
        processed++;
        if (processed % 25 === 0) process.stdout.write(`\r  scanned ${processed}/${deletes.length}...`);

        const refNo = r.payload?.ref_no || r.salesorder_no;
        if (!refNo) {
            cases.noMapping.push({ ...r, reason: 'no ref_no in payload' });
            continue;
        }

        const map = await JubelioOrderMap.findOne({ salesorder_no: refNo }).lean();
        if (!map?.qbo_invoice_id) {
            cases.noMapping.push({ ...r, refNo, reason: 'no JubelioOrderMap entry' });
            continue;
        }

        const { inv, err } = await getInvoice(qbo, map.qbo_invoice_id);
        if (err) {
            if (/Object Not Found|6240|404/i.test(err)) {
                cases.notFound.push({ ...r, refNo, qboInvoiceId: map.qbo_invoice_id });
            } else {
                cases.error.push({ ...r, refNo, qboInvoiceId: map.qbo_invoice_id, err });
            }
            continue;
        }

        const voided = isVoided(inv);
        if (voided) {
            cases.voided.push({ ...r, refNo, qboInvoiceId: inv.Id, totalAmt: inv.TotalAmt });
        } else {
            cases.active.push({
                ...r,
                refNo,
                qboInvoiceId: inv.Id,
                docNumber: inv.DocNumber,
                totalAmt: inv.TotalAmt,
                balance: inv.Balance,
                txnDate: inv.TxnDate,
            });
        }
    }
    process.stdout.write('\r');

    console.log(`\nResults:`);
    console.log(`  ✅ Voided in QBO (handled correctly):     ${cases.voided.length}`);
    console.log(`  🚫 Not found in QBO (likely never synced): ${cases.notFound.length}`);
    console.log(`  ⏭️  No mapping (silent skip — likely OK):  ${cases.noMapping.length}`);
    console.log(`  ⚠️  STILL ACTIVE in QBO (DRIFT):           ${cases.active.length}`);
    console.log(`  ❌ Errors:                                 ${cases.error.length}`);

    if (cases.active.length > 0) {
        console.log(`\n⚠️  DRIFT — these invoices were marked deleted in Jubelio but are still live in QBO:`);
        for (const c of cases.active.slice(0, 30)) {
            console.log(`  ${c.received_at.toISOString()}  ref=${c.refNo}  qbo=${c.qboInvoiceId} doc=${c.docNumber} totalAmt=${c.totalAmt} balance=${c.balance}`);
        }
        if (cases.active.length > 30) console.log(`  ... and ${cases.active.length - 30} more`);
    }

    if (cases.error.length > 0) {
        console.log(`\nErrors (first 10):`);
        for (const e of cases.error.slice(0, 10)) console.log(`  ref=${e.refNo}: ${e.err}`);
    }

    if (csvPath) {
        const header = 'received_at,case,ref_no,qbo_invoice_id,doc_number,total_amt,balance,txn_date,note\n';
        const lines = [];
        for (const c of cases.active) lines.push([c.received_at.toISOString(), 'DRIFT_ACTIVE', c.refNo, c.qboInvoiceId, c.docNumber || '', c.totalAmt || '', c.balance || '', c.txnDate || '', ''].join(','));
        for (const c of cases.notFound) lines.push([c.received_at.toISOString(), 'NOT_FOUND', c.refNo, c.qboInvoiceId, '', '', '', '', ''].join(','));
        for (const c of cases.noMapping) lines.push([c.received_at.toISOString(), 'NO_MAPPING', c.refNo || '', '', '', '', '', '', `"${c.reason}"`].join(','));
        for (const c of cases.error) lines.push([c.received_at.toISOString(), 'ERROR', c.refNo, c.qboInvoiceId, '', '', '', '', `"${(c.err || '').replace(/"/g, '""')}"`].join(','));
        fs.writeFileSync(csvPath, header + lines.join('\n') + '\n');
        console.log(`\nCSV written: ${csvPath} (${lines.length} rows)`);
    }

    await mongoose.disconnect();
    process.exit(0);
})().catch(e => {
    console.error('Audit failed:', e);
    process.exit(1);
});
