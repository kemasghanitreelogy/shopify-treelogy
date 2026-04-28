// Audit QBO invoices we manage (via JubelioOrderMap) for shipping lines that
// got bucketed into QBO's generic "Sales" item instead of a dedicated
// "Shipping Charge" item.
//
// Why this exists:
//   The pre-fix shipping line in routes/jubelioWebhook.js created a
//   SalesItemLineDetail without an ItemRef. QBO accepted it but reported the
//   line under the auto-generated "Services" / "Sales" row in
//   "Sales by Product/Service Summary", making printed reports useless because
//   shipping fees are aggregated under an opaque generic bucket.
//
// Detection rule (read-only):
//   - For each JubelioOrderMap entry, fetch the QBO Invoice.
//   - For each Line with Description matching /^Shipping \(/i AND
//     DetailType=SalesItemLineDetail, flag the line if its ItemRef name is
//     NOT "Shipping Charge" (covers both missing ItemRef and ItemRef pointing
//     at the wrong item).
//
// Usage:
//   node scripts/audit-shipping-itemref.js                  # report only, all time
//   node scripts/audit-shipping-itemref.js --days=30        # narrow window
//   node scripts/audit-shipping-itemref.js --csv=out.csv    # also write CSV
//   node scripts/audit-shipping-itemref.js --limit=100      # cap rows scanned

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const { getQboInstance } = require('../services/qboService');

const args = process.argv.slice(2);
const arg = (k, def) => {
    const hit = args.find(a => a.startsWith(`--${k}=`));
    return hit ? hit.split('=')[1] : def;
};

const days = Number(arg('days', '0'));
const limit = Number(arg('limit', '0'));
const csvPath = arg('csv', '');
const SHIPPING_ITEM_NAME = 'Shipping Charge';

const getInvoice = (qbo, id) => new Promise((resolve) => {
    qbo.getInvoice(id, (err, body) =>
        err ? resolve({ err: String(err.message || err).slice(0, 200) }) : resolve({ inv: body }));
});

