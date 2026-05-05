// Rollback: revert "SHF - Della Erani" (Id=14631) from sub back to flat
// customer, then inactivate the orphan parent "Della Erani" (Id=14660).
//
//   node scripts/rollback-subcustomer-test.js          # dry-run
//   node scripts/rollback-subcustomer-test.js --apply  # apply

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');

const apply = process.argv.includes('--apply');
const SUB_ID = '14631';
const PARENT_ID = '14660';

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const auditFile = `subcustomer-rollback-${ts}.jsonl`;
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
        throw new Error(`QBO ${r.status} ${path}: ${fault?.Message || JSON.stringify(body).slice(0, 400)} | detail=${fault?.Detail || ''}`);
    }
    return body;
};

const getCustomer = async (qbo, id) => {
    const body = await qboFetch(qbo, `/customer/${id}?minorversion=65`);
    return body?.Customer;
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();
    console.log(`\nMode: ${apply ? '🚀 APPLY' : '📋 DRY-RUN'}\n`);

    // 1. Try revert sub → flat
    console.log(`━━━ Step 1: revert sub ${SUB_ID} from sub → flat`);
    const sub = await getCustomer(qbo, SUB_ID);
    console.log(`    current: DisplayName="${sub.DisplayName}" job=${sub.Job} parent=${sub.ParentRef?.value || '-'} syncToken=${sub.SyncToken}`);
    audit({ step: 'before_sub', sub });

    if (apply) {
        // Strategy A: try sparse update setting Job=false + ParentRef={}
        try {
            const updated = await qboFetch(qbo, '/customer?minorversion=65', {
                method: 'POST',
                body: JSON.stringify({
                    Id: sub.Id,
                    SyncToken: sub.SyncToken,
                    sparse: true,
                    Job: false,
                    ParentRef: null,
                }),
            });
            const after = updated?.Customer;
            console.log(`    ✓ Reverted. job=${after?.Job} parent=${after?.ParentRef?.value || '-'} fqn="${after?.FullyQualifiedName}"`);
            audit({ step: 'sub_reverted_strategy_A', after });
        } catch (errA) {
            console.warn(`    ⚠️  Strategy A (Job=false, ParentRef=null) failed: ${errA.message}`);
            audit({ step: 'sub_revert_failed_A', error: errA.message });
            console.log(`    → Fallback: leave sub as-is (still under parent), inactivate parent only.`);
        }
    } else {
        console.log(`    PLAN: PATCH Customer ${SUB_ID} sparse: Job=false, ParentRef=null`);
        console.log(`    (if QBO rejects unsetting parent, will fall back to inactivating parent only — sub keeps FQN but UI flat-ish)`);
    }

    // 2. Inactivate parent
    console.log(`\n━━━ Step 2: inactivate parent ${PARENT_ID}`);
    const parent = await getCustomer(qbo, PARENT_ID);
    console.log(`    current: DisplayName="${parent.DisplayName}" active=${parent.Active} syncToken=${parent.SyncToken}`);
    audit({ step: 'before_parent', parent });

    if (apply) {
        try {
            const updated = await qboFetch(qbo, '/customer?minorversion=65', {
                method: 'POST',
                body: JSON.stringify({
                    Id: parent.Id,
                    SyncToken: parent.SyncToken,
                    sparse: true,
                    Active: false,
                }),
            });
            const after = updated?.Customer;
            console.log(`    ✓ Inactivated. Active=${after?.Active}`);
            audit({ step: 'parent_inactivated', after });
        } catch (e) {
            console.error(`    ❌ Failed to inactivate parent: ${e.message}`);
            audit({ step: 'parent_inactivate_failed', error: e.message });
        }
    } else {
        console.log(`    PLAN: PATCH Customer ${PARENT_ID} sparse: Active=false`);
    }

    // 3. Verify
    console.log(`\n━━━ Step 3: verify`);
    if (apply) {
        const subAfter = await getCustomer(qbo, SUB_ID);
        const parentAfter = await getCustomer(qbo, PARENT_ID);
        console.log(`    sub  ${SUB_ID}: DisplayName="${subAfter.DisplayName}" job=${subAfter.Job} parent=${subAfter.ParentRef?.value || '-'} fqn="${subAfter.FullyQualifiedName}" active=${subAfter.Active}`);
        console.log(`    parent ${PARENT_ID}: DisplayName="${parentAfter.DisplayName}" active=${parentAfter.Active}`);
        audit({ step: 'verify', subAfter, parentAfter });
    }

    console.log(`\n${apply ? '✅ APPLIED.' : '📋 Dry-run.'}\n`);
    await mongoose.disconnect();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
