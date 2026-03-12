const express = require('express');
const router = express.Router();
const OAuthClient = require('intuit-oauth'); // <--- TAMBAHKAN BARIS INI
const { oauthClient } = require('../services/qboService'); 
const Token = require('../models/Token');

// Step 1: Redirect to Intuit for login
router.get('/login', (req, res) => {
    // Sekarang OAuthClient sudah terdefinisi dan bisa mengambil scope Accounting
    const authUri = oauthClient.authorizeUri({
        scope: [OAuthClient.scopes.Accounting], 
        state: 'intuit-test'
    });
    res.redirect(authUri);
});

// Step 2: Handle callback and save token
router.get('/callback', async (req, res) => {
    try {
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
            { upsert: true, new: true }
        );

        res.send('Authorization successful! Token saved to database. You can close this window.');
    } catch (error) {
        console.error(error);
        res.status(500).send('Authorization failed.');
    }
});

module.exports = router;