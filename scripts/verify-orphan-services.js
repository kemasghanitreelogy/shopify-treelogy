// Verify that the 11 legacy Service items (41-44, 49-55) are no longer
// referenced by any QBO invoice line. After sync-jubelio-to-integrated.js
// runs to completion, all references should have moved to [Integrated]
// canonical items, leaving these Service items orphan and safe to inactivate.
//
// Read-only. Counts per Service id, lists remaining invoices.
//
// Usage: node scripts/verify-orphan-services.js

require('dotenv').config();
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const { getQboInstance } = require('../services/qboService');

const TARGET_IDS = ['41', '42', '43', '44', '49', '50', '51', '52', '53', '54', '55'];

const qboBaseUrl = (qbo) => `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
const qboFetch = async (qbo, p) => {
    const url = `${qboBaseUrl(qbo)}${p}${p.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' } });
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(`QBO ${p} (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
    return body;
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    console.log(`🔍 Verifying orphan state of 11 legacy Service items: ${TARGET_IDS.join(', ')}\n`);

    // Get item metadata (so we can show name + type per id)
    const itemMeta = {};
    for (const id of TARGET_IDS) {
        try {
            const body = await qboFetch(qbo, `/item/${id}`);
            const it = body?.Item;
            if (it) itemMeta[id] = { name: it.Name, type: it.Type, sku: it.Sku, active: it.Active };
        } catch (e) { itemMeta[id] = { error: e.message }; }
    }

    const maps = await JubelioOrderMap.find({ qbo_invoice_id: { $exists: true, $ne: null } }).lean();
    console.log(`Scanning ${maps.length} Jubelio invoices…\n`);

    const refsByItemId = Object.fromEntries(TARGET_IDS.map(id => [id, []]));  // id → [invoice]

    let processed = 0;
    for (const m of maps) {
        processed++;
        if (processed % 50 === 0) process.stdout.write(`\r  scanned ${processed}/${maps.length}…`);
        try {
            const body = await qboFetch(qbo, `/invoice/${m.qbo_invoice_id}`);
            const inv = body?.Invoice;
            if (!inv) continue;
            for (const l of inv.Line || []) {
                if (l.DetailType !== 'SalesItemLineDetail') continue;
                const refId = String(l.SalesItemLineDetail?.ItemRef?.value || '');
                if (TARGET_IDS.includes(refId)) {
                    refsByItemId[refId].push({
                        sn: m.salesorder_no,
                        invoiceId: inv.Id,
                        docNumber: inv.DocNumber,
                        amount: l.Amount,
                        desc: (l.Description || '').slice(0, 60),
                    });
                }
            }
        } catch (e) {
            // skip individual errors silently to keep verification readable
        }
    }
    process.stdout.write('\r' + ' '.repeat(60) + '\r');

    console.log('\n📊 Reference count per legacy Service item:\n');
    let totalRefs = 0;
    for (const id of TARGET_IDS) {
        const meta = itemMeta[id] || {};
        const refs = refsByItemId[id];
        totalRefs += refs.length;
        const tag = refs.length === 0 ? '✅ ORPHAN' : '⚠️  ' + refs.length + ' line(s)';
        console.log(`  id=${id} (${meta.type || '?'} active=${meta.active} sku="${meta.sku || '∅'}" "${(meta.name || '').slice(0, 40)}")  →  ${tag}`);
    }

    if (totalRefs === 0) {
        console.log('\n🎉 All 11 Service items are ORPHAN — safe to inactivate (Phase 5).');
    } else {
        console.log(`\n⚠️  ${totalRefs} line(s) still reference legacy Service items. Detail:\n`);
        for (const id of TARGET_IDS) {
            const refs = refsByItemId[id];
            if (refs.length === 0) continue;
            console.log(`\n── id=${id} (${refs.length} ref):`);
            for (const r of refs.slice(0, 30)) {
                console.log(`  • ${r.sn} (qbo id=${r.invoiceId}, doc=${r.docNumber}) amt=Rp ${(r.amount || 0).toLocaleString('id-ID')}  desc="${r.desc}"`);
            }
            if (refs.length > 30) console.log(`  …and ${refs.length - 30} more`);
        }
    }

    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e); try { await mongoose.disconnect(); } catch {} process.exit(1); });
