const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getQboInstance } = require('../services/qboService');

// 1. Fungsi Verifikasi HMAC
const verifyShopifyWebhook = (req) => {
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    
    if (!req.rawBody) {
        console.error('⚠️ Error: req.rawBody tidak ditemukan.');
        return false;
    }

    const generatedHash = crypto
        .createHmac('sha256', secret)
        .update(req.rawBody) 
        .digest('base64');

    return generatedHash === hmacHeader;
};

// Helper: extract QBO error details from axios/QBO error
const getQboErrorDetail = (err) => {
    // QBO error via axios response
    const data = err?.response?.data;
    if (data?.Fault?.Error) return JSON.stringify(data.Fault.Error, null, 2);
    // QBO error passed directly
    if (err?.Fault?.Error) return JSON.stringify(err.Fault.Error, null, 2);
    return err?.message || String(err);
};

// 2. Fungsi Cari/Buat Customer Otomatis
const getOrCreateCustomer = (qbo, customerData) => {
    return new Promise((resolve, reject) => {
        if (!customerData || !customerData.email) {
            console.log('⚠️ Email tidak ada, pakai ID fallback "1"');
            return resolve("1");
        }

        const email = customerData.email;
        const query = `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${email}'`;

        qbo.findCustomers({ Query: query }, (err, result) => {
            if (err) {
                console.error('❌ findCustomers error:', getQboErrorDetail(err));
                return reject(err);
            }

            // Jika Customer sudah ada di QBO
            if (result?.QueryResponse?.Customer?.length > 0) {
                const existing = result.QueryResponse.Customer[0];
                console.log(`👤 Customer ditemukan: ${existing.DisplayName} (ID: ${existing.Id})`);
                return resolve(existing.Id);
            }

            // Jika belum ada, buat baru
            console.log(`🆕 Membuat Customer baru untuk: ${email}`);
            const uniqueName = `${customerData.first_name || 'Pembeli'} ${customerData.last_name || 'Shopify'} (${email})`;

            const newCustomer = {
                GivenName: customerData.first_name || 'Pembeli',
                FamilyName: customerData.last_name || 'Shopify',
                DisplayName: uniqueName,
                PrimaryEmailAddr: { Address: email }
            };

            qbo.createCustomer(newCustomer, (errCreate, created) => {
                if (errCreate) {
                    console.error('❌ createCustomer error:', getQboErrorDetail(errCreate));
                    return reject(errCreate);
                }
                console.log(`✅ Customer baru terdaftar dgn ID: ${created.Id}`);
                resolve(created.Id);
            });
        });
    });
};

// 3. Fungsi Cari Item Otomatis
const findItemByName = (qbo, itemName) => {
    return new Promise((resolve) => {
        // Hilangkan tanda kutip tunggal agar query SQL tidak error
        const safeName = itemName.replace(/'/g, ""); 
        const query = `SELECT * FROM Item WHERE Name = '${safeName}'`;

        qbo.findItems({ Query: query }, (err, result) => {
            if (!err && result.QueryResponse && result.QueryResponse.Item && result.QueryResponse.Item.length > 0) {
                return resolve(result.QueryResponse.Item[0].Id);
            }
            console.log(`⚠️ Item '${itemName}' tidak ditemukan di QBO, pakai ID fallback "1"`);
            resolve("1"); 
        });
    });
};

router.post('/shopify', async (req, res) => {
    if (!verifyShopifyWebhook(req)) {
        return res.status(401).send('Unauthorized');
    }

    try {
        const shopifyOrder = req.body;
        console.log('✅ HMAC Valid. Memproses order ID:', shopifyOrder.id);

        const qbo = await getQboInstance();

        // Dapatkan ID Customer secara dinamis
        const customerId = await getOrCreateCustomer(qbo, shopifyOrder.customer);

        // Proses Line Items secara dinamis
        const lineItems = [];
        for (const item of shopifyOrder.line_items) {
            const itemId = await findItemByName(qbo, item.name);
            const price = parseFloat(item.price) || 0;
            const qty = parseInt(item.quantity) || 1;
            const amount = Math.round(price * qty * 100) / 100;

            lineItems.push({
                Description: item.name,
                Amount: amount,
                DetailType: "SalesItemLineDetail",
                SalesItemLineDetail: {
                    Qty: qty,
                    UnitPrice: price,
                    ItemRef: { value: itemId },
                    TaxCodeRef: { value: "NON" }
                }
            });
        }

        const salesReceiptData = {
            Line: lineItems,
            CustomerRef: { value: customerId },
            CurrencyRef: { value: shopifyOrder.currency }
        };

        console.log('📦 SalesReceipt data:', JSON.stringify(salesReceiptData, null, 2));

        const createReceipt = () => {
            return new Promise((resolve, reject) => {
                qbo.createSalesReceipt(salesReceiptData, (err, receipt) => {
                    if (err) {
                        console.error('❌ createSalesReceipt error:', getQboErrorDetail(err));
                        return reject(err);
                    }
                    resolve(receipt);
                });
            });
        };

        const receipt = await createReceipt();
        console.log('🚀 Sales Receipt Berhasil! ID:', receipt.Id);
        
        res.status(200).send('Success');

    } catch (error) {
        console.error('❌ Terjadi Kesalahan:', getQboErrorDetail(error));
        res.status(500).send('Error processing webhook');
    }
});

module.exports = router;