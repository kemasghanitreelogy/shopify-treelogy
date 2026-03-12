const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getQboInstance } = require('../services/qboService');

// Fungsi Helper untuk Verifikasi HMAC menggunakan Buffer mentah
const verifyShopifyWebhook = (req) => {
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    
    // Pastikan req.rawBody tersedia dari middleware express.json di index.js
    if (!req.rawBody) {
        console.error('⚠️ Error: req.rawBody tidak ditemukan. Cek konfigurasi middleware di index.js.');
        return false;
    }

    // Menghitung hash menggunakan Buffer asli agar identik dengan kiriman Shopify
    const generatedHash = crypto
        .createHmac('sha256', secret)
        .update(req.rawBody) 
        .digest('base64');

    return generatedHash === hmacHeader;
};

router.post('/shopify', async (req, res) => {
    // 1. Validasi keamanan menggunakan HMAC
    if (!verifyShopifyWebhook(req)) {
        console.error('⚠️ Percobaan akses ilegal! HMAC tidak cocok.');
        return res.status(401).send('Unauthorized');
    }

    try {
        const shopifyOrder = req.body;
        
        // Segera beri respon 200 ke Shopify agar webhook tidak dianggap gagal/timeout
        res.status(200).send('Webhook verified and received');

        console.log('✅ HMAC Valid. Memproses order ID:', shopifyOrder.id);

        const qbo = await getQboInstance();

        // Mapping data Shopify ke QBO
        const lineItems = shopifyOrder.line_items.map(item => ({
            Description: item.name,
            Amount: item.price * item.quantity,
            DetailType: "SalesItemLineDetail",
            SalesItemLineDetail: {
                Qty: item.quantity,
                UnitPrice: item.price,
                // Gunakan ID Item yang valid dari Sandbox Anda
                ItemRef: { value: "1" }, 
                TaxCodeRef: { value: "NON" } 
            }
        }));

        const salesReceiptData = {
            Line: lineItems,
            // Gunakan ID Customer yang valid dari Sandbox Anda
            CustomerRef: { value: "1" },
            CurrencyRef: { value: shopifyOrder.currency }
        };

        // Kirim data ke QuickBooks
        qbo.createSalesReceipt(salesReceiptData, (err, receipt) => {
            if (err) {
                console.error('❌ QBO Error:', err.Fault ? err.Fault.Error[0] : err);
            } else {
                console.log('🚀 Sales Receipt berhasil dibuat di QBO. ID:', receipt.Id);
            }
        });

    } catch (error) {
        console.error('❌ Webhook Processing Error:', error);
    }
});

module.exports = router;