// Fix legacy invoices whose linked QBO Customer doesn't carry the SO's
// channel prefix. Per policy (commit d11a929, 2026-05-05): every customer
// used for an SO MUST carry that channel's prefix in DisplayName. Cross-
// channel reuse and unprefixed-fallback are forbidden — always create a
// fresh `${channelPrefix} - ${name}` record if one doesn't already exist.
//
// This script handles the residual gap-window invoices: those created
// BEFORE the strict policy deploy whose customer never got reassigned.
//
// Logic per invoice:
//   1. Fetch QBO Invoice + current Customer
//   2. Determine SO channel prefix from invoice DocNumber / map salesorder_no
//   3. Skip if current customer name already has matching prefix
//   4. Compute target name: `${prefix} - ${stripPrefix(currentName)}`
//   5. Look up existing QBO Customer with target name (active or inactive)
//   6. If found → reuse Id; if not → create new (copy email/phone/addrs)
//   7. Sparse update invoice's CustomerRef
//   8. Find Payments linked to invoice (or to old customer with matching SO# in
//      PrivateNote) → reassign their CustomerRef to the new customer AND
//      preserve LinkedTxn so the invoice stays paid.
//
// Why step 8 matters: when an invoice's CustomerRef changes, QBO automatically
// unlinks any Payment whose CustomerRef no longer matches. Without this step,
// an invoice that was Paid before the reassignment ends up with full Balance.
//
// Apply guarded by --apply --i-understand, dry-run otherwise.
//
// Usage:
//   node scripts/fix-customer-prefix-on-invoice.js --so DP-5WHDR...
//   node scripts/fix-customer-prefix-on-invoice.js --so DP-5WHDR... --apply --i-understand

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');
const JubelioOrderMap = require('../models/JubelioOrderMap');

const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const val = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : null; };

const APPLY = flag('apply');
const I_UNDERSTAND = flag('i-understand');
const SO = val('so');
const INV_ID = val('inv');

if (!SO && !INV_ID) {
    console.error('❌ Need --so <salesorder_no> or --inv <invoice_id>');
    process.exit(2);
}
if (APPLY && !I_UNDERSTAND) {
    console.error('❌ --apply requires --i-understand (rewrites invoice CustomerRef)');
    process.exit(2);
}

const KNOWN_PREFIXES = ['SP', 'TP', 'TT', 'SHF', 'LB', 'CS', 'DP', 'DW', 'WS', 'WX', 'WA', 'D'];
const STRIP_RE = new RegExp(`^\\s*(${KNOWN_PREFIXES.join('|')})\\s*-\\s*`, 'i');
const stripPrefix = (name) => String(name || '').replace(STRIP_RE, '').trim();
const PREFIX_CANONICAL = { TT: 'TP' };
const channelPrefixOf = (soNo) => {
    const raw = String(soNo || '').match(/^([A-Z]{2,5})-/)?.[1] || null;
    if (!raw || !KNOWN_PREFIXES.includes(raw)) return null;
    return PREFIX_CANONICAL[raw] || raw;
};
const hasMatchingPrefix = (name, expected) => {
    if (!expected) return true;
    const m = String(name || '').match(/^\s*([A-Z]{2,5})\s*-/i);
    if (!m) return false;
    const actual = (PREFIX_CANONICAL[m[1].toUpperCase()] || m[1].toUpperCase());
    return actual === expected;
};

