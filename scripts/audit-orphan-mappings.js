// Audit QBO invoices that look like Jubelio integration invoices but have no
// JubelioOrderMap entry (mapping orphan).
//
// Why this exists (R4):
//   The /pesanan handler creates the QBO Invoice first, then writes
//   JubelioOrderMap (jubelioWebhook.js:1241 / 1611). If the Lambda times out
//   between those two steps, QBO has the invoice but Mongo doesn't have the
//   mapping. Self-heal exists (commit 1ac1388) — when the next webhook fires,
//   QBO returns "Duplicate Document Number" and we recover by looking up the
//   invoice and rebuilding the mapping. But that recovery only fires if a
//   second webhook comes in. Quiet orders just stay orphaned forever.
//
//   This script finds those orphans by scanning QBO invoices with channel
//   prefixes (TP/SP/SHF/LB/CS/DP/DW/WS) and listing those that have no
//   matching JubelioOrderMap entry. Output is a list for manual review or a
//   future backfill script.
//
// Read-only. QBO GET only. No writes.
//
// Usage:
//   node scripts/audit-orphan-mappings.js
//   node scripts/audit-orphan-mappings.js --days=60       # narrow scan window
//   node scripts/audit-orphan-mappings.js --csv=out.csv

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const { getQboInstance } = require('../services/qboService');

const CHANNEL_PREFIXES = ['SHF-', 'SP-', 'TP-', 'TT-', 'LB-', 'CS-', 'DP-', 'DW-', 'WS-'];

const args = process.argv.slice(2);
const arg = (k, def) => {
    const hit = args.find(a => a.startsWith(`--${k}=`));
    return hit ? hit.split('=')[1] : def;
};

const days = Number(arg('days', '0'));
const csvPath = arg('csv', '');

const PAGE = 200;
const MAX_PAGES = 100;

const qboBaseUrl = (qbo) => `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
const qboFetch = async (qbo, p) => {
    const url = `${qboBaseUrl(qbo)}${p}${p.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' } });
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(`QBO GET ${p} (${res.status}): ${JSON.stringify(body).slice(0, 600)}`);
    return body;
};

