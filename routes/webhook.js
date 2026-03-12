const express = require('express');
const router = express.Router();
const { getQboInstance } = require('../services/qboService');

router.post('/shopify', async (req, res) => {
    try {
        const shopifyOrder = req.body;
        
        // Respond to Shopify quickly to prevent webhook timeout
        res.status(200).send('Webhook received');

        const qbo = await getQboInstance();

        // Transform Shopify Line Items to QBO format
        const lineItems = shopifyOrder.line_items.map(item => ({
            Description: item.name,
            Amount: item.price * item.quantity,
            DetailType: "SalesItemLineDetail",
            SalesItemLineDetail: {
                Qty: item.quantity,
                UnitPrice: item.price,
                // "1" is a generic Item ID. You must map this to actual items in QBO later.
                ItemRef: { value: "1" }, 
                // TaxCodeRef "NON" is used here to avoid Global tax errors during initial testing
                TaxCodeRef: { value: "NON" } 
            }
        }));

        const salesReceiptData = {
            Line: lineItems,
            CustomerRef: { value: "1" }, // Replace with a dynamic customer ID mapping later
            CurrencyRef: { value: shopifyOrder.currency }
        };

        qbo.createSalesReceipt(salesReceiptData, (err, receipt) => {
            if (err) {
                console.error('QBO Creation Error:', err.Fault ? err.Fault.Error[0] : err);
            } else {
                console.log('Successfully created Sales Receipt ID:', receipt.Id);
            }
        });

    } catch (error) {
        console.error('Webhook Processing Error:', error);
    }
});

module.exports = router;