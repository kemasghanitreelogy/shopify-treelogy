// Backfill QBO invoices that have shipping lines bucketed into the generic
// "Sales" item. Sets SalesItemLineDetail.ItemRef to the dedicated
// "Shipping Charge" Service item so reports break shipping out cleanly.
//
// Safety:
//   - Dry-run by default: prints planned changes, makes ZERO API writes.
//   - --apply required to write. --limit caps the batch size.
//   - --since=YYYY-MM-DD narrows scope to invoices last_synced_at >= date.
//   - Each apply fetches the live invoice (so SyncToken is fresh), mutates
//     ONLY the shipping line(s), wipes TxnTaxDetail (per integration policy)
//     so QBO recomputes tax from current line-level TaxCodeRefs.
//   - Writes audit log (JSONL) of every attempt so we have full traceability.
//
// Usage:
//   # Preview everything, no writes:
//   node scripts/fix-shipping-itemref.js
//
//   # Preview last 30 days only:
//   node scripts/fix-shipping-itemref.js --since=2026-03-28
//
//   # Apply, capped at 5 invoices (small canary):
//   node scripts/fix-shipping-itemref.js --apply --limit=5
//
//   # Apply all flagged in last 30 days:
//   node scripts/fix-shipping-itemref.js --apply --since=2026-03-28
//
// Out of scope:
//   - Product lines that fell into "Sales" because Jubelio item lookup failed.
//     Those need a separate re-mapping pass (see TaskCreate #5).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const { getQboInstance } = require('../services/qboService');

const args = process.argv.slice(2);
const arg = (k, def) => {
    const hit = args.find(a => a.startsWith(`--${k}=`));
    return hit ? hit.split('=')[1] : def;
};
const flag = (k) => args.includes(`--${k}`);

const apply = flag('apply');
const limit = Number(arg('limit', '0'));
const since = arg('since', '');
const SHIPPING_ITEM_NAME = 'Shipping Charge';

