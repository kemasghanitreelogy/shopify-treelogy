// Race-condition harness for refreshTokenSafely.
//
// Spawns N concurrent getQboInstance() calls against a Token doc that has been
// artificially aged so the freshness check forces a refresh. Verifies:
//
//   1. Token.version increments by EXACTLY 1 (not N) — proving only one writer
//      reached Intuit.
//   2. All N callers receive the same refresh_token suffix — proving they all
//      converge on the lock winner's result.
//   3. refreshLockHolder is null at the end — proving the lock was released.
//
// Read-only on Intuit side: only ever performs at most one real refresh per
// run. To run a "no-network" simulation (lock contention only, no Intuit hit),
// pass --skip-intuit; that requires the access_token to be marked fresh after
// "refresh", which we fake by patching tokenCreatedAt directly.
//
// Usage:
//   node scripts/race-test-token-refresh.js                  # 20 callers, real refresh
//   node scripts/race-test-token-refresh.js --callers 50     # 50 callers
//   node scripts/race-test-token-refresh.js --dry            # don't age token, just stress

require('dotenv').config();
const mongoose = require('mongoose');
const Token = require('../models/Token');
const { getQboInstance } = require('../services/qboService');

const argv = process.argv.slice(2);
const arg = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return def;
    const next = argv[i + 1];
    return next && !next.startsWith('--') ? next : true;
};

const CALLERS = Number(arg('callers', 20));
const DRY = Boolean(arg('dry', false));

(async () => {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set');
    await mongoose.connect(process.env.MONGODB_URI);

    const before = await Token.findOne().sort({ updatedAt: -1 }).lean();
    if (!before) throw new Error('No Token doc in DB. Login via /api/auth/login first.');

    console.log(`[setup] realmId=${before.realmId}`);
    console.log(`[setup] version=${before.version ?? 0}`);
    console.log(`[setup] tokenCreatedAt=${new Date(before.tokenCreatedAt).toISOString()}`);
    console.log(`[setup] refresh_token_head=${String(before.refresh_token).slice(0, 18)}`);

    if (!DRY) {
        // Age the access_token so isTokenFresh() returns false.
        // expires_in is 3600s; backdate creation by 3580s so leeway window
        // (5 min) trips and refresh path is taken.
        const aged = Date.now() - (3580 * 1000);
        await Token.updateOne({ realmId: before.realmId }, { $set: { tokenCreatedAt: aged } });
        console.log(`[setup] aged tokenCreatedAt → ${new Date(aged).toISOString()}`);
    }

    console.log(`\n[run] spawning ${CALLERS} concurrent getQboInstance() calls...`);
    const t0 = Date.now();

    const results = await Promise.allSettled(
        Array.from({ length: CALLERS }, (_, i) =>
            getQboInstance().then(qbo => ({
                idx: i,
                access_head: String(qbo.token).slice(0, 16),
                refresh_head: String(qbo.refreshToken).slice(0, 18),
            }))
        )
    );

    const elapsed = Date.now() - t0;
    const ok = results.filter(r => r.status === 'fulfilled');
    const fail = results.filter(r => r.status === 'rejected');

    console.log(`\n[result] ${ok.length}/${CALLERS} ok, ${fail.length} failed (${elapsed}ms)`);

    const after = await Token.findOne({ realmId: before.realmId }).lean();
    const versionDelta = (after.version ?? 0) - (before.version ?? 0);
    const accessHeads = new Set(ok.map(r => r.value.access_head));
    const refreshHeads = new Set(ok.map(r => r.value.refresh_head));

    console.log(`\n[verify]`);
    console.log(`  version delta:               ${versionDelta} (expect 1)`);
    console.log(`  unique access_token heads:   ${accessHeads.size} (expect 1)`);
    console.log(`  unique refresh_token heads:  ${refreshHeads.size} (expect 1)`);
    console.log(`  refreshLockHolder at end:    ${after.refreshLockHolder} (expect null)`);
    console.log(`  refreshLockExpiresAt at end: ${after.refreshLockExpiresAt} (expect 0)`);

    if (fail.length) {
        console.log(`\n[failures]`);
        fail.slice(0, 5).forEach((r, i) => console.log(`  ${i}: ${r.reason?.message || r.reason}`));
    }

    const pass =
        versionDelta === 1 &&
        accessHeads.size === 1 &&
        refreshHeads.size === 1 &&
        after.refreshLockHolder === null &&
        fail.length === 0;

    console.log(`\n[verdict] ${pass ? '✅ PASS' : '❌ FAIL'}`);

    await mongoose.disconnect();
    process.exit(pass ? 0 : 1);
})().catch(err => {
    console.error('[fatal]', err);
    process.exit(2);
});