const isShippingLine = (line) =>
    line?.DetailType === 'SalesItemLineDetail' &&
    /^Shipping \(/i.test(String(line?.Description || ''));

const isProductLineMisMapped = (line) =>
    line?.DetailType === 'SalesItemLineDetail' &&
    !/^Shipping \(/i.test(String(line?.Description || '')) &&
    String(line?.SalesItemLineDetail?.ItemRef?.name || '') === 'Sales';

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    const filter = days > 0 ? { last_synced_at: { $gte: new Date(Date.now() - days * 86400000) } } : {};
    let query = JubelioOrderMap.find(filter)
        .select('salesorder_no qbo_invoice_id last_synced_at')
        .sort({ last_synced_at: -1 });
    if (limit > 0) query = query.limit(limit);
    const rows = await query.lean();

    const scope = days > 0 ? `last ${days}d` : 'ALL TIME';
    console.log(`\n=== Shipping ItemRef Audit (${scope}) ===`);
    console.log(`Scanning ${rows.length} JubelioOrderMap entries...\n`);

    const flagged = [];      // invoices with at least one mis-bucketed shipping line
    const okInvoices = [];   // invoices with shipping lines correctly mapped
    const noShipping = [];   // invoices without any shipping line
    const errors = [];
    const itemRefDist = new Map(); // diagnostic: distribution of ItemRef names found on shipping lines

    let processed = 0;
    for (const r of rows) {
        processed++;
        if (processed % 50 === 0) process.stdout.write(`\r  scanned ${processed}/${rows.length}...`);
        const { inv, err } = await getInvoice(qbo, r.qbo_invoice_id);
        if (err) {
            if (!/Object Not Found|6240|404/i.test(err)) {
                errors.push({ so: r.salesorder_no, inv: r.qbo_invoice_id, err });
            }
            continue;
        }
        const lines = Array.isArray(inv?.Line) ? inv.Line : [];
        const shipLines = lines.filter(isShippingLine);
        const badProductLines = lines.filter(isProductLineMisMapped);

        const badShipping = [];
        const goodShipping = [];
        for (const ln of shipLines) {
            const refName = ln?.SalesItemLineDetail?.ItemRef?.name || '(none)';
            const refValue = ln?.SalesItemLineDetail?.ItemRef?.value || '';
            itemRefDist.set(refName, (itemRefDist.get(refName) || 0) + 1);
            const entry = {
                lineId: ln.Id,
                amount: ln.Amount,
                description: ln.Description,
                itemRefName: refName,
                itemRefValue: refValue,
                kind: 'shipping',
            };
            if (refName === SHIPPING_ITEM_NAME) goodShipping.push(entry);
            else badShipping.push(entry);
        }
        const badProducts = badProductLines.map(ln => ({
            lineId: ln.Id,
            amount: ln.Amount,
            description: ln.Description,
            itemRefName: ln?.SalesItemLineDetail?.ItemRef?.name || '(none)',
            itemRefValue: ln?.SalesItemLineDetail?.ItemRef?.value || '',
            kind: 'product',
        }));

        if (badShipping.length === 0 && badProducts.length === 0) {
            if (shipLines.length === 0) noShipping.push({ so: r.salesorder_no, inv: r.qbo_invoice_id });
            else okInvoices.push({ so: r.salesorder_no, inv: r.qbo_invoice_id });
            continue;
        }
        flagged.push({
            so: r.salesorder_no,
            inv: r.qbo_invoice_id,
            txnDate: inv.TxnDate,
            docNumber: inv.DocNumber,
            syncToken: inv.SyncToken,
            badLines: [...badShipping, ...badProducts],
            goodLines: goodShipping,
        });
    }
    process.stdout.write('\r');

    console.log(`\nResults:`);
    console.log(`  Scanned invoices:           ${rows.length}`);
    console.log(`  No shipping line:           ${noShipping.length}`);
    console.log(`  Shipping correctly mapped:  ${okInvoices.length}`);
    console.log(`  ⚠️ Flagged (needs backfill): ${flagged.length}`);
    console.log(`  Errors:                     ${errors.length}`);

    if (itemRefDist.size > 0) {
        console.log(`\nItemRef distribution on shipping lines:`);
        const entries = [...itemRefDist.entries()].sort((a, b) => b[1] - a[1]);
        for (const [name, count] of entries) {
            const marker = name === SHIPPING_ITEM_NAME ? '✅' : '⚠️';
            console.log(`  ${marker} "${name}": ${count}`);
        }
    }

    const totalShipBad = flagged.reduce((s, f) => s + f.badLines.filter(b => b.kind === 'shipping').length, 0);
    const totalProdBad = flagged.reduce((s, f) => s + f.badLines.filter(b => b.kind === 'product').length, 0);
    console.log(`\nBad line breakdown:`);
    console.log(`  Shipping lines mis-bucketed: ${totalShipBad}`);
    console.log(`  Product lines mis-bucketed:  ${totalProdBad}`);

    if (flagged.length > 0) {
        console.log(`\nSample flagged invoices (first 20):`);
        for (const f of flagged.slice(0, 20)) {
            const summary = f.badLines
                .map(b => `${b.kind} line=${b.lineId} amt=${b.amount} ref="${b.itemRefName}" desc="${(b.description||'').slice(0,40)}"`)
                .join(' | ');
            console.log(`  ${f.so} inv=${f.inv} doc=${f.docNumber || '-'} date=${f.txnDate}: ${summary}`);
        }
        if (flagged.length > 20) console.log(`  ... and ${flagged.length - 20} more`);
    }

    if (errors.length > 0) {
        console.log(`\nErrors (first 10):`);
        for (const e of errors.slice(0, 10)) console.log(`  ${e.so} inv=${e.inv}: ${e.err}`);
    }

    if (csvPath && flagged.length > 0) {
        const header = 'salesorder_no,qbo_invoice_id,doc_number,txn_date,sync_token,kind,line_id,amount,current_item_ref_name,current_item_ref_value,description\n';
        const lines = [];
        for (const f of flagged) {
            for (const b of f.badLines) {
                const cols = [
                    f.so, f.inv, f.docNumber || '', f.txnDate || '', f.syncToken,
                    b.kind || '',
                    b.lineId, b.amount,
                    `"${(b.itemRefName || '').replace(/"/g, '""')}"`,
                    b.itemRefValue || '',
                    `"${(b.description || '').replace(/"/g, '""')}"`,
                ];
                lines.push(cols.join(','));
            }
        }
        fs.writeFileSync(csvPath, header + lines.join('\n') + '\n');
        console.log(`\nCSV written: ${csvPath} (${lines.length} rows)`);
    }

    await mongoose.disconnect();
    process.exit(0);
})().catch(e => {
    console.error('Audit failed:', e);
    process.exit(1);
});
