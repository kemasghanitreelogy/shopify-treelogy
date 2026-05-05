// Rewire a Jubelio invoice (and its linked Payment) from a wrongly-merged
// QBO Customer to one that reflects THIS order's actual recipient. Driven
// by 2026-05-05 audit (audit-merged-customers-*.json) showing a small set
// of Tokopedia buyer accounts shipping to multiple recipients which all got
// stuck on the first recipient's QBO record via the buyer_id fast path.
//
// For each --so <salesorder_no>:
//   1. Look up the original Jubelio webhook payload for the SO and pull
//      the recipient identity (customer_name, contact_id, shipping_phone,
//      shipping_city, shipping_address).
//   2. Compute the canonical DisplayName: `${channel_prefix} - ${customer_name}`.
//   3. Decide on the target QBO Customer:
//        a) If an Active QBO Customer with the canonical name exists AND
//           its PrimaryPhone matches the order's shipping_phone → reuse
//           (it is the same person, just previously seen with the same
//           Tokopedia masking).
//        b) If a name collision exists with a DIFFERENT phone (= different
//           person Tokopedia happens to mask the same way) → append a
//           `(${shipping_city})` disambiguator. If still colliding, fall
//           back to `[contact:${contact_id}]`.
//        c) If no existing record → create a new one with the canonical
//           name (no suffix).
//   4. Sparse-update the Payment(s) linked to the invoice with the new
//      CustomerRef, then the Invoice itself. Doing payments first keeps
//      QBO's CustomerRef-consistency rule happy (Payment.CustomerRef must
//      match its linked invoices' customer at all times).
//   5. Re-verify both txns' CustomerRef post-write.
//
// Usage:
//   node scripts/fix-merged-invoice-recipient.js --so TP-... [--so TP-...]
//   node scripts/fix-merged-invoice-recipient.js --so TP-... --apply
//
// Read-only by default; --apply must be passed for QBO writes. Audit log
// (`fix-merged-invoice-recipient-{ts}.jsonl`) records every plan + write.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const JubelioOrderMap = require('../models/JubelioOrderMap');

const KNOWN_PREFIXES = new Set(['SP', 'TP', 'TT', 'SHF', 'LB', 'CS', 'DP', 'DW', 'WS']);
const PREFIX_CANONICAL = { TT: 'TP' };

const parseArgs = () => {
    const args = process.argv.slice(2);
    const out = { apply: false, sos: [] };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--apply') out.apply = true;
        else if (a === '--so') out.sos.push(args[++i]);
    }
    if (out.sos.length === 0) {
        console.error('❌ pass at least one --so <salesorder_no>');
        process.exit(1);
    }
    return out;
};

const qboBaseUrl = (qbo) => {
    const host = qbo.useSandbox ? 'sandbox-quickbooks.api.intuit.com' : 'quickbooks.api.intuit.com';
    return `https://${host}/v3/company/${qbo.realmId}`;
};

const qboFetch = async (qbo, p, opts = {}) => {
    const url = `${qboBaseUrl(qbo)}${p}${p.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
    const res = await fetch(url, {
        ...opts,
        headers: {
            Authorization: `Bearer ${qbo.token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(opts.headers || {}),
        },
    });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) {
        const err = new Error(`QBO ${opts.method || 'GET'} ${p} (${res.status}): ${JSON.stringify(body).slice(0, 400)}`);
        err.status = res.status;
        err.body = body;
        throw err;
    }
    return body;
};

// Tokopedia phone masking varies — strip non-digits + asterisks for compare.
const normalisePhone = (s) => String(s || '').replace(/\D/g, '').replace(/\*+/g, '');

const channelPrefixOf = (sn) => {
    const m = String(sn || '').match(/^([A-Z]{2,5})-/);
    if (!m) return null;
    const raw = m[1];
    if (!KNOWN_PREFIXES.has(raw)) return null;
    return PREFIX_CANONICAL[raw] || raw;
};

