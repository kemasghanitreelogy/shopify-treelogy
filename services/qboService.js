const { randomUUID } = require('crypto');
const OAuthClient = require('intuit-oauth');
const QuickBooks = require('node-quickbooks');
const Token = require('../models/Token');

const OAUTH_CONFIG = {
    clientId: process.env.QBO_CLIENT_ID,
    clientSecret: process.env.QBO_CLIENT_SECRET,
    environment: process.env.QBO_ENVIRONMENT || 'sandbox',
    redirectUri: process.env.QBO_REDIRECT_URI,
};

// Refresh if access_token expires within this window. Wider than SDK default
// so a long-running request can't be caught by mid-flight expiry.
const REFRESH_LEEWAY_MS = 5 * 60 * 1000;

// Lock TTL — Intuit refresh latency p99 is ~3s; 30s is 10x headroom and the
// max time a crashed holder blocks others.
const LOCK_TTL_MS = 30_000;

// Max time a waiter polls for an in-flight refresh before giving up.
const MAX_LOCK_WAIT_MS = 15_000;
const POLL_INTERVAL_MS = 200;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function createOAuthClient() {
    return new OAuthClient(OAUTH_CONFIG);
}

function isTokenFresh(tokenDoc) {
    if (!tokenDoc) return false;
    const expiresAtMs = (tokenDoc.tokenCreatedAt || 0) + ((tokenDoc.expires_in || 0) * 1000);
    return expiresAtMs - Date.now() > REFRESH_LEEWAY_MS;
}

async function acquireRefreshLock(realmId, holderId) {
    const now = Date.now();
    const result = await Token.findOneAndUpdate(
        {
            realmId,
            $or: [
                { refreshLockHolder: null },
                { refreshLockHolder: { $exists: false } },
                { refreshLockExpiresAt: { $lt: now } },
            ],
        },
        {
            $set: { refreshLockHolder: holderId, refreshLockExpiresAt: now + LOCK_TTL_MS },
        },
        { returnDocument: 'after' }
    );
    return result?.refreshLockHolder === holderId;
}

async function releaseRefreshLock(realmId, holderId) {
    await Token.findOneAndUpdate(
        { realmId, refreshLockHolder: holderId },
        { $set: { refreshLockHolder: null, refreshLockExpiresAt: 0 } }
    );
}

async function persistRefreshedToken(realmId, expectedVersion, newToken) {
    return Token.findOneAndUpdate(
        { realmId, version: expectedVersion },
        {
            $set: {
                access_token: newToken.access_token,
                refresh_token: newToken.refresh_token,
                expires_in: newToken.expires_in,
                x_refresh_token_expires_in: newToken.x_refresh_token_expires_in,
                tokenCreatedAt: newToken.createdAt,
            },
            $inc: { version: 1 },
        },
        { returnDocument: 'after' }
    );
}

async function callIntuitRefresh(currentToken) {
    const client = createOAuthClient();
    client.setToken({
        token_type: currentToken.token_type,
        access_token: currentToken.access_token,
        refresh_token: currentToken.refresh_token,
        expires_in: currentToken.expires_in,
        x_refresh_token_expires_in: currentToken.x_refresh_token_expires_in,
        createdAt: currentToken.tokenCreatedAt || Date.now(),
    });
    const authResponse = await client.refresh();
    return authResponse.getToken();
}

// Force=true skips the freshness check (used by the safety-net cron).
async function refreshTokenSafely(realmId, { force = false } = {}) {
    const holderId = randomUUID();
    const deadline = Date.now() + MAX_LOCK_WAIT_MS;

    while (Date.now() < deadline) {
        const acquired = await acquireRefreshLock(realmId, holderId);

        if (!acquired) {
            await sleep(POLL_INTERVAL_MS);
            const reread = await Token.findOne({ realmId }).lean();
            if (!force && isTokenFresh(reread)) return reread;
            continue;
        }

        try {
            const current = await Token.findOne({ realmId }).lean();
            if (!force && isTokenFresh(current)) return current;

            let newToken;
            try {
                newToken = await callIntuitRefresh(current);
            } catch (err) {
                const detail = err.authResponse?.json || err.message;
                console.error('❌ Refresh Grant Failed:', detail);
                const e = new Error('Refresh token invalid. Silakan login ulang.');
                e.cause = err;
                throw e;
            }

            const persisted = await persistRefreshedToken(realmId, current.version, newToken);
            if (!persisted) {
                // Version mismatch inside our lock — only possible via direct DB
                // edit. Fall back to whatever's now in the DB.
                return await Token.findOne({ realmId }).lean();
            }
            console.log('✅ Token diperbarui dan disimpan.');
            return persisted;

        } finally {
            await releaseRefreshLock(realmId, holderId);
        }
    }

    throw new Error(`Timeout menunggu lock refresh token (${MAX_LOCK_WAIT_MS}ms)`);
}

const getQboInstance = async () => {
    const tokenDoc = await Token.findOne().sort({ updatedAt: -1 }).lean();
    if (!tokenDoc) throw new Error('Belum ada token di database. Akses /api/auth/login.');

    const fresh = isTokenFresh(tokenDoc)
        ? tokenDoc
        : await refreshTokenSafely(tokenDoc.realmId);

    return new QuickBooks(
        process.env.QBO_CLIENT_ID,
        process.env.QBO_CLIENT_SECRET,
        fresh.access_token,
        false,
        fresh.realmId,
        process.env.QBO_ENVIRONMENT === 'sandbox',
        process.env.NODE_ENV !== 'production',
        '65',
        '2.0',
        fresh.refresh_token
    );
};

const forceRefreshToken = async () => {
    const savedToken = await Token.findOne().sort({ updatedAt: -1 }).lean();
    if (!savedToken) throw new Error('No token in DB. Login via /api/auth/login first.');

    const realmId = savedToken.realmId;
    const before = {
        tokenCreatedAt: savedToken.tokenCreatedAt,
        rt_head: String(savedToken.refresh_token || '').slice(0, 18),
    };

    const refreshed = await refreshTokenSafely(realmId, { force: true });

    return {
        realmId,
        before,
        after: {
            tokenCreatedAt: refreshed?.tokenCreatedAt,
            rt_head: String(refreshed?.refresh_token || '').slice(0, 18),
        },
        rotated: before.rt_head !== String(refreshed?.refresh_token || '').slice(0, 18),
    };
};

module.exports = { createOAuthClient, getQboInstance, forceRefreshToken };
