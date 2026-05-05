// Rename a single QBO Customer to add (or correct) the channel prefix on
// its DisplayName. Targeted, idempotent, dry-run by default. Used after
// the strict-prefix policy was added (2026-05-05) to clean up customers
// that earlier sync paths reused without prefix.
//
// Usage:
//   node scripts/rename-customer-add-prefix.js --name "Veranika Effendy"
//   node scripts/rename-customer-add-prefix.js --name "Veranika Effendy" --apply
//   node scripts/rename-customer-add-prefix.js --name "Veranika Effendy" --prefix SHF --apply
//
// Behaviour:
//   - Looks up the QBO Customer by exact DisplayName (case-insensitive scan).
//   - If --prefix is omitted, infers it from the customer's invoices'
//     DocNumber prefix. Refuses to apply when invoices span multiple
//     channels (ambiguous) or have no recognisable prefix.
//   - Refuses to act when DisplayName already starts with the target prefix.
//   - On --apply: sparse-update DisplayName, then sync
//     JubelioCustomerMap.last_customer_name_qbo so future webhook touches
//     don't churn the field. Writes a JSONL audit alongside the repo root.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');
const JubelioCustomerMap = require('../models/JubelioCustomerMap');

const KNOWN_PREFIXES = new Set(['SP', 'TP', 'TT', 'SHF', 'LB', 'CS', 'DP', 'DW', 'WS']);
const PREFIX_CANONICAL = { TT: 'TP' };
const HAS_PREFIX_RE = /^\s*[A-Z]{2,5}\s*-/;

