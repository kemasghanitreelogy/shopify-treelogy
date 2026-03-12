const OAuthClient = require('intuit-oauth');
const QuickBooks = require('node-quickbooks');
const Token = require('../models/Token');

const oauthClient = new OAuthClient({
    clientId: process.env.QBO_CLIENT_ID,
    clientSecret: process.env.QBO_CLIENT_SECRET,
    environment: process.env.QBO_ENVIRONMENT || 'sandbox',
    redirectUri: process.env.QBO_REDIRECT_URI,
});

let refreshInProgress = null;

async function refreshAndSave(realmId) {
    const authResponse = await oauthClient.refresh();
    const newToken = authResponse.getToken();

    await Token.findOneAndUpdate(
        { realmId },
        {
            access_token: newToken.access_token,
            refresh_token: newToken.refresh_token,
            expires_in: newToken.expires_in,
            x_refresh_token_expires_in: newToken.x_refresh_token_expires_in,
            tokenCreatedAt: newToken.createdAt,
        },
        { new: true }
    );

    console.log('✅ Token diperbarui dan disimpan.');
    return newToken;
}

const getQboInstance = async () => {
    try {
        const savedToken = await Token.findOne().sort({ updatedAt: -1 });

        if (!savedToken) {
            throw new Error('Belum ada token di database. Akses /api/auth/login.');
        }

        const realmId = savedToken.realmId;

        // Reconstruct token for intuit-oauth with createdAt as Number (not Date)
        const tokenForOAuth = {
            token_type: savedToken.token_type,
            access_token: savedToken.access_token,
            refresh_token: savedToken.refresh_token,
            expires_in: savedToken.expires_in,
            x_refresh_token_expires_in: savedToken.x_refresh_token_expires_in,
            createdAt: savedToken.tokenCreatedAt || Date.now(),
        };

        oauthClient.setToken(tokenForOAuth);

        if (!oauthClient.isAccessTokenValid()) {
            console.log('🔄 Token hampir habis atau sudah expired. Refreshing...');

            try {
                // Prevent concurrent refresh - reuse in-flight promise
                if (!refreshInProgress) {
                    refreshInProgress = refreshAndSave(realmId).finally(() => {
                        refreshInProgress = null;
                    });
                }
                await refreshInProgress;
            } catch (refreshError) {
                // First attempt failed - reload token from DB and retry once
                // (handles race condition where another instance already refreshed)
                console.log('🔄 Retry: memuat ulang token dari database...');
                const freshToken = await Token.findOne({ realmId });

                if (freshToken && freshToken.refresh_token !== savedToken.refresh_token) {
                    // Token was updated by another instance, use it
                    const retryTokenForOAuth = {
                        token_type: freshToken.token_type,
                        access_token: freshToken.access_token,
                        refresh_token: freshToken.refresh_token,
                        expires_in: freshToken.expires_in,
                        x_refresh_token_expires_in: freshToken.x_refresh_token_expires_in,
                        createdAt: freshToken.tokenCreatedAt || Date.now(),
                    };
                    oauthClient.setToken(retryTokenForOAuth);

                    if (!oauthClient.isAccessTokenValid()) {
                        try {
                            refreshInProgress = refreshAndSave(realmId).finally(() => {
                                refreshInProgress = null;
                            });
                            await refreshInProgress;
                        } catch (retryError) {
                            const errorDetail = retryError.authResponse?.json || retryError.message;
                            console.error('❌ Refresh Grant Failed (retry):', errorDetail);
                            throw new Error('Refresh token invalid. Silakan login ulang.');
                        }
                    }
                } else {
                    const errorDetail = refreshError.authResponse?.json || refreshError.message;
                    console.error('❌ Refresh Grant Failed:', errorDetail);
                    throw new Error('Refresh token invalid. Silakan login ulang.');
                }
            }
        }

        const currentToken = oauthClient.getToken();

        return new QuickBooks(
            process.env.QBO_CLIENT_ID,
            process.env.QBO_CLIENT_SECRET,
            currentToken.access_token,
            false,
            realmId,
            process.env.QBO_ENVIRONMENT === 'sandbox',
            process.env.NODE_ENV !== 'production',
            null,
            '65',
            currentToken.refresh_token
        );

    } catch (error) {
        console.error('❌ QBO Service Error:', error.message);
        throw error;
    }
};

module.exports = { oauthClient, getQboInstance };
