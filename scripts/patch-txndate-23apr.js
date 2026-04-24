// One-shot: fix TxnDate=2026-04-22 → 2026-04-23 on 4 Shopee invoices that
// were created before the timezone bug fix (commit 7f7756b).
// Runs sparse update so other fields (LinkedTxn, Lines, Memo, etc.) untouched.
require('dotenv').config();
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');

const TARGETS = [
    { id: '69483', expectedDoc: 'SP-260423HF6M9B5P' },
    { id: '69487', expectedDoc: 'SP-260423HE6MWESG' },
    { id: '69470', expectedDoc: 'SP-260423HAJVWVWN' },
    { id: '69486', expectedDoc: 'SP-260423H3UEQKFK' },
];
const NEW_TXN_DATE = '2026-04-23';

const getInvoice = (qbo, id) => new Promise((resolve, reject) => {
    qbo.getInvoice(id, (err, body) => err ? reject(err) : resolve(body));
});
const updateInvoice = (qbo, payload) => new Promise((resolve, reject) => {
    qbo.updateInvoice(payload, (err, body) => err ? reject(err) : resolve(body));
});

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    for (const t of TARGETS) {
        try {
            const inv = await getInvoice(qbo, t.id);
            if (inv.DocNumber !== t.expectedDoc) {
                console.log(`⚠️  ${t.id} DocNumber="${inv.DocNumber}" ≠ expected "${t.expectedDoc}" — skip`);
                continue;
            }
            if (inv.TxnDate === NEW_TXN_DATE) {
                console.log(`✓  ${t.id} (${t.expectedDoc}) already TxnDate=${NEW_TXN_DATE} — skip`);
                continue;
            }
            console.log(`→  ${t.id} (${t.expectedDoc}) ${inv.TxnDate} → ${NEW_TXN_DATE}`);
            const updated = await updateInvoice(qbo, {
                Id: t.id,
                SyncToken: inv.SyncToken,
                sparse: true,
                TxnDate: NEW_TXN_DATE,
            });
            console.log(`✅ ${t.id} updated. New TxnDate=${updated.TxnDate}, SyncToken=${updated.SyncToken}`);
        } catch (e) {
            console.error(`❌ ${t.id} failed: ${e.message || JSON.stringify(e).slice(0, 300)}`);
        }
    }
    console.log('\nDone.');
    await mongoose.disconnect();
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