const parseArgs = () => {
    const args = process.argv.slice(2);
    const out = { apply: false, name: null, prefix: null };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--apply') out.apply = true;
        else if (a === '--name') out.name = args[++i];
        else if (a === '--prefix') out.prefix = String(args[++i] || '').toUpperCase();
    }
    if (!out.name) {
        console.error('❌ --name "<DisplayName>" is required');
        process.exit(1);
    }
    if (out.prefix && !KNOWN_PREFIXES.has(out.prefix)) {
        console.error(`❌ --prefix ${out.prefix} not in KNOWN_PREFIXES (${[...KNOWN_PREFIXES].join(', ')})`);
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

const findCustomerByDisplayName = async (qbo, name) => {
    const escaped = String(name).replace(/'/g, "\\'").substring(0, 100);
    const q = `SELECT Id, DisplayName, SyncToken, Active, PrimaryEmailAddr FROM Customer WHERE DisplayName = '${escaped}'`;
    const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
    return body?.QueryResponse?.Customer || [];
};

const fetchInvoicesForCustomer = async (qbo, customerId) => {
    const out = [];
    const PAGE = 200;
    for (let start = 1; start < 5000; start += PAGE) {
        const q = `SELECT Id, DocNumber FROM Invoice WHERE CustomerRef = '${customerId}' STARTPOSITION ${start} MAXRESULTS ${PAGE}`;
        const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const rows = body?.QueryResponse?.Invoice || [];
        if (rows.length === 0) break;
        out.push(...rows);
        if (rows.length < PAGE) break;
    }
    return out;
};

const inferPrefixFromInvoices = (invoices) => {
    const prefixes = new Set();
    const samples = [];
    for (const inv of invoices) {
        const m = String(inv.DocNumber || '').match(/^([A-Z]{2,5})-/);
        const raw = m?.[1];
        if (!raw || !KNOWN_PREFIXES.has(raw)) continue;
        const canonical = PREFIX_CANONICAL[raw] || raw;
        prefixes.add(canonical);
        if (samples.length < 3) samples.push(inv.DocNumber);
    }
    return { prefixes: [...prefixes], samples };
};

(async () => {
    const args = parseArgs();
    const auditFile = path.join(
        process.cwd(),
        `rename-customer-prefix-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
    );
    const auditWrite = (obj) => fs.appendFileSync(auditFile, JSON.stringify(obj) + '\n');

    console.log(`\n🏷️  Rename customer (mode=${args.apply ? 'APPLY' : 'DRY-RUN'})`);
    console.log(`   Target name: "${args.name}"`);
    if (args.prefix) console.log(`   Forced prefix: ${args.prefix}`);
    console.log(`   Audit log: ${auditFile}\n`);

    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    const matches = await findCustomerByDisplayName(qbo, args.name);
    if (matches.length === 0) {
        console.error(`❌ No QBO Customer found with DisplayName = "${args.name}"`);
        await mongoose.disconnect();
        process.exit(1);
    }
    if (matches.length > 1) {
        console.error(`❌ ${matches.length} customers match — refusing to act on ambiguous name. Ids: ${matches.map(c => c.Id).join(', ')}`);
        await mongoose.disconnect();
        process.exit(1);
    }
    const customer = matches[0];
    console.log(`📍 Customer Id=${customer.Id} DisplayName="${customer.DisplayName}" Active=${customer.Active} email=${customer.PrimaryEmailAddr?.Address || '-'}`);

    if (HAS_PREFIX_RE.test(customer.DisplayName)) {
        const existing = customer.DisplayName.match(/^\s*([A-Z]{2,5})\s*-/)[1].toUpperCase();
        const existingCanonical = PREFIX_CANONICAL[existing] || existing;
        if (!args.prefix || existingCanonical === args.prefix) {
            console.log(`✅ DisplayName already prefixed with "${existing} -" — nothing to do.`);
            await mongoose.disconnect();
            return;
        }
        console.warn(`⚠️ Customer carries prefix "${existing}" but --prefix=${args.prefix} requested. Refusing to overwrite a prefix; rename manually if intentional.`);
        await mongoose.disconnect();
        process.exit(1);
    }

    let prefix = args.prefix;
    let inferenceReport = null;
    if (!prefix) {
        const invoices = await fetchInvoicesForCustomer(qbo, customer.Id);
        const inferred = inferPrefixFromInvoices(invoices);
        inferenceReport = { invoiceCount: invoices.length, ...inferred };
        console.log(`📊 Invoices=${invoices.length} prefixes=[${inferred.prefixes.join(', ') || '(none)'}] samples=${inferred.samples.join(', ') || '(none)'}`);
        if (inferred.prefixes.length === 0) {
            console.error(`❌ Could not infer prefix from invoices — pass --prefix explicitly or rename manually.`);
            await mongoose.disconnect();
            process.exit(1);
        }
        if (inferred.prefixes.length > 1) {
            console.error(`❌ Customer has invoices in multiple channels (${inferred.prefixes.join(', ')}) — refusing to auto-rename. Pass --prefix to force one, or split the customer first.`);
            await mongoose.disconnect();
            process.exit(1);
        }
        prefix = inferred.prefixes[0];
    }

    const newName = `${prefix} - ${customer.DisplayName}`.substring(0, 100);
    console.log(`\n📝 Plan: "${customer.DisplayName}" → "${newName}"`);

    auditWrite({
        ts: new Date().toISOString(),
        mode: args.apply ? 'APPLY' : 'DRY-RUN',
        customerId: customer.Id,
        currentName: customer.DisplayName,
        newName,
        prefix,
        prefixSource: args.prefix ? 'flag' : 'inferred',
        inferenceReport,
        email: customer.PrimaryEmailAddr?.Address || null,
    });

    if (!args.apply) {
        console.log(`\n📝 DRY-RUN: pass --apply to execute.`);
        await mongoose.disconnect();
        return;
    }

    try {
        await qboFetch(qbo, '/customer', {
            method: 'POST',
            body: JSON.stringify({
                Id: customer.Id,
                SyncToken: customer.SyncToken,
                sparse: true,
                DisplayName: newName,
            }),
        });
        console.log(`✅ Renamed Customer ${customer.Id}: "${customer.DisplayName}" → "${newName}"`);
        auditWrite({ ts: new Date().toISOString(), event: 'qbo_renamed', customerId: customer.Id, newName });
    } catch (e) {
        const detail = JSON.stringify(e.body || {}).slice(0, 400);
        console.error(`❌ QBO rename failed: ${e.message?.slice(0, 200)}`);
        auditWrite({ ts: new Date().toISOString(), event: 'qbo_rename_failed', customerId: customer.Id, error: detail });
        await mongoose.disconnect();
        process.exit(1);
    }

    const realmId = String(qbo.realmId);
    const mapResult = await JubelioCustomerMap.updateMany(
        { qbo_customer_id: String(customer.Id), qbo_realm_id: realmId },
        { $set: { last_customer_name_qbo: newName } }
    );
    console.log(`📍 JubelioCustomerMap.last_customer_name_qbo updated for ${mapResult.modifiedCount}/${mapResult.matchedCount} mapping rows`);
    auditWrite({
        ts: new Date().toISOString(),
        event: 'jubelio_map_synced',
        customerId: customer.Id,
        matched: mapResult.matchedCount,
        modified: mapResult.modifiedCount,
    });

    await mongoose.disconnect();
})().catch(async (e) => {
    console.error('\n❌ Fatal:', e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
});
