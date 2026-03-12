const OAuthClient = require('intuit-oauth');
const QuickBooks = require('node-quickbooks');
const Token = require('../models/Token');

const oauthClient = new OAuthClient({
    clientId: process.env.QBO_CLIENT_ID,
    clientSecret: process.env.QBO_CLIENT_SECRET,
    environment: process.env.QBO_ENVIRONMENT,
    redirectUri: process.env.QBO_REDIRECT_URI,
});

const getQboInstance = async () => {
    const realmId = process.env.QBO_REALM_ID;
    
    // 1. Fetch token from database
    const savedToken = await Token.findOne({ realmId: realmId });
    if (!savedToken) {
        throw new Error('No token found in database. Please authorize the app first.');
    }

    oauthClient.setToken(savedToken);

    // 2. Check and refresh token if necessary
    if (!oauthClient.isAccessTokenValid()) {
        try {
            const authResponse = await oauthClient.refresh();
            const newToken = authResponse.getToken();
            
            // Update database with new token
            await Token.findOneAndUpdate(
                { realmId: realmId },
                { ...newToken, updatedAt: Date.now() },
                { new: true, upsert: true }
            );
            oauthClient.setToken(newToken);
        } catch (error) {
            console.error('Failed to refresh token:', error);
            throw error;
        }
    }

    const currentToken = oauthClient.getToken();

    // 3. Return authenticated QuickBooks instance
    return new QuickBooks(
        process.env.QBO_CLIENT_ID,
        process.env.QBO_CLIENT_SECRET,
        currentToken.access_token,
        false, // noTokenRenewal
        realmId,
        process.env.QBO_ENVIRONMENT === 'sandbox', // true for sandbox
        true, // debugging
        null,
        '65', // minor version: 65 is good for Global/AU region
        currentToken.refresh_token
    );
};

module.exports = { oauthClient, getQboInstance };