// Consolidate duplicate customer records: when a single person exists in QBO
// twice — once with the un-prefixed name (e.g. "Yoke P"), once with the
// canonical "PREFIX - " form (e.g. "SP - Yoke P") — rewire all invoices and
// payments off the un-prefixed id and onto the prefixed canonical id, plus
// update our internal Mongo maps. The un-prefixed record is then marked
// inactive so it disappears from default customer pickers without losing
// audit trail.
//
// Skips:
//  - Already-prefixed customers (nothing to consolidate).
//  - Customers with multiple prefixed variants (e.g. both "SP - Yenny" and
//    "TP - Yenny"); ambiguous, requires human judgment.
//  - Customers with no prefixed variant; those are handled by the regular
//    customerPrefixMigration (which adds the prefix outright).
//
// Dry-run by default; apply=1 actually writes to QBO + Mongo.

const JubelioOrderMap = require('../models/JubelioOrderMap');
const JubelioCustomerMap = require('../models/JubelioCustomerMap');

const HAS_PREFIX_RE = /^\s*[A-Z]{2,5}\s*-/;
const KNOWN_PREFIXES = ['SP', 'TP', 'TT', 'SHF', 'LB', 'CS', 'DP', 'DW', 'WX', 'WA'];

const qboBaseUrl = (qbo) => {
    const host = qbo.useSandbox ? 'sandbox-quickbooks.api.intuit.com' : 'quickbooks.api.intuit.com';
    return `https://${host}/v3/company/${qbo.realmId}`;
};

