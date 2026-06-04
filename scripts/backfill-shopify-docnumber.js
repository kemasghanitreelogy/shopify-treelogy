// Backfill: remap Shopify invoice DocNumber SHF- → WA-/WX- for orders whose
// customer was already split (bf4c68b) but whose invoice number was created
// before the DocNumber remap (bc5cf0c) went live.
//
// Discovery is driven from the CUSTOMER side: any WA-/WX- prefixed customer
// whose invoice still carries an SHF- DocNumber is an inconsistency to fix.
// For each, the new DocNumber prefix is taken from the customer prefix AND
// independently re-confirmed against the detection API — if they disagree the
// row is SKIPPED and flagged (never guess). Linked Payment DocNumber is updated
// too so the QBO Sales transaction numbers stay consistent. JubelioOrderMap
// qbo_doc_number is synced.
//
// NOTE: QBO does NOT persist DocNumber on Payment (ReceivePayment) for this
// realm — the payment update below returns 200 but the value is dropped (the
// same reason the original auto-payment came out with an empty DocNumber). So
// the payment write is effectively a no-op; only the Invoice DocNumber carries
// the order number. Left in place as it is harmless and self-documents intent.
//
// SAFE BY DEFAULT: dry-run. Pass --apply to write. Every action is appended to
// a timestamped .jsonl audit log.
//
//   node scripts/backfill-shopify-docnumber.js            # dry-run
//   node scripts/backfill-shopify-docnumber.js --apply    # execute
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');
const JubelioOrderMap = require('../models/JubelioOrderMap');

