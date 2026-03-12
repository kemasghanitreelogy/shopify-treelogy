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
    if (!verifyShopifyWebhook(req)) {
        return res.status(401).send('Unauthorized');
    }

    try {
        const shopifyOrder = req.body;
        console.log('✅ HMAC Valid. Memproses order ID:', shopifyOrder.id);

        const qbo = await getQboInstance();

        const lineItems = shopifyOrder.line_items.map(item => ({
            Description: item.name,
            Amount: item.price * item.quantity,
            DetailType: "SalesItemLineDetail",
            SalesItemLineDetail: {
                Qty: item.quantity,
                UnitPrice: item.price,
                ItemRef: { value: "1" }, 
                TaxCodeRef: { value: "NON" } 
            }
        }));

        const salesReceiptData = {
            Line: lineItems,
            CustomerRef: { value: "1" },
            CurrencyRef: { value: shopifyOrder.currency }
        };

        // BUNGKUS DENGAN PROMISE AGAR VERCEL MENUNGGU
        const createReceipt = () => {
            return new Promise((resolve, reject) => {
                qbo.createSalesReceipt(salesReceiptData, (err, receipt) => {
                    if (err) reject(err);
                    else resolve(receipt);
                });
            });
        };

        const receipt = await createReceipt();
        console.log('🚀 Sales Receipt Berhasil! ID:', receipt.Id);
        
        // BALAS SHOPIFY SETELAH SEMUA SELESAI
        res.status(200).send('Success');

    } catch (error) {
        // Jika ID "1" tidak ada, errornya akan muncul di sini sekarang
        console.error('❌ Detail Error dari QBO:', JSON.stringify(error, null, 2));
        res.status(500).send('Error processing webhook');
    }
});

module.exports = router;