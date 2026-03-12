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
        // 1. Ambil token terbaru
        const savedToken = await Token.findOne().sort({ updatedAt: -1 });
        
        if (!savedToken) {
            throw new Error('Belum ada token di database. Akses /api/auth/login.');
        }

        const realmId = savedToken.realmId;
        const tokenData = savedToken.toObject();
        
        oauthClient.setToken(tokenData);

        // 2. Cek validitas dengan buffer 5 menit (300 detik)
        // Jika token mati dalam < 5 menit, kita refresh sekarang untuk mencegah error di tengah jalan.
        const isNearExpiry = (savedToken.expires_in + (savedToken.updatedAt.getTime() / 1000)) < (Date.now() / 1000) + 300;

        if (!oauthClient.isAccessTokenValid() || isNearExpiry) {
            console.log('🔄 Token hampir habis atau sudah expired. Refreshing...');
            
            try {
                const authResponse = await oauthClient.refresh();
                const newToken = authResponse.getToken();
                
                // Update dengan returnDocument: 'after' (mengganti new: true)
                const updatedDoc = await Token.findOneAndUpdate(
                    { realmId: realmId },
                    { 
                        access_token: newToken.access_token,
                        refresh_token: newToken.refresh_token,
                        x_refresh_token_expires_in: newToken.x_refresh_token_expires_in,
                        expires_in: newToken.expires_in,
                        updatedAt: new Date()
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

        // 3. Instance QBO
        return new QuickBooks(
            process.env.QBO_CLIENT_ID,
            process.env.QBO_CLIENT_SECRET,
            currentToken.access_token,
            false, 
            realmId,
            process.env.QBO_ENVIRONMENT === 'sandbox',
            process.env.NODE_ENV !== 'production', // Debug true hanya di development
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