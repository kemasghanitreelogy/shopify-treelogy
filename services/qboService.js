const OAuthClient = require('intuit-oauth');
const QuickBooks = require('node-quickbooks');
const Token = require('../models/Token');

const oauthClient = new OAuthClient({
    clientId: process.env.QBO_CLIENT_ID,
    clientSecret: process.env.QBO_CLIENT_SECRET,
    environment: process.env.QBO_ENVIRONMENT || 'sandbox',
    redirectUri: process.env.QBO_REDIRECT_URI,
});

const getQboInstance = async () => {
    try {
        const savedToken = await Token.findOne().sort({ updatedAt: -1 });
        
        if (!savedToken) {
            throw new Error('Belum ada token di database. Akses /api/auth/login.');
        }

        const realmId = savedToken.realmId;
        const tokenData = savedToken.toObject();
        
        oauthClient.setToken(tokenData);

        // PERBAIKAN DI SINI: Safe check untuk updatedAt
        const lastUpdateMs = savedToken.updatedAt ? new Date(savedToken.updatedAt).getTime() : Date.now();
        const isNearExpiry = (savedToken.expires_in + (lastUpdateMs / 1000)) < (Date.now() / 1000) + 300;

        if (!oauthClient.isAccessTokenValid() || isNearExpiry) {
            console.log('🔄 Token hampir habis atau sudah expired. Refreshing...');
            
            try {
                const authResponse = await oauthClient.refresh();
                const newToken = authResponse.getToken();
                
                const updatedDoc = await Token.findOneAndUpdate(
                    { realmId: realmId },
                    { 
                        access_token: newToken.access_token,
                        refresh_token: newToken.refresh_token,
                        x_refresh_token_expires_in: newToken.x_refresh_token_expires_in,
                        expires_in: newToken.expires_in,
                        updatedAt: new Date() // Sekarang field ini pasti akan tersimpan
                    },
                    { 
                        upsert: true, 
                        returnDocument: 'after' 
                    }
                );
                
                oauthClient.setToken(updatedDoc.toObject());
                console.log('✅ Token diperbarui dan disimpan.');
                
            } catch (refreshError) {
                const errorDetail = refreshError.authResponse?.json || refreshError.message;
                console.error('❌ Refresh Grant Failed:', errorDetail);
                throw new Error('Refresh token invalid. Silakan login ulang.');
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