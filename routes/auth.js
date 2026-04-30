const express = require('express');
const router = express.Router();
const OAuthClient = require('intuit-oauth');
const { createOAuthClient } = require('../services/qboService');
const Token = require('../models/Token');

// Step 1: Redirect to Intuit for login
router.get('/login', (req, res) => {
    const oauthClient = createOAuthClient();
    const authUri = oauthClient.authorizeUri({
        scope: [OAuthClient.scopes.Accounting],
        state: 'intuit-test'
    });
    res.redirect(authUri);
});

// Step 2: Handle callback and save token
router.get('/callback', async (req, res) => {
    try {
        const oauthClient = createOAuthClient();
        const parseRedirect = req.url;
        const authResponse = await oauthClient.createToken(parseRedirect);
        const tokenData = authResponse.getToken();
        const realmId = oauthClient.getToken().realmId;

        await Token.findOneAndUpdate(
            { realmId: realmId },
            {
                realmId: realmId,
                token_type: tokenData.token_type,
                access_token: tokenData.access_token,
                refresh_token: tokenData.refresh_token,
                expires_in: tokenData.expires_in,
                x_refresh_token_expires_in: tokenData.x_refresh_token_expires_in,
                tokenCreatedAt: tokenData.createdAt,
            },
            { upsert: true, returnDocument: 'after' }
        );

        res.send('Authorization successful! Token saved to database. You can close this window.');
    } catch (error) {
        console.error(error);
        res.status(500).send('Authorization failed.');
    }
});

// Debug: list tokens in DB (sanitized). Remove after diagnosis.
router.get('/debug-tokens', async (_req, res) => {
    const tokens = await Token.find().sort({ updatedAt: -1 }).lean();
    res.json(tokens.map(t => ({
        realmId: t.realmId,
        token_type: t.token_type,
        expires_in: t.expires_in,
        access_token_head: (t.access_token || '').slice(0, 16) + '…',
        refresh_token_head: (t.refresh_token || '').slice(0, 16) + '…',
        tokenCreatedAt: t.tokenCreatedAt,
        tokenCreatedAtHuman: t.tokenCreatedAt ? new Date(Number(t.tokenCreatedAt)).toISOString() : null,
        access_exp_human: t.tokenCreatedAt ? new Date(Number(t.tokenCreatedAt) + (t.expires_in || 0) * 1000).toISOString() : null,
        updatedAt: t.updatedAt,
    })));
});

// Debug: delete all stale tokens (so you start from clean state, then re-login)
router.post('/debug-reset', async (_req, res) => {
    const r = await Token.deleteMany({});
    res.json({ deleted: r.deletedCount });
});

module.exports = router;