const auditPath = path.join(
    process.cwd(),
    `audit-fix-shipping-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
);

const writeAudit = (entry) => {
    fs.appendFileSync(auditPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
};

const getInvoice = (qbo, id) => new Promise((resolve, reject) => {
    qbo.getInvoice(id, (err, body) => err ? reject(err) : resolve(body));
});
const updateInvoice = (qbo, payload) => new Promise((resolve, reject) => {
    qbo.updateInvoice(payload, (err, body) => err ? reject(err) : resolve(body));
});
const findItemsByName = (qbo, name) => new Promise((resolve) => {
    qbo.findItems([{ field: 'Name', value: name, operator: '=' }], (err, body) => {
        if (err) return resolve([]);
        resolve(body?.QueryResponse?.Item || []);
    });
});

const isShippingLine = (line) =>
    line?.DetailType === 'SalesItemLineDetail' &&
    /^Shipping \(/i.test(String(line?.Description || ''));

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    // Resolve target item ID once. Same item the forward fix uses.
    const items = await findItemsByName(qbo, SHIPPING_ITEM_NAME);
    const SAFE = new Set(['Service', 'Inventory', 'NonInventory']);
    const target = items.find(i => SAFE.has(i.Type));
    if (!target) {
        console.error(`❌ "${SHIPPING_ITEM_NAME}" item not found in QBO. Forward webhook flow will create it on first sync, or create manually before running backfill.`);
        await mongoose.disconnect();
        process.exit(1);
    }
    const TARGET_ID = String(target.Id);
    console.log(`✅ Target item: "${target.Name}" id=${TARGET_ID} type=${target.Type}`);

    const filter = since ? { last_synced_at: { $gte: new Date(since) } } : {};
    const rows = await JubelioOrderMap.find(filter)
        .select('salesorder_no qbo_invoice_id last_synced_at')
        .sort({ last_synced_at: -1 })
        .lean();

    console.log(`\nMode: ${apply ? '🔥 APPLY' : '🧪 DRY-RUN'}${limit > 0 ? ` (limit ${limit})` : ''}${since ? ` since ${since}` : ' (ALL TIME)'}`);
    console.log(`Audit log: ${auditPath}`);
    console.log(`Scanning ${rows.length} JubelioOrderMap entries...\n`);

    let processed = 0;
    let plannedInvoices = 0;
    let plannedLines = 0;
    let appliedInvoices = 0;
    let appliedLines = 0;
    let skipped = 0;
    let failed = 0;

    for (const r of rows) {
        if (limit > 0 && plannedInvoices >= limit) break;
        processed++;
        if (processed % 50 === 0) process.stdout.write(`\r  scanned ${processed}/${rows.length}...`);

        let inv;
        try {
            inv = await getInvoice(qbo, r.qbo_invoice_id);
        } catch (e) {
            const msg = String(e.message || e).slice(0, 200);
            if (!/Object Not Found|6240|404/i.test(msg)) {
                writeAudit({ event: 'fetch_error', so: r.salesorder_no, inv: r.qbo_invoice_id, error: msg });
            }
            continue;
        }

        const lines = Array.isArray(inv?.Line) ? inv.Line : [];
        const shipLines = lines.filter(isShippingLine);
        if (shipLines.length === 0) { skipped++; continue; }

        // Find shipping lines that need fixing
        const toFix = shipLines.filter(ln => {
            const refValue = String(ln?.SalesItemLineDetail?.ItemRef?.value || '');
            return refValue !== TARGET_ID;
        });
        if (toFix.length === 0) { skipped++; continue; }

        plannedInvoices++;
        plannedLines += toFix.length;

        const summary = toFix.map(ln => ({
            lineId: ln.Id,
            amount: ln.Amount,
            description: ln.Description,
            currentRef: ln?.SalesItemLineDetail?.ItemRef || null,
        }));
        console.log(`  ${apply ? '🔧' : '👁'} ${r.salesorder_no} inv=${r.qbo_invoice_id} → fix ${toFix.length} line(s):`);
        for (const s of summary) {
            console.log(`      line=${s.lineId} amt=${s.amount} from='${s.currentRef?.name || '(none)'}'(${s.currentRef?.value || '-'}) → '${SHIPPING_ITEM_NAME}'(${TARGET_ID}) desc='${s.description}'`);
        }

        if (!apply) {
            writeAudit({ event: 'plan', so: r.salesorder_no, inv: r.qbo_invoice_id, lines: summary });
            continue;
        }

        // Build mutated Line[]: every line preserved, shipping lines get correct ItemRef.
        const newLines = lines.map(ln => {
            if (!isShippingLine(ln)) return ln;
            const refValue = String(ln?.SalesItemLineDetail?.ItemRef?.value || '');
            if (refValue === TARGET_ID) return ln;
            return {
                ...ln,
                SalesItemLineDetail: {
                    ...ln.SalesItemLineDetail,
                    ItemRef: { value: TARGET_ID, name: SHIPPING_ITEM_NAME },
                },
            };
        });

        const payload = {
            Id: String(r.qbo_invoice_id),
            SyncToken: String(inv.SyncToken),
            sparse: true,
            Line: newLines,
            // Wipe stale TxnTaxDetail so QBO recomputes from current line-level
            // TaxCodeRefs. Same policy as forward webhook flow — without this,
            // QBO can throw "Invalid tax rate id" on update if the persisted
            // detail references a now-deleted tax rate.
            TxnTaxDetail: {},
        };

        try {
            const updated = await updateInvoice(qbo, payload);
            appliedInvoices++;
            appliedLines += toFix.length;
            writeAudit({
                event: 'applied',
                so: r.salesorder_no,
                inv: r.qbo_invoice_id,
                lines: summary,
                newSyncToken: updated.SyncToken,
            });
        } catch (e) {
            failed++;
            const msg = String(e.message || JSON.stringify(e)).slice(0, 400);
            console.log(`      ❌ ${msg}`);
            writeAudit({ event: 'error', so: r.salesorder_no, inv: r.qbo_invoice_id, lines: summary, error: msg });
        }
    }
    process.stdout.write('\r');

    console.log(`\n=== Summary ===`);
    console.log(`Mode:                       ${apply ? 'APPLY' : 'DRY-RUN'}`);
    console.log(`Scanned invoices:           ${processed}`);
    console.log(`Skipped (clean / no ship):  ${skipped}`);
    console.log(`Planned invoices to fix:    ${plannedInvoices}`);
    console.log(`Planned lines to fix:       ${plannedLines}`);
    if (apply) {
        console.log(`Applied invoices:           ${appliedInvoices}`);
        console.log(`Applied lines:              ${appliedLines}`);
        console.log(`Failed:                     ${failed}`);
    }
    console.log(`Audit log:                  ${auditPath}`);

    await mongoose.disconnect();
    process.exit(0);
})().catch(e => {
    console.error('Backfill failed:', e);
    process.exit(1);
});
