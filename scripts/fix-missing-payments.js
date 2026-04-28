// One-time fix for invoices that should have payments but don't.
// Walks JubelioOrderMap entries where last_status is PAID/COMPLETED, fetches
// the QBO Invoice, and creates a Payment if Balance > 0 and no Payment is
// linked yet. Uses the same logic as the webhook's markQboInvoicePaid.

require('dotenv').config();
const mongoose = require('mongoose');
const QboService = require('../services/qboService');
const JubelioOrderMap = require('../models/JubelioOrderMap');

const TZ_OFFSET_MS = (Number(process.env.JUBELIO_TZ_OFFSET_HOURS) || 8) * 60 * 60 * 1000;
const isoDate = (raw) => {
    if (!raw) return null;
    const d = new Date(String(raw).trim());
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() + TZ_OFFSET_MS).toISOString().substring(0, 10);
};

const PAID_STATUSES = new Set(['PAID', 'COMPLETED']);
const APPLY = process.argv.includes('--apply');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    const qbo = await QboService.getQboInstance();
    const baseUrl = qbo.useSandbox ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com';
    const realmId = String(qbo.realmId);

    const fetchQbo = async (path, opts = {}) => {
        const url = `${baseUrl}/v3/company/${realmId}${path}${path.includes('?') ? '&' : '?'}minorversion=65`;
        const r = await fetch(url, {
            ...opts,
            headers: {
                Authorization: 'Bearer ' + qbo.token,
                Accept: 'application/json',
                'Content-Type': 'application/json',
                ...(opts.headers || {}),
            },
        });
        const text = await r.text();
        let body; try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
        return { ok: r.ok, status: r.status, body };
    };

    const maps = await JubelioOrderMap.find({
        qbo_realm_id: realmId,
        last_status: { $in: [...PAID_STATUSES] },
    }).lean();
    console.log(`Scanning ${maps.length} PAID/COMPLETED order maps...`);

    // Pre-build payment-by-invoice index
    const paymentsByInvoice = new Map();
    for (let s = 1; s < 30000; s += 200) {
        const r = await fetchQbo(`/query?query=${encodeURIComponent(`SELECT * FROM Payment STARTPOSITION ${s} MAXRESULTS 200`)}`);
        const list = r.body?.QueryResponse?.Payment || [];
        if (list.length === 0) break;
        for (const p of list) {
            for (const l of p.Line || []) {
                for (const t of l.LinkedTxn || []) {
                    if (t.TxnType === 'Invoice') {
                        const k = String(t.TxnId);
                        if (!paymentsByInvoice.has(k)) paymentsByInvoice.set(k, []);
                        paymentsByInvoice.get(k).push(p);
                    }
                }
            }
        }
        if (list.length < 200) break;
    }
    console.log(`  Indexed ${paymentsByInvoice.size} invoice→payment links`);

    let candidates = 0, fixed = 0, skipped = 0, errors = 0;
    for (const m of maps) {
        if (paymentsByInvoice.has(String(m.qbo_invoice_id))) {
            skipped++;
            continue;
        }
        const invR = await fetchQbo(`/invoice/${m.qbo_invoice_id}`);
        if (!invR.ok) { errors++; continue; }
        const inv = invR.body?.Invoice;
        if (!inv) { errors++; continue; }
        if (inv.Voided === true) { skipped++; continue; }
        const balance = Number(inv.Balance || 0);
        if (balance <= 0.01) { skipped++; continue; } // already paid
        candidates++;

        const dateRaw = m.last_payment_date_raw || m.last_transaction_date_raw;
        const txnDate = dateRaw ? isoDate(dateRaw) : inv.TxnDate;
        const customerId = inv.CustomerRef?.value;
        const docNumber = (inv.DocNumber || m.qbo_doc_number || '').substring(0, 21) || undefined;

        const payload = {
            CustomerRef: { value: String(customerId) },
            TotalAmt: balance,
            TxnDate: txnDate,
            DocNumber: docNumber,
            PrivateNote: `Auto-paid from Jubelio SO #${m.salesorder_no} status=${m.last_status} (recovered)`,
            Line: [{
                Amount: balance,
                LinkedTxn: [{ TxnId: String(inv.Id), TxnType: 'Invoice' }],
            }],
        };

        if (APPLY) {
            const r = await fetchQbo('/payment', { method: 'POST', body: JSON.stringify(payload) });
            if (r.ok) {
                const newP = r.body?.Payment;
                console.log(`  ✅ ${m.salesorder_no} inv=${inv.Id}: created Payment ${newP?.Id} amount=${balance}`);
                fixed++;
            } else {
                console.log(`  ❌ ${m.salesorder_no} inv=${inv.Id}: ${JSON.stringify(r.body).slice(0, 300)}`);
                errors++;
            }
        } else {
            console.log(`  📝 ${m.salesorder_no} inv=${inv.Id} cust=${customerId} amount=${balance} date=${txnDate} (would create Payment)`);
        }
    }

    console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN'}: candidates=${candidates} fixed=${fixed} skipped=${skipped} errors=${errors}`);
    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