const queryCustomerByName = async (qbo, name) => {
    const escaped = String(name).replace(/'/g, "\\'").substring(0, 100);
    const q = `SELECT Id, DisplayName, Active, PrimaryPhone, PrimaryEmailAddr, SyncToken FROM Customer WHERE DisplayName = '${escaped}'`;
    const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
    return body?.QueryResponse?.Customer || [];
};

const findPaymentsForInvoice = async (qbo, invoice) => {
    const linkedPmtIds = (invoice.LinkedTxn || [])
        .filter(t => t.TxnType === 'Payment')
        .map(t => String(t.TxnId));
    if (linkedPmtIds.length === 0) return [];
    const out = [];
    for (const pid of linkedPmtIds) {
        const body = await qboFetch(qbo, `/payment/${pid}`);
        if (body?.Payment) out.push(body.Payment);
    }
    return out;
};

const buildAddrFromPayload = (p) => {
    if (!p.shipping_address && !p.shipping_city) return undefined;
    return {
        Line1: p.shipping_full_name || p.customer_name || undefined,
        Line2: p.shipping_address || undefined,
        City: p.shipping_city || undefined,
        CountrySubDivisionCode: p.shipping_province || undefined,
        PostalCode: p.shipping_post_code ? String(p.shipping_post_code) : undefined,
        Country: p.shipping_country || undefined,
    };
};

const decideTargetCustomer = async (qbo, baseName, payload, audit) => {
    const orderPhone = normalisePhone(payload.shipping_phone || payload.customer_phone);
    const matches = await queryCustomerByName(qbo, baseName);
    const activeMatches = matches.filter(c => c.Active);

    // Reuse if an active record with the same phone already exists.
    for (const c of activeMatches) {
        const cPhone = normalisePhone(c.PrimaryPhone?.FreeFormNumber);
        if (cPhone && orderPhone && cPhone === orderPhone) {
            audit.push({ ev: 'reuse_phone_match', customerId: c.Id, displayName: c.DisplayName });
            return { reuse: c, displayName: c.DisplayName };
        }
    }

    // No collision → use the canonical name as-is.
    if (activeMatches.length === 0) {
        return { reuse: null, displayName: baseName };
    }

    // Collision with different phone → append disambiguator. Try city first,
    // then contact_id, then a numeric suffix.
    const candidates = [];
    if (payload.shipping_city) candidates.push(`${baseName} (${payload.shipping_city})`);
    if (payload.contact_id) candidates.push(`${baseName} [contact:${payload.contact_id}]`);
    candidates.push(`${baseName} #2`);
    candidates.push(`${baseName} #3`);

    for (const candidate of candidates) {
        const trimmed = candidate.substring(0, 100);
        const dupes = await queryCustomerByName(qbo, trimmed);
        const dupeMatch = dupes.find(c => c.Active && normalisePhone(c.PrimaryPhone?.FreeFormNumber) === orderPhone);
        if (dupeMatch) {
            audit.push({ ev: 'reuse_disambig_phone_match', customerId: dupeMatch.Id, displayName: dupeMatch.DisplayName });
            return { reuse: dupeMatch, displayName: dupeMatch.DisplayName };
        }
        if (dupes.length === 0) {
            audit.push({ ev: 'will_create_disambig', displayName: trimmed });
            return { reuse: null, displayName: trimmed };
        }
    }

    throw new Error(`Cannot find a non-colliding DisplayName starting from "${baseName}" — manual review needed`);
};

(async () => {
    const args = parseArgs();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const auditFile = path.join(process.cwd(), `fix-merged-invoice-recipient-${ts}.jsonl`);
    const auditWrite = (obj) => fs.appendFileSync(auditFile, JSON.stringify(obj) + '\n');

    console.log(`\n🔧 Fix merged invoice recipient (mode=${args.apply ? 'APPLY' : 'DRY-RUN'})`);
    console.log(`   Salesorders: ${args.sos.join(', ')}`);
    console.log(`   Audit log  : ${auditFile}\n`);

    await mongoose.connect(process.env.MONGODB_URI);
    const { getQboInstance } = require('../services/qboService');
    const qbo = await getQboInstance();

    for (const sn of args.sos) {
        console.log(`\n━━━ ${sn} ━━━`);
        const audit = [];
        try {
            const log = await JubelioPayloadLog.findOne(
                { 'payload.salesorder_no': new RegExp('^' + sn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }
            ).sort({ received_at: 1 }).lean();
            if (!log) throw new Error('payload log not found');
            const p = log.payload;

            const orderMap = await JubelioOrderMap.findOne({ salesorder_no: { $regex: '^' + sn } }).lean();
            if (!orderMap?.qbo_invoice_id) throw new Error('JubelioOrderMap or qbo_invoice_id missing');

            const invoiceBody = await qboFetch(qbo, `/invoice/${orderMap.qbo_invoice_id}`);
            const invoice = invoiceBody?.Invoice;
            if (!invoice) throw new Error(`QBO Invoice ${orderMap.qbo_invoice_id} not found`);

            const channelPrefix = channelPrefixOf(sn);
            if (!channelPrefix) throw new Error(`unknown channel prefix in ${sn}`);

            const rawName = String(p.customer_name || '').trim().substring(0, 100);
            if (!rawName) throw new Error('payload.customer_name empty');
            const baseName = `${channelPrefix} - ${rawName}`.substring(0, 100);

            console.log(`  📦 invoice: ${invoice.Id} (${invoice.DocNumber}) currently CustomerRef=${invoice.CustomerRef?.value} "${invoice.CustomerRef?.name}" balance=${invoice.Balance}`);
            console.log(`  🎯 recipient: name="${rawName}" phone="${p.shipping_phone}" city="${p.shipping_city}" contact_id=${p.contact_id}`);
            console.log(`  🏷️  base target name: "${baseName}"`);

            const decision = await decideTargetCustomer(qbo, baseName, p, audit);
            if (decision.reuse) {
                console.log(`  ↩️  reusing existing customer ${decision.reuse.Id} "${decision.reuse.DisplayName}"`);
            } else {
                console.log(`  🆕 will create new customer "${decision.displayName}"`);
            }

            // Skip if invoice already on the target customer (idempotent).
            if (decision.reuse && String(invoice.CustomerRef?.value) === String(decision.reuse.Id)) {
                console.log(`  ✅ already on target customer; nothing to do.`);
                auditWrite({ ts: new Date().toISOString(), so: sn, mode: args.apply ? 'APPLY' : 'DRY-RUN', noop: true, audit });
                continue;
            }

            const payments = await findPaymentsForInvoice(qbo, invoice);
            console.log(`  💰 linked payments: ${payments.length}` + (payments.length ? ' → ' + payments.map(pp => `${pp.Id}(${pp.TotalAmt})`).join(', ') : ''));

            auditWrite({
                ts: new Date().toISOString(),
                so: sn,
                mode: args.apply ? 'APPLY' : 'DRY-RUN',
                phase: 'plan',
                invoice_id: invoice.Id,
                invoice_doc: invoice.DocNumber,
                old_customer: { id: invoice.CustomerRef?.value, name: invoice.CustomerRef?.name },
                new_customer: decision.reuse
                    ? { id: decision.reuse.Id, name: decision.reuse.DisplayName, action: 'reuse' }
                    : { id: null, name: decision.displayName, action: 'create' },
                payments: payments.map(pp => ({ id: pp.Id, amount: pp.TotalAmt, current_customer: pp.CustomerRef?.value })),
                recipient: { name: rawName, phone: p.shipping_phone, city: p.shipping_city, contact_id: p.contact_id },
                steps: audit,
            });

            if (!args.apply) {
                console.log(`  📝 DRY-RUN — pass --apply to execute.`);
                continue;
            }

            // 1) Resolve target customer (create if needed).
            let targetCustomerId, targetDisplayName;
            if (decision.reuse) {
                targetCustomerId = decision.reuse.Id;
                targetDisplayName = decision.reuse.DisplayName;
            } else {
                const payload = {
                    DisplayName: decision.displayName,
                    GivenName: rawName.split(' ')[0] || 'Jubelio',
                    FamilyName: rawName.split(' ').slice(1).join(' ') || 'Customer',
                };
                if (p.customer_email) payload.PrimaryEmailAddr = { Address: p.customer_email };
                if (p.shipping_phone) payload.PrimaryPhone = { FreeFormNumber: String(p.shipping_phone) };
                const addr = buildAddrFromPayload(p);
                if (addr) { payload.ShipAddr = addr; payload.BillAddr = addr; }
                const created = await qboFetch(qbo, '/customer', { method: 'POST', body: JSON.stringify(payload) });
                targetCustomerId = created.Customer.Id;
                targetDisplayName = created.Customer.DisplayName;
                console.log(`  ✅ created customer ${targetCustomerId} "${targetDisplayName}"`);
                auditWrite({ ts: new Date().toISOString(), so: sn, ev: 'customer_created', customerId: targetCustomerId, displayName: targetDisplayName });
            }

            // QBO refuses to point a Payment.CustomerRef at a customer that
            // doesn't own its linked invoices (and vice-versa) — even when
            // both records are top-level customers. Workaround: unlink the
            // payment from this invoice (full-update with the matching Line
            // removed → payment becomes unapplied credit on the old
            // customer, invoice goes back to unpaid), update the invoice's
            // CustomerRef, then full-update the payment with the new
            // CustomerRef AND its original Line restored — this re-applies
            // the credit on the new customer in a single write.
            const linesByPaymentToRestore = new Map(); // paymentId → [Line objects that linked this invoice]
            for (const pmt of payments) {
                if (String(pmt.CustomerRef?.value) === String(targetCustomerId)) continue;
                const originalLines = pmt.Line || [];
                const linesForThisInvoice = originalLines.filter(l =>
                    (l.LinkedTxn || []).some(t => String(t.TxnId) === String(invoice.Id) && t.TxnType === 'Invoice')
                );
                const remainingLines = originalLines.filter(l => !linesForThisInvoice.includes(l));
                linesByPaymentToRestore.set(pmt.Id, linesForThisInvoice);
                const unlinkBody = await qboFetch(qbo, '/payment', {
                    method: 'POST',
                    body: JSON.stringify({ ...pmt, Line: remainingLines }),
                });
                Object.assign(pmt, unlinkBody.Payment);
                console.log(`  🔓 payment ${pmt.Id} unlinked (UnappliedAmt=${pmt.UnappliedAmt})`);
                auditWrite({ ts: new Date().toISOString(), so: sn, ev: 'payment_unlinked', paymentId: pmt.Id });
            }

            // Update invoice now that no linked payment owns it cross-customer.
            // Re-fetch the invoice first because unlinking a payment bumps
            // the invoice's SyncToken even though we never wrote to it.
            const refreshedInv = (await qboFetch(qbo, `/invoice/${invoice.Id}`)).Invoice;
            const updated = await qboFetch(qbo, '/invoice', {
                method: 'POST',
                body: JSON.stringify({
                    Id: refreshedInv.Id,
                    SyncToken: refreshedInv.SyncToken,
                    sparse: true,
                    CustomerRef: { value: String(targetCustomerId) },
                }),
            });
            console.log(`  ✅ invoice ${invoice.Id} → CustomerRef=${targetCustomerId} "${targetDisplayName}"`);
            auditWrite({ ts: new Date().toISOString(), so: sn, ev: 'invoice_rewired', invoiceId: invoice.Id, newCustomerId: targetCustomerId, syncToken_after: updated.Invoice?.SyncToken });

            // Re-link payments under the new customer. QBO returns rich
            // line metadata (NameValue extension fields) when reading a
            // Payment; echoing it back on write makes QBO silently drop
            // the line. Rebuild lines with only Amount + LinkedTxn to
            // sidestep that.
            for (const pmt of payments) {
                const linesToRestore = linesByPaymentToRestore.get(pmt.Id);
                if (!linesToRestore) continue;
                const cleanLines = linesToRestore.map(l => ({
                    Amount: l.Amount,
                    LinkedTxn: (l.LinkedTxn || [])
                        .filter(t => t.TxnId && t.TxnType)
                        .map(t => ({ TxnId: String(t.TxnId), TxnType: t.TxnType })),
                }));
                const carriedLines = (pmt.Line || []).map(l => ({
                    Amount: l.Amount,
                    LinkedTxn: (l.LinkedTxn || [])
                        .filter(t => t.TxnId && t.TxnType)
                        .map(t => ({ TxnId: String(t.TxnId), TxnType: t.TxnType })),
                }));
                const relinkBody = await qboFetch(qbo, '/payment', {
                    method: 'POST',
                    body: JSON.stringify({
                        ...pmt,
                        CustomerRef: { value: String(targetCustomerId) },
                        Line: [...carriedLines, ...cleanLines],
                    }),
                });
                Object.assign(pmt, relinkBody.Payment);
                console.log(`  ✅ payment ${pmt.Id} → CustomerRef=${targetCustomerId} (re-applied; UnappliedAmt=${pmt.UnappliedAmt})`);
                auditWrite({ ts: new Date().toISOString(), so: sn, ev: 'payment_rewired_relinked', paymentId: pmt.Id, newCustomerId: targetCustomerId, syncToken_after: pmt.SyncToken });
            }

            // 4) Verify.
            const verifyR = await qboFetch(qbo, `/invoice/${invoice.Id}`);
            const after = verifyR.Invoice;
            console.log(`  🔎 verify: invoice.CustomerRef=${after.CustomerRef?.value} balance=${after.Balance}`);
            auditWrite({ ts: new Date().toISOString(), so: sn, ev: 'verified', invoice_customer: after.CustomerRef?.value, balance: after.Balance });
        } catch (e) {
            console.error(`  ❌ ${sn}: ${e.message}`);
            auditWrite({ ts: new Date().toISOString(), so: sn, ev: 'error', error: e.message?.slice(0, 400), stack: e.stack?.slice(0, 600) });
        }
    }

    await mongoose.disconnect();
    console.log(`\n📁 ${auditFile}`);
})().catch(async (e) => {
    console.error('Fatal:', e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
});