const getInvoice = (qbo, id) => new Promise((res, rej) =>
    qbo.getInvoice(id, (e, b) => e ? rej(new Error(`getInvoice ${id}: ${e.message || e}`)) : res(b))
);
const getCustomer = (qbo, id) => new Promise((res) =>
    qbo.getCustomer(String(id), (e, b) => e ? res(null) : res(b))
);
const findCustomerByName = (qbo, name) => new Promise((res) => {
    qbo.findCustomers([{ field: 'DisplayName', value: name, operator: '=' }], (e, b) => {
        if (e) return res([]);
        res(b?.QueryResponse?.Customer || []);
    });
});
const createCustomer = (qbo, payload) => new Promise((res, rej) =>
    qbo.createCustomer(payload, (e, b) => e ? rej(new Error(`createCustomer: ${e.message || e}`)) : res(b))
);
const updateInvoice = (qbo, payload) => new Promise((res, rej) =>
    qbo.updateInvoice(payload, (e, b) => e ? rej(new Error(`updateInvoice: ${e.message || e}`)) : res(b))
);
const findPaymentsByCustomerAndSo = (qbo, customerId, soNo) => new Promise((res) => {
    qbo.findPayments([{ field: 'CustomerRef', value: String(customerId), operator: '=' }], (e, b) => {
        if (e) return res([]);
        const all = b?.QueryResponse?.Payment || [];
        // Filter to payments whose PrivateNote references this SO number
        res(all.filter((p) => String(p.PrivateNote || '').includes(soNo)));
    });
});
const updatePayment = (qbo, payload) => new Promise((res, rej) =>
    qbo.updatePayment(payload, (e, b) => e ? rej(new Error(`updatePayment: ${e.message || e}`)) : res(b))
);
const getPayment = (qbo, id) => new Promise((res, rej) =>
    qbo.getPayment(String(id), (e, b) => e ? rej(new Error(`getPayment ${id}: ${e.message || e}`)) : res(b))
);

