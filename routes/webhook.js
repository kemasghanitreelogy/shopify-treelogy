const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getQboInstance } = require('../services/qboService');

// ─── HMAC Verification ───
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

// ─── QBO Error Helper ───
const extractQboError = (err, body) => {
    if (body?.Fault?.Error) return body.Fault.Error.map(e => `${e.Message} - ${e.Detail}`).join('; ');
    if (err?.Fault?.Error) return err.Fault.Error.map(e => `${e.Message} - ${e.Detail}`).join('; ');
    if (err?.response?.data?.Fault?.Error) return err.response.data.Fault.Error.map(e => `${e.Message} - ${e.Detail}`).join('; ');
    if (err?.response?.data) return JSON.stringify(err.response.data);
    return err?.message || String(err);
};

// ─── QBO Metadata Cache (per warm instance) ───
let _cachedTaxCodeId = null;
let _cachedIncomeAccountId = null;

// Get a valid tax code from QBO
const getDefaultTaxCode = (qbo) => {
    if (process.env.QBO_TAX_CODE) return Promise.resolve(process.env.QBO_TAX_CODE);
    if (_cachedTaxCodeId) return Promise.resolve(_cachedTaxCodeId);

    return new Promise((resolve) => {
        qbo.findTaxCodes([], (err, body) => {
            const codes = body?.QueryResponse?.TaxCode;
            if (codes && codes.length > 0) {
                // Prefer zero-rate/exempt tax codes
                const zeroRate = codes.find(c =>
                    c.Active !== false && (
                        /free|exempt|zero|nil|none|nol|bebas/i.test(c.Name) ||
                        c.Name === 'FRE' || c.Name === 'Z' || c.Name === 'NON'
                    )
                );
                _cachedTaxCodeId = zeroRate ? String(zeroRate.Id) : String(codes[0].Id);
                console.log(`🏷️ Tax code: "${zeroRate ? zeroRate.Name : codes[0].Name}" (ID: ${_cachedTaxCodeId})`);
            } else {
                console.log('⚠️ No tax codes found, omitting TaxCodeRef');
                _cachedTaxCodeId = null;
            }
            resolve(_cachedTaxCodeId);
        });
    });
};

// Get an income account for auto-creating items
const getIncomeAccountId = (qbo) => {
    if (process.env.QBO_INCOME_ACCOUNT_ID) return Promise.resolve(process.env.QBO_INCOME_ACCOUNT_ID);
    if (_cachedIncomeAccountId) return Promise.resolve(_cachedIncomeAccountId);

    return new Promise((resolve) => {
        qbo.findAccounts([
            { field: 'AccountType', value: 'Income', operator: '=' }
        ], (err, body) => {
            const accounts = body?.QueryResponse?.Account;
            if (accounts && accounts.length > 0) {
                // Prefer "Sales of Product Income" or similar
                const salesAccount = accounts.find(a =>
                    /sales|revenue|pendapatan|penjualan/i.test(a.Name)
                ) || accounts[0];
                _cachedIncomeAccountId = String(salesAccount.Id);
                console.log(`💰 Income account: "${salesAccount.Name}" (ID: ${_cachedIncomeAccountId})`);
            } else {
                console.log('⚠️ No income account found');
                _cachedIncomeAccountId = null;
            }
            resolve(_cachedIncomeAccountId);
        });
    });
};