const qboFetch = async (qbo, path, opts = {}) => {
    const url = `${qboBaseUrl(qbo)}${path}${path.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
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
        const err = new Error(`QBO ${opts.method || 'GET'} ${path} (${res.status}): ${JSON.stringify(body).slice(0, 400)}`);
        err.status = res.status;
        err.body = body;
        throw err;
    }
    return body;
};

// Bulk fetch all active QBO customers once.
const fetchAllCustomers = async (qbo) => {
    const out = [];
    const PAGE = 200;
    for (let startPosition = 1; startPosition < 20000; startPosition += PAGE) {
        const q = `SELECT Id, DisplayName, SyncToken, Active FROM Customer STARTPOSITION ${startPosition} MAXRESULTS ${PAGE}`;
        const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const customers = body?.QueryResponse?.Customer || [];
        if (customers.length === 0) break;
        out.push(...customers);
        if (customers.length < PAGE) break;
    }
    return out;
};

// Targeted query: only fetch invoices/payments for the customer ids we'll
// actually consolidate. QBO supports IN clauses in v3 query — batched 50/req
// to stay safely under the URL length cap.
const buildIndexForCustomers = async (qbo, entity, customerIds) => {
    const byCustomer = new Map();
    if (customerIds.length === 0) return byCustomer;
    const BATCH = 50;
    for (let i = 0; i < customerIds.length; i += BATCH) {
        const batch = customerIds.slice(i, i + BATCH).map(id => `'${String(id)}'`).join(',');
        const q = `SELECT * FROM ${entity} WHERE CustomerRef IN (${batch}) MAXRESULTS 1000`;
        const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const rows = body?.QueryResponse?.[entity] || [];
        for (const r of rows) {
            const cid = r.CustomerRef?.value;
            if (!cid) continue;
            if (!byCustomer.has(cid)) byCustomer.set(cid, []);
            byCustomer.get(cid).push(r);
        }
    }
    return byCustomer;
};

// Sparse update Invoice CustomerRef.
const moveInvoiceCustomer = (qbo, inv, newCustomerId) =>
    qboFetch(qbo, '/invoice', {
        method: 'POST',
        body: JSON.stringify({
            Id: String(inv.Id),
            SyncToken: String(inv.SyncToken),
            sparse: true,
            CustomerRef: { value: String(newCustomerId) },
        }),
    });

// Sparse update Payment: customer first (avoids the silent-Line-drop quirk),
// then customer + Line[] together (QBO requires CustomerRef even on Line-only
// updates). Same pattern used in paymentRecovery.rewirePayment.
const movePaymentCustomer = async (qbo, payment, newCustomerId) => {
    let syncToken = payment.SyncToken;
    if (String(payment.CustomerRef?.value) !== String(newCustomerId)) {
        const r1 = await qboFetch(qbo, '/payment', {
            method: 'POST',
            body: JSON.stringify({
                Id: String(payment.Id),
                SyncToken: syncToken,
                sparse: true,
                CustomerRef: { value: String(newCustomerId) },
            }),
        });
        syncToken = r1?.Payment?.SyncToken ?? syncToken;
    }
    // Re-assert lines so any LinkedTxns survive the customer change.
    const lines = (payment.Line || []).map(l => ({
        Amount: l.Amount,
        LinkedTxn: l.LinkedTxn || [],
    }));
    if (lines.length > 0) {
        await qboFetch(qbo, '/payment', {
            method: 'POST',
            body: JSON.stringify({
                Id: String(payment.Id),
                SyncToken: syncToken,
                sparse: true,
                CustomerRef: { value: String(newCustomerId) },
                Line: lines,
            }),
        });
    }
};

const inactivateCustomer = (qbo, c) =>
    qboFetch(qbo, '/customer', {
        method: 'POST',
        body: JSON.stringify({
            Id: String(c.Id),
            SyncToken: String(c.SyncToken),
            sparse: true,
            Active: false,
        }),
    });

const runCustomerConsolidate = async ({ qbo, apply = false, limit = null, deadlineMs = 240_000 }) => {
    const t0 = Date.now();
    const mode = apply ? 'APPLY' : 'DRY-RUN';
    const realmId = String(qbo.realmId);
    console.log(`\n🔗 Customer consolidation (${mode}, limit=${limit || '∞'}, deadline=${deadlineMs}ms)\n`);

    const customers = await fetchAllCustomers(qbo);
    console.log(`Fetched ${customers.length} QBO customers`);

    // Index by EXACT DisplayName for prefix-variant lookup.
    const byExactName = new Map();
    for (const c of customers) {
        if (c.Active === false) continue;
        byExactName.set(c.DisplayName, c);
    }

    // Find candidates first (no QBO calls), THEN fetch invoices/payments for
    // ONLY those candidates. Avoids the prohibitively expensive full-table
    // scan that pushed apply runtime past Vercel's 300s ceiling.
    const planRaw = []; // { source, target, prefix }
    const ambiguous = [];
    for (const c of customers) {
        if (c.Active === false) continue;
        if (HAS_PREFIX_RE.test(c.DisplayName)) continue;

        const variants = [];
        for (const p of KNOWN_PREFIXES) {
            const variantName = `${p} - ${c.DisplayName}`.substring(0, 100);
            const v = byExactName.get(variantName);
            if (v && v.Id !== c.Id) variants.push({ prefix: p, customer: v });
        }
        if (variants.length === 0) continue;
        if (variants.length > 1) {
            ambiguous.push({
                sourceId: c.Id,
                sourceName: c.DisplayName,
                variants: variants.map(v => ({ prefix: v.prefix, id: v.customer.Id, name: v.customer.DisplayName })),
            });
            continue;
        }
        planRaw.push({ source: c, target: variants[0].customer, prefix: variants[0].prefix });
    }

    const candidateIds = planRaw.map(p => String(p.source.Id));
    console.log(`Identified ${planRaw.length} consolidation candidates, ${ambiguous.length} ambiguous`);
    const invIndex = await buildIndexForCustomers(qbo, 'Invoice', candidateIds);
    const payIndex = await buildIndexForCustomers(qbo, 'Payment', candidateIds);
    console.log(`Fetched invoices for ${invIndex.size} candidates, payments for ${payIndex.size} candidates`);

    const plan = planRaw.map(p => ({
        ...p,
        invoices: invIndex.get(String(p.source.Id)) || [],
        payments: payIndex.get(String(p.source.Id)) || [],
    }));

    const report = {
        apply, mode, runMs: 0,
        totalCustomers: customers.length,
        toConsolidate: plan.length,
        ambiguous,
        consolidated: [],
        errors: [],
        skippedInvoiceErrors: [],
        skippedPaymentErrors: [],
    };

    let processed = 0;
    let hitDeadline = false;
    let hitLimit = false;
    for (const p of plan) {
        if (apply && Date.now() - t0 > deadlineMs) { hitDeadline = true; break; }
        if (apply && limit && report.consolidated.length >= limit) { hitLimit = true; break; }
        processed++;
        const action = {
            sourceId: p.source.Id,
            sourceName: p.source.DisplayName,
            targetId: p.target.Id,
            targetName: p.target.DisplayName,
            prefix: p.prefix,
            invoiceCount: p.invoices.length,
            paymentCount: p.payments.length,
            invoicesMoved: 0,
            paymentsMoved: 0,
            inactivated: false,
        };

        if (!apply) {
            console.log(`  📝 Would consolidate ${p.source.Id} "${p.source.DisplayName}" → ${p.target.Id} "${p.target.DisplayName}" (${p.invoices.length} inv, ${p.payments.length} pmt)`);
            report.consolidated.push(action);
            continue;
        }

        try {
            // 1) Move invoices (single sparse update each).
            for (const inv of p.invoices) {
                try {
                    const r = await moveInvoiceCustomer(qbo, inv, p.target.Id);
                    inv.SyncToken = r?.Invoice?.SyncToken || inv.SyncToken;
                    action.invoicesMoved++;
                } catch (e) {
                    report.skippedInvoiceErrors.push({ sourceId: p.source.Id, invoiceId: inv.Id, error: e.message?.slice(0, 200) });
                }
            }
            // 2) Move payments. Order matters — invoice CustomerRef must match
            //    payment CustomerRef for LinkedTxn to remain valid.
            for (const pay of p.payments) {
                try {
                    await movePaymentCustomer(qbo, pay, p.target.Id);
                    action.paymentsMoved++;
                } catch (e) {
                    report.skippedPaymentErrors.push({ sourceId: p.source.Id, paymentId: pay.Id, error: e.message?.slice(0, 200) });
                }
            }
            // 3) Update Mongo maps to point at the canonical id.
            const m1 = await JubelioOrderMap.updateMany(
                { qbo_realm_id: realmId, qbo_invoice_id: { $in: p.invoices.map(i => String(i.Id)) } },
                {} // map already references invoice id directly, customer changes don't affect it
            );
            await JubelioCustomerMap.updateMany(
                { qbo_realm_id: realmId, qbo_customer_id: String(p.source.Id) },
                {
                    qbo_customer_id: String(p.target.Id),
                    last_customer_name_qbo: p.target.DisplayName,
                }
            );
            // 4) Inactivate the source customer (only if all invoices/payments moved cleanly).
            const cleanMove = action.invoicesMoved === p.invoices.length
                && action.paymentsMoved === p.payments.length;
            if (cleanMove) {
                try {
                    await inactivateCustomer(qbo, p.source);
                    action.inactivated = true;
                } catch (e) {
                    report.errors.push({ sourceId: p.source.Id, stage: 'inactivate', error: e.message?.slice(0, 200) });
                }
            }
            report.consolidated.push(action);
            console.log(`  ✅ ${p.source.Id} "${p.source.DisplayName}" → ${p.target.Id} "${p.target.DisplayName}": invoices=${action.invoicesMoved}/${p.invoices.length} payments=${action.paymentsMoved}/${p.payments.length} inactive=${action.inactivated}`);
        } catch (e) {
            report.errors.push({ sourceId: p.source.Id, error: e.message?.slice(0, 300) });
            console.log(`  ❌ ${p.source.Id}: ${e.message?.slice(0, 200)}`);
        }
        if (processed % 20 === 0) console.log(`  ... ${processed}/${plan.length} processed`);
    }

    report.runMs = Date.now() - t0;
    report.hitDeadline = hitDeadline;
    report.hitLimit = hitLimit;
    report.processed = processed;
    report.remaining = Math.max(0, plan.length - processed);
    console.log(`\n✅ ${mode} done in ${report.runMs}ms · consolidated=${report.consolidated.length} ambiguous=${ambiguous.length} errors=${report.errors.length} remaining=${report.remaining}${hitDeadline ? ' (HIT DEADLINE)' : ''}${hitLimit ? ' (HIT LIMIT)' : ''}`);
    return report;
};

module.exports = { runCustomerConsolidate };