const auditPath = path.join(
    process.cwd(),
    'audit-logs',
    `fix-customer-prefix-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`,
);
fs.mkdirSync(path.dirname(auditPath), { recursive: true });
const auditStream = fs.createWriteStream(auditPath, { flags: 'a' });
const audit = (rec) => auditStream.write(JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n');

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    let invoiceId, soNo;
    if (SO) {
        const m = await JubelioOrderMap.findOne({ salesorder_no: SO }).lean();
        if (!m) throw new Error(`No JubelioOrderMap entry for SO ${SO}`);
        if (!m.qbo_invoice_id) throw new Error(`Map for ${SO} has no qbo_invoice_id`);
        invoiceId = m.qbo_invoice_id;
        soNo = m.salesorder_no;
    } else {
        invoiceId = INV_ID;
        const m = await JubelioOrderMap.findOne({ qbo_invoice_id: invoiceId }).lean();
        soNo = m?.salesorder_no;
    }

    const inv = await getInvoice(qbo, invoiceId);
    const docNumber = inv.DocNumber || soNo;
    const channelPrefix = channelPrefixOf(docNumber);
    if (!channelPrefix) {
        console.error(`❌ Cannot derive channel prefix from DocNumber=${docNumber}`);
        process.exit(2);
    }

    const currentCustomerId = inv.CustomerRef?.value;
    const currentCustomerName = inv.CustomerRef?.name || (await getCustomer(qbo, currentCustomerId))?.DisplayName;

    console.log(`🔍 Invoice ${invoiceId} (${docNumber})`);
    console.log(`   current customer: id=${currentCustomerId} name="${currentCustomerName}"`);
    console.log(`   channel prefix:   ${channelPrefix}`);

    if (hasMatchingPrefix(currentCustomerName, channelPrefix)) {
        console.log(`✅ Already has matching prefix — nothing to fix.`);
        audit({ event: 'skip_already_correct', invoiceId, soNo, currentCustomerName, channelPrefix });
        await mongoose.disconnect();
        auditStream.end();
        process.exit(0);
    }

    const targetName = `${channelPrefix} - ${stripPrefix(currentCustomerName)}`.substring(0, 100);
    console.log(`   target name:      "${targetName}"`);

    // Look for existing customer with target name (active or inactive)
    const existing = await findCustomerByName(qbo, targetName);
    let targetCustomer = existing.find((c) => c.Active !== false) || existing[0] || null;

    audit({
        event: 'plan',
        dryRun: !APPLY,
        invoiceId,
        soNo,
        currentCustomerId,
        currentCustomerName,
        channelPrefix,
        targetName,
        existingTargetCustomerId: targetCustomer?.Id || null,
        existingTargetActive: targetCustomer?.Active,
    });

    if (!APPLY) {
        if (targetCustomer) {
            console.log(`   plan: REUSE existing "${targetName}" (id=${targetCustomer.Id}, active=${targetCustomer.Active !== false})`);
        } else {
            console.log(`   plan: CREATE new customer "${targetName}" (copy info from current)`);
        }
        console.log(`   plan: SPARSE update invoice ${invoiceId} CustomerRef.value=${targetCustomer?.Id || '<new>'}`);
        console.log(`\nℹ️  Dry-run only. Re-run with --apply --i-understand to execute.`);
        await mongoose.disconnect();
        auditStream.end();
        process.exit(0);
    }

    // APPLY ────────────────────────────────────────────────────────────
    if (!targetCustomer) {
        // Copy email/phone/addrs from current customer record
        const cur = await getCustomer(qbo, currentCustomerId);
        const payload = {
            DisplayName: targetName,
            GivenName: targetName.split(' ')[0] || channelPrefix,
            FamilyName: targetName.split(' ').slice(1).join(' ') || 'Customer',
        };
        if (cur?.PrimaryEmailAddr?.Address) payload.PrimaryEmailAddr = { Address: cur.PrimaryEmailAddr.Address };
        if (cur?.PrimaryPhone?.FreeFormNumber) payload.PrimaryPhone = { FreeFormNumber: cur.PrimaryPhone.FreeFormNumber };
        if (cur?.BillAddr) payload.BillAddr = cur.BillAddr;
        if (cur?.ShipAddr) payload.ShipAddr = cur.ShipAddr;
        // Fallback to invoice's BillAddr/ShipAddr when current customer record lacks them
        if (!payload.BillAddr && inv.BillAddr) payload.BillAddr = inv.BillAddr;
        if (!payload.ShipAddr && inv.ShipAddr) payload.ShipAddr = inv.ShipAddr;
        targetCustomer = await createCustomer(qbo, payload);
        console.log(`✅ Created new customer "${targetName}" id=${targetCustomer.Id}`);
        audit({ event: 'created', customerId: targetCustomer.Id, name: targetName });
    } else {
        console.log(`✅ Reusing existing "${targetName}" id=${targetCustomer.Id}`);
        audit({ event: 'reused', customerId: targetCustomer.Id, name: targetName });
    }

    // Sparse update invoice CustomerRef
    const updated = await updateInvoice(qbo, {
        Id: invoiceId,
        SyncToken: inv.SyncToken,
        sparse: true,
        CustomerRef: { value: String(targetCustomer.Id) },
    });
    console.log(`✅ Invoice ${invoiceId} CustomerRef → id=${targetCustomer.Id} ("${targetName}")`);
    audit({
        event: 'reassigned',
        invoiceId,
        fromCustomerId: currentCustomerId,
        fromCustomerName: currentCustomerName,
        toCustomerId: targetCustomer.Id,
        toCustomerName: targetName,
        invoiceSyncTokenAfter: updated?.SyncToken,
    });

    // Step 8: reassign any Payment that referenced this SO under the old
    // customer. QBO auto-unlinks Payments when CustomerRef changes — we
    // restore the link by full-fetching, swapping CustomerRef, and writing
    // back the LinkedTxn array. This requires NON-sparse update because
    // sparse Line[]/LinkedTxn updates are not honored by the QBO Payment API.
    if (soNo) {
        const orphanedPayments = await findPaymentsByCustomerAndSo(qbo, currentCustomerId, soNo);
        if (orphanedPayments.length > 0) {
            console.log(`🔗 Found ${orphanedPayments.length} Payment(s) on old customer referencing ${soNo} — reassigning`);
            for (const p of orphanedPayments) {
                const fresh = await getPayment(qbo, p.Id);
                const payPayload = {
                    ...fresh,
                    CustomerRef: { value: String(targetCustomer.Id) },
                    Line: [{
                        Amount: fresh.TotalAmt,
                        LinkedTxn: [{ TxnId: String(invoiceId), TxnType: 'Invoice' }],
                    }],
                };
                delete payPayload.sparse;
                const upd = await updatePayment(qbo, payPayload);
                console.log(`   ✅ Payment ${p.Id}: cust=${currentCustomerId}→${targetCustomer.Id}, unapplied=${fresh.UnappliedAmt}→${upd.UnappliedAmt}`);
                audit({
                    event: 'payment_reassigned',
                    paymentId: p.Id,
                    fromCustomerId: currentCustomerId,
                    toCustomerId: targetCustomer.Id,
                    invoiceId,
                    totalAmt: fresh.TotalAmt,
                    unappliedBefore: fresh.UnappliedAmt,
                    unappliedAfter: upd.UnappliedAmt,
                });
            }
        }
    }

    auditStream.end();
    await mongoose.disconnect();
    console.log(`\n💾 Audit: ${auditPath}`);
})().catch(async (e) => {
    console.error('❌', e);
    audit({ event: 'error', error: e.message });
    auditStream.end();
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
});
