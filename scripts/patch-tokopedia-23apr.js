// One-shot fix for 3 Tokopedia invoices from 23 April 2026 that landed in
// QBO with TxnDate=22 April due to the timezone bug. User confirmed correct
// date via Jubelio dashboard.
require('dotenv').config();
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');

const TARGETS = [
    { id: '69508', expectedDoc: 'TP-583653738189850082-128884' },
    { id: '69511', expectedDoc: 'TP-583653041495180373-128884' },
    { id: '69514', expectedDoc: 'TP-583651852478023659-128884' },
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
            // QBO DocNumber max 21 chars truncates -128884 channel suffix.
            if (!t.expectedDoc.startsWith(inv.DocNumber)) {
                console.log(`⚠️  ${t.id} DocNumber="${inv.DocNumber}" doesn't prefix "${t.expectedDoc}" — skip`);
                continue;
            }
            if (inv.TxnDate === NEW_TXN_DATE) {
                console.log(`✓  ${t.id} (${t.expectedDoc}) already TxnDate=${NEW_TXN_DATE} — skip`);
                continue;
            }
            console.log(`→  ${t.id} (${t.expectedDoc}) ${inv.TxnDate} → ${NEW_TXN_DATE}`);
            const updated = await updateInvoice(qbo, {
                Id: t.id, SyncToken: inv.SyncToken, sparse: true, TxnDate: NEW_TXN_DATE,
            });
            console.log(`✅ ${t.id} updated. New TxnDate=${updated.TxnDate}`);
        } catch (e) {
            console.error(`❌ ${t.id} failed: ${e.message || JSON.stringify(e).slice(0, 300)}`);
        }
    }
    console.log('\nDone.');
    await mongoose.disconnect();
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
