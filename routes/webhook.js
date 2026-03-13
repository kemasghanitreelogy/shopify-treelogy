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

// Helper: extract QBO error detail from callback args
// node-quickbooks callback pattern: callback(err, body, res)
// - HTTP error: err=axiosError, body=response.data (has Fault.Error)
// - QBO fault:  err=body (has Fault.Error), body=same
const extractQboError = (err, body) => {
    // Check body first (always has the real QBO error)
    if (body && body.Fault && body.Fault.Error) {
        return body.Fault.Error.map(e => `${e.Message} - ${e.Detail}`).join('; ');
    }
    // Check err.Fault (when QBO returns fault in 200 response)
    if (err && err.Fault && err.Fault.Error) {
        return err.Fault.Error.map(e => `${e.Message} - ${e.Detail}`).join('; ');
    }
    // Check axios error response data
    if (err && err.response && err.response.data) {
        const data = err.response.data;
        if (data.Fault && data.Fault.Error) {
            return data.Fault.Error.map(e => `${e.Message} - ${e.Detail}`).join('; ');
        }
        // Return raw response if not Fault structure
        return JSON.stringify(data);
    }
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

        qbo.findCustomers({ Query: query }, (err, body) => {
            if (err) {
                console.error('❌ findCustomers error:', extractQboError(err, body));
                return reject(new Error('findCustomers: ' + extractQboError(err, body)));
            }

            // Jika Customer sudah ada di QBO
            if (body?.QueryResponse?.Customer?.length > 0) {
                const existing = body.QueryResponse.Customer[0];
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

            qbo.createCustomer(newCustomer, (errCreate, bodyCreate) => {
                if (errCreate) {
                    console.error('❌ createCustomer error:', extractQboError(errCreate, bodyCreate));
                    return reject(new Error('createCustomer: ' + extractQboError(errCreate, bodyCreate)));
                }
                console.log(`✅ Customer baru terdaftar dgn ID: ${bodyCreate.Id}`);
                resolve(bodyCreate.Id);
            });
        });
    });
};

// 3. Fungsi Cari Item Otomatis
const findItemByName = (qbo, itemName) => {
    return new Promise((resolve) => {
        const safeName = itemName.replace(/'/g, "");
        const query = `SELECT * FROM Item WHERE Name = '${safeName}'`;

        qbo.findItems({ Query: query }, (err, body) => {
            if (!err && body?.QueryResponse?.Item?.length > 0) {
                return resolve(body.QueryResponse.Item[0].Id);
            }
            if (err) {
                console.log(`⚠️ findItems error for '${itemName}':`, extractQboError(err, body));
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
        console.log('✅ QBO instance berhasil dibuat.');

        // Dapatkan ID Customer secara dinamis
        const customerId = await getOrCreateCustomer(qbo, shopifyOrder.customer);
        console.log('✅ Customer ID:', customerId);

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

        console.log('📦 SalesReceipt payload:', JSON.stringify(salesReceiptData, null, 2));

        const receipt = await new Promise((resolve, reject) => {
            qbo.createSalesReceipt(salesReceiptData, (err, body) => {
                if (err) {
                    console.error('❌ createSalesReceipt error:', extractQboError(err, body));
                    return reject(new Error('createSalesReceipt: ' + extractQboError(err, body)));
                }
                resolve(body);
            });
        });

        console.log('🚀 Sales Receipt Berhasil! ID:', receipt.Id);
        res.status(200).send('Success');

    } catch (error) {
        console.error('❌ Terjadi Kesalahan:', error.message);
        res.status(500).send('Error processing webhook');
    }
});

module.exports = router;