const matchesChannelPrefix = (doc) => CHANNEL_PREFIXES.some(p => String(doc || '').startsWith(p));

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    const dateFilter = days > 0 ? ` WHERE TxnDate >= '${new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)}'` : '';
    const scope = days > 0 ? `last ${days}d` : 'ALL TIME';
    console.log(`\n=== Orphan Mapping Audit (${scope}) ===`);
    console.log(`Strategy: scan QBO invoices with channel prefix, cross-check JubelioOrderMap.\n`);

    // 1. Scan QBO invoices
    const invoices = [];
    let startPos = 1;
    for (let page = 0; page < MAX_PAGES; page++) {
        const q = `SELECT Id, DocNumber, TxnDate, TotalAmt, CustomerRef, PrivateNote FROM Invoice${dateFilter} STARTPOSITION ${startPos} MAXRESULTS ${PAGE}`;
        const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const batch = body?.QueryResponse?.Invoice || [];
        if (!batch.length) break;
        invoices.push(...batch);
        process.stdout.write(`\r  scanned ${invoices.length} invoices...`);
        if (batch.length < PAGE) break;
        startPos += PAGE;
    }
    process.stdout.write('\r');
    console.log(`Fetched ${invoices.length} QBO invoices total`);

    if (invoices.length >= MAX_PAGES * PAGE) {
        console.warn(`⚠️  Hit MAX_PAGES * PAGE = ${MAX_PAGES * PAGE} cap. Re-run with --days to narrow scope.`);
    }

    const channelInvoices = invoices.filter(i => matchesChannelPrefix(i.DocNumber));
    console.log(`Channel-prefixed: ${channelInvoices.length}`);

    // 2. Bulk-load all mappings into a Set for O(1) lookup
    const mapDocs = await JubelioOrderMap.find({}).select('qbo_invoice_id salesorder_no').lean();
    const mappedInvoiceIds = new Set(mapDocs.map(m => String(m.qbo_invoice_id)));
    const mappedSalesOrderNos = new Set(mapDocs.map(m => String(m.salesorder_no || '')).filter(Boolean));
    console.log(`JubelioOrderMap entries: ${mapDocs.length} (${mappedInvoiceIds.size} unique invoice ids)\n`);

    // 3. Find orphans
    const orphans = [];
    const docNumberCollisions = []; // SO# in mapping but pointing at a different invoice id
    for (const inv of channelInvoices) {
        const id = String(inv.Id);
        if (mappedInvoiceIds.has(id)) continue;

        // Check whether DocNumber matches any mapped salesorder_no — that's the
        // self-heal trigger pattern (mapping points at a different / stale invoice).
        const docCollides = mappedSalesOrderNos.has(String(inv.DocNumber || ''));

        const orphan = {
            qboInvoiceId: id,
            docNumber: inv.DocNumber,
            txnDate: inv.TxnDate,
            totalAmt: inv.TotalAmt,
            customerRef: inv.CustomerRef?.value,
            customerName: inv.CustomerRef?.name,
            privateNote: (inv.PrivateNote || '').slice(0, 100),
            docNumberInMapping: docCollides,
        };
        if (docCollides) docNumberCollisions.push(orphan);
        else orphans.push(orphan);
    }

    console.log(`Results:`);
    console.log(`  Channel-prefixed invoices in QBO:           ${channelInvoices.length}`);
    console.log(`  ✅ Mapped (have JubelioOrderMap entry):      ${channelInvoices.length - orphans.length - docNumberCollisions.length}`);
    console.log(`  🛑 ORPHAN (no map, DocNumber not in any map): ${orphans.length}`);
    console.log(`  ⚠️  COLLISION (no map, but DocNumber matches another mapping's SO#): ${docNumberCollisions.length}`);

    if (orphans.length > 0) {
        console.log(`\nOrphan invoices (first 30 — most recent first):`);
        const sorted = orphans.sort((a, b) => String(b.txnDate || '').localeCompare(String(a.txnDate || '')));
        for (const o of sorted.slice(0, 30)) {
            console.log(`  ${o.txnDate || '?'}  qbo=${o.qboInvoiceId}  doc=${o.docNumber}  cust=${o.customerName || o.customerRef}  total=${o.totalAmt}`);
        }
        if (orphans.length > 30) console.log(`  ... and ${orphans.length - 30} more`);
    }

    if (docNumberCollisions.length > 0) {
        console.log(`\nCollisions — likely duplicate-DocNumber recoveries that succeeded but left orphan invoice in QBO:`);
        for (const o of docNumberCollisions.slice(0, 30)) {
            console.log(`  ${o.txnDate || '?'}  qbo=${o.qboInvoiceId}  doc=${o.docNumber}  cust=${o.customerName}  note="${o.privateNote}"`);
        }
        if (docNumberCollisions.length > 30) console.log(`  ... and ${docNumberCollisions.length - 30} more`);
    }

    if (csvPath) {
        const header = 'category,qbo_invoice_id,doc_number,txn_date,total_amt,customer_id,customer_name,private_note\n';
        const all = [
            ...orphans.map(o => ({ ...o, category: 'ORPHAN' })),
            ...docNumberCollisions.map(o => ({ ...o, category: 'COLLISION' })),
        ];
        const lines = all.map(o => [
            o.category,
            o.qboInvoiceId,
            o.docNumber || '',
            o.txnDate || '',
            o.totalAmt || '',
            o.customerRef || '',
            `"${(o.customerName || '').replace(/"/g, '""')}"`,
            `"${(o.privateNote || '').replace(/"/g, '""')}"`,
        ].join(','));
        fs.writeFileSync(csvPath, header + lines.join('\n') + '\n');
        console.log(`\nCSV written: ${csvPath} (${lines.length} rows)`);
    }

    if (orphans.length === 0 && docNumberCollisions.length === 0) {
        console.log(`\n✅ No mapping orphans. Self-heal recovery is keeping things consistent.`);
    } else {
        console.log(`\n💡 Decision input: ${orphans.length + docNumberCollisions.length} invoices need review.`);
        console.log(`   These can be back-filled into JubelioOrderMap by parsing PrivateNote ("Jubelio SO #...")`);
        console.log(`   and matching against JubelioPayloadLog. That's a separate Sprint C backfill.`);
    }

    await mongoose.disconnect();
    process.exit(0);
})().catch(e => {
    console.error('Audit failed:', e);
    process.exit(1);
});
