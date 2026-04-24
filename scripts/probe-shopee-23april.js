// One-shot probe: which of these SO codes have a JubelioOrderMap entry (= synced to QBO)?
require('dotenv').config();
const mongoose = require('mongoose');
const JubelioOrderMap = require('../models/JubelioOrderMap');

const CODES = [
    'SP-260423JBC4WVSC','SP-260423J7NBGSPS','SP-260423J6FK7C6S','SP-260423J1JGFBQM',
    'SP-260423HTBAR92X','SP-260423HPKMSN7F','SP-260423HPAHYYQN','SP-260423HNHX7PBM',
    'SP-260423HNAY12ST','SP-260423HMXEGPXE','SP-260423HJ45THJA','SP-260423HHS13XDP',
    'SP-260423HF6M9B5P','SP-260423HE6MWESG','SP-260423HAJVWVWN','SP-260423H3UEQKFK',
];

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const rows = await JubelioOrderMap.find({ salesorder_no: { $in: CODES } })
        .select('salesorder_no salesorder_id qbo_invoice_id qbo_doc_number last_status last_grand_total last_synced_at qbo_realm_id')
        .lean();
    const found = new Map(rows.map(r => [r.salesorder_no, r]));
    console.log(`MAPPED: ${rows.length}/${CODES.length}\n`);
    for (const code of CODES) {
        const r = found.get(code);
        if (r) {
            console.log(`✅ ${code}  inv=${r.qbo_invoice_id}  doc=${r.qbo_doc_number || '-'}  status=${r.last_status || '-'}  total=${r.last_grand_total || '-'}  realm=${r.qbo_realm_id}  synced=${r.last_synced_at?.toISOString?.() || '-'}`);
        } else {
            console.log(`❌ ${code}  (no JubelioOrderMap entry — sync never succeeded)`);
        }
    }
    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
