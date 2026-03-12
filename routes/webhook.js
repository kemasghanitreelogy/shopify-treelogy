const express = require('express');
const crypto = require('crypto'); // Tambahkan ini
const router = express.Router();
const { getQboInstance } = require('../services/qboService');

// Fungsi Helper untuk Verifikasi HMAC
const verifyShopifyWebhook = (req) => {
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    
    // Shopify butuh raw body untuk verifikasi yang akurat
    const generatedHash = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(req.body)) // Pastikan ini raw body jika memungkinkan
        .digest('base64');

    return generatedHash === hmac;
};

router.post('/shopify', async (req, res) => {
    // 1. Validasi keamanan dulu
    if (!verifyShopifyWebhook(req)) {
        console.error('⚠️ Percobaan akses ilegal! HMAC tidak cocok.');
        return res.status(401).send('Unauthorized');
    }

    try {
        const shopifyOrder = req.body;
        
        // Segera beri respon ke Shopify agar tidak dianggap timeout
        res.status(200).send('Webhook verified and received');

        const qbo = await getQboInstance();

        // Mapping data tetap sama seperti sebelumnya...
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

        qbo.createSalesReceipt(salesReceiptData, (err, receipt) => {
            if (err) {
                console.error('QBO Error:', err.Fault ? err.Fault.Error[0] : err);
            } else {
                console.log('✅ Sales Receipt berhasil dibuat di QBO dengan ID:', receipt.Id);
            }
        });

    } catch (error) {
        console.error('Webhook Processing Error:', error);
    }
});

module.exports = router;