const APPLY = process.argv.includes('--apply');
// Scope to the SHF→WA/WX customer split going live (commit bf4c68b, 2026-06-03).
// This restricts the backfill to the handful of orders created after the customer
// split but before the DocNumber remap — NOT historical WA/WX records.
const SINCE = '2026-06-03T06:00:00-00:00';
const DETECTION_API = (process.env.SHOPIFY_PAYMENT_API_URL || 'https://payment-shopify-detection.vercel.app').replace(/\/+$/, '');
const AUDIT = `backfill-shopify-docnumber-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
const audit = (rec) => fs.appendFileSync(AUDIT, JSON.stringify(rec) + '\n');

const QBO = {};
const qboUrl = (path) => `https://quickbooks.api.intuit.com/v3/company/${QBO.realmId}/${path}`;
const qGet = async (sql) => {
    const r = await fetch(`${qboUrl('query')}?query=${encodeURIComponent(sql)}&minorversion=65`,
        { headers: { Authorization: `Bearer ${QBO.token}`, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`query ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json())?.QueryResponse || {};
};
const qGetById = async (entity, id) => {
    const r = await fetch(`${qboUrl(entity + '/' + id)}?minorversion=65`,
        { headers: { Authorization: `Bearer ${QBO.token}`, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`${entity}/${id} ${r.status}`);
    return r.json();
};
const qPost = async (entity, body) => {
    const r = await fetch(`${qboUrl(entity)}?minorversion=65`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${QBO.token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${entity} update ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
};

const detect = async (orderNo) => {
    const r = await fetch(`${DETECTION_API}/api/orders/payment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: orderNo }), signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`detection HTTP ${r.status}`);
    const b = await r.json();
    return b.payment === 0 ? 'WA' : b.payment === 1 ? 'WX' : null;
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    QBO.realmId = qbo.realmId; QBO.token = qbo.token;

    console.log(`\n🔧 Backfill Shopify DocNumber SHF→WA/WX · mode=${APPLY ? 'APPLY' : 'DRY-RUN'} · audit=${AUDIT}\n`);

    // 1) Candidate customers: WA-/WX- prefixed.
    const custs = [];
    for (const pfx of ['WA -', 'WX -']) {
        const res = await qGet(`SELECT Id,DisplayName FROM Customer WHERE DisplayName LIKE '${pfx}%' AND MetaData.CreateTime > '${SINCE}' MAXRESULTS 1000`);
        custs.push(...(res.Customer || []).map(c => ({ id: c.Id, name: c.DisplayName, prefix: pfx.slice(0, 2) })));
    }

    let scanned = 0, toFix = 0, fixed = 0, skipped = 0, errors = 0;
    for (const c of custs) {
        const inv = await qGet(`SELECT Id,DocNumber,SyncToken,LinkedTxn FROM Invoice WHERE CustomerRef = '${c.id}'`);
        for (const i of (inv.Invoice || [])) {
            scanned++;
            const oldDoc = i.DocNumber || '';
            const m = oldDoc.match(/^SHF-(\d+)-(.+)$/);
            if (!m) continue; // already WA/WX or not a Shopify doc
            toFix++;
            const orderNo = m[1];
            const newDoc = `${c.prefix}-${orderNo}-${m[2]}`;

            // Cross-confirm with detection API; must agree with the customer prefix.
            let detected = null;
            try { detected = await detect(orderNo); } catch (e) { detected = `ERR:${e.message}`; }
            if (detected !== c.prefix) {
                skipped++;
                const why = `customer prefix ${c.prefix} != detection ${detected} for #${orderNo}`;
                console.log(`  ⏭️  SKIP inv ${i.Id} ${oldDoc} → (${why})`);
                audit({ ts: new Date().toISOString(), action: 'skip', invoiceId: i.Id, oldDoc, customer: c.name, why });
                continue;
            }

            // Linked payment(s): found via the invoice LinkedTxn (their DocNumber
            // is empty so they can't be queried by DocNumber). New orders set the
            // payment DocNumber = invoice DocNumber, so backfill these to match.
            const payIds = (i.LinkedTxn || []).filter(t => t.TxnType === 'Payment').map(t => String(t.TxnId));
            const payments = [];
            for (const pid of payIds) {
                try { const pj = await qGetById('payment', pid); if (pj.Payment) payments.push(pj.Payment); } catch { /* ignore */ }
            }

            const payStr = payments.length ? payments.map(p => `${p.Id}(${p.DocNumber || 'empty'}→${newDoc})`).join(',') : '(none)';
            console.log(`  ${APPLY ? '🔧' : '🔎'} inv ${i.Id} cust "${c.name}"  ${oldDoc} → ${newDoc}  | payment ${payStr}`);

            if (!APPLY) {
                audit({ ts: new Date().toISOString(), action: 'plan', invoiceId: i.Id, oldDoc, newDoc, paymentIds: payIds, customer: c.name });
                continue;
            }

            try {
                await qPost('invoice', { Id: i.Id, SyncToken: i.SyncToken, sparse: true, DocNumber: newDoc });
                for (const p of payments) await qPost('payment', { Id: p.Id, SyncToken: p.SyncToken, sparse: true, DocNumber: newDoc });
                await JubelioOrderMap.updateMany({ qbo_doc_number: oldDoc }, { qbo_doc_number: newDoc });
                fixed++;
                console.log(`     ✅ done (invoice + ${payments.length} payment)`);
                audit({ ts: new Date().toISOString(), action: 'apply', invoiceId: i.Id, oldDoc, newDoc, paymentIds: payments.map(p => p.Id), customer: c.name });
            } catch (e) {
                errors++;
                console.log(`     ❌ ${e.message}`);
                audit({ ts: new Date().toISOString(), action: 'error', invoiceId: i.Id, oldDoc, newDoc, error: e.message });
            }
        }
    }

    console.log(`\n━━━ SUMMARY (${APPLY ? 'APPLY' : 'DRY-RUN'}) ━━━`);
    console.log(`  customers scanned : ${custs.length}`);
    console.log(`  invoices scanned  : ${scanned}`);
    console.log(`  need remap (SHF-) : ${toFix}`);
    console.log(`  ${APPLY ? 'fixed' : 'would fix'}        : ${APPLY ? fixed : toFix - skipped}`);
    console.log(`  skipped (mismatch): ${skipped}`);
    if (APPLY) console.log(`  errors            : ${errors}`);
    console.log(`  audit log         : ${AUDIT}`);

    await mongoose.disconnect();
    process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