// ─── Customer: Find or Create ───
const getOrCreateCustomer = (qbo, customerData) => {
    return new Promise((resolve, reject) => {
        if (!customerData || !customerData.email) {
            console.log('⚠️ Email tidak ada, pakai ID fallback "1"');
            return resolve("1");
        }

        const email = customerData.email;

        qbo.findCustomers([
            { field: 'PrimaryEmailAddr', value: email, operator: '=' }
        ], (err, body) => {
            if (err) {
                console.error('❌ findCustomers error:', extractQboError(err, body));
                return reject(new Error('findCustomers: ' + extractQboError(err, body)));
            }

            if (body?.QueryResponse?.Customer?.length > 0) {
                const existing = body.QueryResponse.Customer[0];
                console.log(`👤 Customer ditemukan: ${existing.DisplayName} (ID: ${existing.Id})`);
                return resolve(existing.Id);
            }

            console.log(`🆕 Membuat Customer baru untuk: ${email}`);
            const uniqueName = `${customerData.first_name || 'Pembeli'} ${customerData.last_name || 'Shopify'} (${email})`;

            qbo.createCustomer({
                GivenName: customerData.first_name || 'Pembeli',
                FamilyName: customerData.last_name || 'Shopify',
                DisplayName: uniqueName,
                PrimaryEmailAddr: { Address: email }
            }, (errCreate, bodyCreate) => {
                if (errCreate) {
                    console.error('❌ createCustomer error:', extractQboError(errCreate, bodyCreate));
                    return reject(new Error('createCustomer: ' + extractQboError(errCreate, bodyCreate)));
                }
                console.log(`✅ Customer baru: ${bodyCreate.Id}`);
                resolve(bodyCreate.Id);
            });
        });
    });
};

// ─── Item: Find or Auto-Create ───
const getOrCreateItem = (qbo, itemName, price, incomeAccountId) => {
    return new Promise((resolve) => {
        const safeName = itemName.replace(/'/g, "").substring(0, 100); // QBO max 100 chars

        qbo.findItems([
            { field: 'Name', value: safeName, operator: '=' }
        ], (err, body) => {
            if (!err && body?.QueryResponse?.Item?.length > 0) {
                return resolve(body.QueryResponse.Item[0].Id);
            }

            // Auto-create item if not found and we have an income account
            if (!incomeAccountId) {
                console.log(`⚠️ Item '${safeName}' tidak ada & tidak bisa auto-create (no income account)`);
                return resolve(null);
            }

            console.log(`🆕 Auto-creating item: ${safeName}`);
            qbo.createItem({
                Name: safeName,
                Type: 'Service',
                IncomeAccountRef: { value: incomeAccountId },
                UnitPrice: price,
            }, (errCreate, bodyCreate) => {
                if (errCreate) {
                    console.log(`⚠️ createItem error for '${safeName}':`, extractQboError(errCreate, bodyCreate));
                    return resolve(null);
                }
                console.log(`✅ Item created: ${safeName} (ID: ${bodyCreate.Id})`);
                resolve(bodyCreate.Id);
            });
        });
    });
};

// ─── Webhook Handler ───
router.post('/shopify', async (req, res) => {
    if (!verifyShopifyWebhook(req)) {
        return res.status(401).send('Unauthorized');
    }

    try {
        const shopifyOrder = req.body;
        console.log('✅ HMAC Valid. Memproses order ID:', shopifyOrder.id);

        const qbo = await getQboInstance();
        console.log('✅ QBO instance berhasil dibuat.');

        // Fetch QBO metadata (tax code + income account) in parallel
        const [taxCodeId, incomeAccountId] = await Promise.all([
            getDefaultTaxCode(qbo),
            getIncomeAccountId(qbo),
        ]);

        // Customer
        const customerId = await getOrCreateCustomer(qbo, shopifyOrder.customer);
        console.log('✅ Customer ID:', customerId);

        // Line Items
        const lineItems = [];
        for (const item of shopifyOrder.line_items) {
            const price = parseFloat(item.price) || 0;
            const qty = parseInt(item.quantity) || 1;
            const amount = Math.round(price * qty * 100) / 100;

            const itemId = await getOrCreateItem(qbo, item.name, price, incomeAccountId);

            const lineDetail = {
                Qty: qty,
                UnitPrice: price,
            };

            // Only add ItemRef if we have a valid item
            if (itemId) {
                lineDetail.ItemRef = { value: itemId };
            }

            // Only add TaxCodeRef if we found a valid tax code
            if (taxCodeId) {
                lineDetail.TaxCodeRef = { value: taxCodeId };
            }

            lineItems.push({
                Description: item.name,
                Amount: amount,
                DetailType: "SalesItemLineDetail",
                SalesItemLineDetail: lineDetail,
            });
        }

        const salesReceiptData = {
            Line: lineItems,
            CustomerRef: { value: customerId },
            CurrencyRef: { value: shopifyOrder.currency },
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
