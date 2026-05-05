// One-shot test: convert "SHF - Della Erani" into a sub-customer under a new
// parent "Della Erani" (no prefix). Validates whether sub-customer hierarchy
// shows up nicely in Sales by Customer Summary report.
//
//   node scripts/setup-subcustomer-test.js          # dry-run (plan only)
//   node scripts/setup-subcustomer-test.js --apply  # actually create + update

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');

const apply = process.argv.includes('--apply');
const SUB_NAME = 'SHF - Della Erani';
const PARENT_NAME = 'Della Erani';

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const auditFile = `subcustomer-test-${ts}.jsonl`;
const audit = (e) => fs.appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');

const qboFetch = async (qbo, path, init = {}) => {
    const baseUrl = `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
    const r = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
            ...(init.headers || {}),
            Authorization: `Bearer ${qbo.token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
    });
    const body = await r.json();
    if (!r.ok || body?.Fault) {
        const fault = body?.Fault?.Error?.[0];
        throw new Error(`QBO ${r.status} ${path}: ${fault?.Message || JSON.stringify(body).slice(0, 400)}`);
    }
    return body;
};

const findCustomerByDisplayName = async (qbo, name) => {
    const escaped = name.replace(/'/g, "\\'");
    const q = `SELECT Id, DisplayName, Active, SyncToken, Job, ParentRef FROM Customer WHERE DisplayName = '${escaped}'`;
    const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}&minorversion=65`);
    return body?.QueryResponse?.Customer?.[0] || null;
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    console.log(`\nMode: ${apply ? '🚀 APPLY' : '📋 DRY-RUN'}  realmId=${qbo.realmId}`);
    console.log(`Audit: ${auditFile}\n`);

    // 1. Find existing sub
    console.log(`━━━ Step 1: lookup "${SUB_NAME}"`);
    const sub = await findCustomerByDisplayName(qbo, SUB_NAME);
    if (!sub) throw new Error(`Customer "${SUB_NAME}" not found in QBO`);
    console.log(`    ✓ Id=${sub.Id} active=${sub.Active} syncToken=${sub.SyncToken} job=${sub.Job} parent=${sub.ParentRef?.value || '-'}`);
    audit({ step: 'lookup_sub', sub });
    if (sub.Job === true && sub.ParentRef) {
        console.log(`    ⚠️  Already a sub-customer (parent ${sub.ParentRef.value}). Aborting to avoid double-conversion.`);
        await mongoose.disconnect();
        process.exit(0);
    }

    // 2. Find or plan parent
    console.log(`\n━━━ Step 2: lookup parent "${PARENT_NAME}"`);
    let parent = await findCustomerByDisplayName(qbo, PARENT_NAME);
    if (parent) {
        console.log(`    ✓ Parent already exists Id=${parent.Id} active=${parent.Active}`);
        audit({ step: 'parent_exists', parent });
    } else {
        console.log(`    + Will CREATE new parent "${PARENT_NAME}"`);
        if (apply) {
            const created = await qboFetch(qbo, '/customer?minorversion=65', {
                method: 'POST',
                body: JSON.stringify({ DisplayName: PARENT_NAME }),
            });
            parent = created?.Customer;
            console.log(`    ✓ Created parent Id=${parent.Id}`);
            audit({ step: 'parent_created', parent });
        } else {
            parent = { Id: '<NEW>', DisplayName: PARENT_NAME };
        }
    }

    // 3. Update sub: set Job=true + ParentRef to point to parent
    console.log(`\n━━━ Step 3: convert "${SUB_NAME}" → sub of "${PARENT_NAME}"`);
    console.log(`    PLAN: PATCH Customer ${sub.Id}: Job=true, ParentRef.value=${parent.Id}, BillWithParent=false`);
    if (apply) {
        const updated = await qboFetch(qbo, '/customer?minorversion=65', {
            method: 'POST',
            body: JSON.stringify({
                Id: sub.Id,
                SyncToken: sub.SyncToken,
                sparse: true,
                Job: true,
                ParentRef: { value: parent.Id },
                BillWithParent: false,
            }),
        });
        const after = updated?.Customer;
        console.log(`    ✓ Updated. New DisplayName="${after?.DisplayName}" FullyQualifiedName="${after?.FullyQualifiedName}" job=${after?.Job} parent=${after?.ParentRef?.value}`);
        audit({ step: 'sub_converted', after });
    } else {
        console.log(`    (dry-run — no write)`);
    }

    // 4. Verify
    console.log(`\n━━━ Step 4: verify`);
    if (apply) {
        const verify = await findCustomerByDisplayName(qbo, SUB_NAME);
        console.log(`    Sub now: Id=${verify?.Id} job=${verify?.Job} parent=${verify?.ParentRef?.value}`);
        audit({ step: 'verify', verify });
    }

    console.log(`\n${apply ? '✅ APPLIED.' : '📋 Dry-run complete.'} Open QBO → Reports → "Sales by Customer Summary" (Apr 2026) → look for "${PARENT_NAME}" + "${SUB_NAME}" hierarchy.\n`);
    await mongoose.disconnect();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
