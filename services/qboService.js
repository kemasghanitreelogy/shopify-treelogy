const OAuthClient = require('intuit-oauth');
const QuickBooks = require('node-quickbooks');
const Token = require('../models/Token');

// Inisialisasi OAuth Client
const oauthClient = new OAuthClient({
    clientId: process.env.QBO_CLIENT_ID,
    clientSecret: process.env.QBO_CLIENT_SECRET,
    environment: process.env.QBO_ENVIRONMENT || 'sandbox',
    redirectUri: process.env.QBO_REDIRECT_URI,
});

const getQboInstance = async () => {
    try {
        // 1. Ambil token terbaru dari database (tidak perlu hardcode realmId di .env)
        const savedToken = await Token.findOne().sort({ updatedAt: -1 });
        
        if (!savedToken) {
            throw new Error('⚠️ Belum ada token di database. Silakan akses /api/auth/login terlebih dahulu.');
        }

        const realmId = savedToken.realmId;

        // PENTING: Ubah Mongoose Document menjadi plain JSON Object
        // Intuit-oauth sering error jika diberikan object bawaan Mongoose
        const tokenData = savedToken.toObject ? savedToken.toObject() : savedToken;
        
        oauthClient.setToken(tokenData);

        let currentToken = oauthClient.getToken();

        // 2. Cek apakah Access Token kedaluwarsa (biasanya 60 menit)
        if (!oauthClient.isAccessTokenValid()) {
            console.log('🔄 Access Token expired. Memulai proses refresh token...');
            
            try {
                const authResponse = await oauthClient.refresh();
                currentToken = authResponse.getToken();
                
                // Simpan token yang baru di-refresh ke Database secara spesifik
                await Token.findOneAndUpdate(
                    { realmId: realmId },
                    { 
                        access_token: currentToken.access_token,
                        refresh_token: currentToken.refresh_token,
                        x_refresh_token_expires_in: currentToken.x_refresh_token_expires_in,
                        expires_in: currentToken.expires_in,
                        updatedAt: new Date()
                    },
                    { upsert: true, new: true }
                );
                console.log('✅ Refresh token sukses dan berhasil disimpan ke DB.');
                
            } catch (refreshError) {
                // Log detail error dari server Intuit (sangat berguna untuk debugging Vercel)
                console.error('❌ Gagal refresh token. Intuit Response:', refreshError.authResponse?.json || refreshError.message);
                throw new Error('Refresh token invalid atau hangus. Anda HARUS login ulang via /api/auth/login');
            }
        }

        // 3. Kembalikan instance node-quickbooks yang sudah terautentikasi
        return new QuickBooks(
            process.env.QBO_CLIENT_ID,
            process.env.QBO_CLIENT_SECRET,
            currentToken.access_token,
            false, // noTokenRenewal (karena kita sudah handle manual di atas)
            realmId,
            process.env.QBO_ENVIRONMENT === 'sandbox', // true jika sandbox
            true, // aktifkan debugging log QBO di Vercel (ubah ke false saat Production)
            null,
            '65', // Minor version (65 sangat stabil untuk QBO Australia/Global)
            currentToken.refresh_token
        );

    } catch (error) {
        console.error('❌ QBO Instance Error:', error.message);
        throw error;
    }
};

module.exports = { oauthClient, getQboInstance };