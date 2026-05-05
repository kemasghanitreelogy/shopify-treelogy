// Inspect QBO MetaData + custom fields for an orphan invoice to identify
// the source/creator (manual entry vs 3rd-party connector vs other).

require('dotenv').config();
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');

const TARGETS = ['70714', '70707', '69847'];  // 1 TP + 1 TT + 1 SP orphan

const qboBaseUrl = (qbo) => `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;

const qboFetch = async (qbo, p) => {
    const url = `${qboBaseUrl(qbo)}${p}${p.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${qbo.token}`, Accept: 'application/json' } });
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(`QBO GET ${p} (${res.status}): ${JSON.stringify(body).slice(0, 600)}`);
    return body;
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    for (const id of TARGETS) {
        try {
            const body = await qboFetch(qbo, `/invoice/${id}`);
            const inv = body?.Invoice;
            console.log(`\n━━━ Invoice ${inv.Id}  doc=${inv.DocNumber}  total=Rp ${(inv.TotalAmt || 0).toLocaleString('id-ID')}  balance=Rp ${(inv.Balance || 0).toLocaleString('id-ID')}`);
            console.log(`    MetaData.CreateTime         = ${inv.MetaData?.CreateTime}`);
            console.log(`    MetaData.LastUpdatedTime    = ${inv.MetaData?.LastUpdatedTime}`);
            console.log(`    Customer                    = ${inv.CustomerRef?.name}`);
            console.log(`    EmailStatus                 = ${inv.EmailStatus}`);
            console.log(`    PrivateNote                 = ${(inv.PrivateNote || '').slice(0, 200)}`);
            console.log(`    CustomerMemo                = ${(inv.CustomerMemo?.value || '').slice(0, 200)}`);
            console.log(`    BillEmail                   = ${inv.BillEmail?.Address}`);
            console.log(`    SalesTermRef                = ${JSON.stringify(inv.SalesTermRef)}`);
            console.log(`    DepartmentRef               = ${JSON.stringify(inv.DepartmentRef)}`);
            console.log(`    DocNumber                   = ${inv.DocNumber}`);
            console.log(`    GlobalTaxCalculation        = ${inv.GlobalTaxCalculation}`);
            console.log(`    AllowOnlineCreditCardPayment= ${inv.AllowOnlineCreditCardPayment}`);
            console.log(`    AllowOnlineACHPayment       = ${inv.AllowOnlineACHPayment}`);
            console.log(`    HomeBalance                 = ${inv.HomeBalance}`);
            console.log(`    HomeTotalAmt                = ${inv.HomeTotalAmt}`);
            console.log(`    LinkedTxn                   = ${JSON.stringify(inv.LinkedTxn)}`);
            console.log(`    CustomField                 = ${JSON.stringify(inv.CustomField)}`);
            console.log(`    Lines:`);
            for (const l of inv.Line || []) {
                const detail = l.SalesItemLineDetail || l.GroupLineDetail || l.SubTotalLineDetail || l.DiscountLineDetail || {};
                const ref = detail.ItemRef || detail.GroupItemRef || {};
                console.log(`      • ${l.DetailType.padEnd(22)} amt=${(l.Amount || 0).toLocaleString('id-ID').padStart(11)}  item=${ref.value || '-'} "${(ref.name || '').slice(0, 40)}"  desc="${(l.Description || '').slice(0, 50)}"`);
            }
        } catch (e) {
            console.error(`${id}: ${e.message.slice(0, 300)}`);
        }
    }

    await mongoose.disconnect();
})().catch(async e => { console.error('FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
