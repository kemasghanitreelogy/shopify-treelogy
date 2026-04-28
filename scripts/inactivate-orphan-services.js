// Phase 5: inactivate the 11 legacy Service items orphaned by the canonical
// sync sweep. After scripts/sync-jubelio-to-integrated.js redirected every
// Jubelio invoice line off these items and verify-orphan-services.js confirmed
// 0 references, flipping Active=false hides them from active item lists
// without losing history (QBO doesn't support hard delete on items used in
// any past transaction).
//
// Reversible — set Active=true to restore.
//
// Usage:
//   node scripts/inactivate-orphan-services.js          # dry-run
//   node scripts/inactivate-orphan-services.js --apply

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');

const apply = process.argv.includes('--apply');

const TARGET_IDS = ['41', '42', '43', '44', '49', '50', '51', '52', '53', '54', '55'];

const qboBaseUrl = (qbo) => `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;
const qboFetch = async (qbo, p, opts = {}) => {
    const url = `${qboBaseUrl(qbo)}${p}${p.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
    const res = await fetch(url, {
        ...opts,
        headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(`QBO ${opts.method || 'GET'} ${p} (${res.status}): ${JSON.stringify(body).slice(0, 400)}`);
    return body;
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const auditFile = `inactivate-services-audit-${ts}.jsonl`;
    const audit = (e) => fs.appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');

    console.log(`\n🚫 Inactivate 11 orphan Service items · mode=${apply ? 'APPLY' : 'DRY-RUN'}\n📝 ${auditFile}\n`);

    const stats = { fetched: 0, alreadyInactive: 0, inactivated: 0, errors: 0, skipped: 0 };

    for (const id of TARGET_IDS) {
        try {
            const body = await qboFetch(qbo, `/item/${id}`);
            const item = body?.Item;
            if (!item) {
                console.log(`  ❌ id=${id}: not found`);
                stats.errors++;
                audit({ id, error: 'not found' });
                continue;
            }
            stats.fetched++;
            const tag = `id=${id} Type=${item.Type} Active=${item.Active} Sku="${item.Sku || '∅'}" Name="${(item.Name || '').slice(0, 50)}"`;
            if (item.Active === false) {
                console.log(`  ⏭  ${tag} — already inactive, skip`);
                stats.alreadyInactive++;
                audit({ id, status: 'already-inactive' });
                continue;
            }
            if (item.Type !== 'Service') {
                console.log(`  ⚠️  ${tag} — NOT Service type! Skipping for safety.`);
                stats.skipped++;
                audit({ id, status: 'skipped', reason: `unexpected type ${item.Type}` });
                continue;
            }
            console.log(`  🚫 ${tag}  →  Active=false`);
            audit({ id, plan: 'inactivate', currentSyncToken: item.SyncToken, dryRun: !apply });

            if (!apply) continue;

            const updated = await qboFetch(qbo, '/item', {
                method: 'POST',
                body: JSON.stringify({
                    Id: item.Id,
                    SyncToken: item.SyncToken,
                    sparse: true,
                    Active: false,
                }),
            });
            const newItem = updated?.Item;
            console.log(`     ✅ Done (newSyncToken=${newItem?.SyncToken}, Active=${newItem?.Active})`);
            stats.inactivated++;
            audit({ id, status: 'inactivated', newSyncToken: newItem?.SyncToken });
            await sleep(120);
        } catch (e) {
            console.error(`  💥 id=${id}: ${e.message.slice(0, 250)}`);
            stats.errors++;
            audit({ id, status: 'error', error: e.message });
        }
    }

    console.log(`\n📊 SUMMARY`);
    for (const [k, v] of Object.entries(stats)) console.log(`  ${k.padEnd(20)} ${v}`);
    console.log(`\n📝 Audit: ${auditFile}`);
    await mongoose.disconnect();
})().catch(async e => { console.error('💥 FATAL:', e); try { await mongoose.disconnect(); } catch {} process.exit(1); });
