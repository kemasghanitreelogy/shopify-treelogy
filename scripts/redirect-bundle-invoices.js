// Redirect 2 bundle invoices (Discovery Pack, Movement & Relief) — replace
// single "Sales" line with GroupLineDetail + discount line so QBO mirrors the
// Jubelio bundle structure exactly. Both invoices currently unpaid, so changing
// total isn't a risk; we discount back to original paid amount anyway.
//
// Usage:
//   node scripts/redirect-bundle-invoices.js            # dry-run
//   node scripts/redirect-bundle-invoices.js --apply    # apply

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');

const apply = process.argv.includes('--apply');

// Canonical Inventory id per SKU (from Phase 1 rename)
const ID = {
    'OMP-45-001': '22', 'OMO-30-001': '15', 'OMC-90-001': '18',
    'OMC-180-001': '20', 'OMO-60-001': '16',
};

const ALL_TARGETS = [
    {
        salesorder_no: 'TP-583686010705839610',
        qboInvoiceId: '69872',
        bundleSku: 'Discovery-Pack',
        bundleItemId: '62',
        components: [
            { sku: 'OMP-45-001', itemId: ID['OMP-45-001'], qty: 1, unitPrice: 320000, desc: 'TREELOGY Premium Organic Moringa Powder 45gr' },
            { sku: 'OMO-30-001', itemId: ID['OMO-30-001'], qty: 1, unitPrice: 470000, desc: 'TREELOGY Premium Organic Moringa Seed Oil 30ml' },
            { sku: 'OMC-90-001', itemId: ID['OMC-90-001'], qty: 1, unitPrice: 390000, desc: 'TREELOGY Premium Organic Moringa Capsules 90' },
        ],
        expectedTotal: 998900,
        completed: true,  // applied 2026-04-28 ~14:50 WIB, syncToken=1
    },
    {
        salesorder_no: 'SP-260425PHT0VE69',
        qboInvoiceId: '69847',
        bundleSku: 'The-Movement-&-Relief',
        bundleItemId: '63',
        components: [
            { sku: 'OMC-180-001', itemId: ID['OMC-180-001'], qty: 1, unitPrice: 690000, desc: 'TREELOGY Premium Organic Moringa Capsules 180' },
            { sku: 'OMO-60-001', itemId: ID['OMO-60-001'], qty: 1, unitPrice: 790000, desc: 'TREELOGY Premium Organic Moringa Seed Oil 60ml' },
        ],
        expectedTotal: 1250000,
    },
];

// Skip targets already applied (re-running would double-redirect or fail SyncToken).
const TARGETS = ALL_TARGETS.filter(t => !t.completed);

const qboBaseUrl = (qbo) => `https://${qbo.useSandbox ? 'sandbox-quickbooks' : 'quickbooks'}.api.intuit.com/v3/company/${qbo.realmId}`;

const qboFetch = async (qbo, p, opts = {}) => {
    const url = `${qboBaseUrl(qbo)}${p}${p.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
    const res = await fetch(url, {
        ...opts,
        headers: {
            Authorization: `Bearer ${qbo.token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(opts.headers || {}),
        },
    });
    const text = await res.text();
    let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(`QBO ${opts.method || 'GET'} ${p} (${res.status}): ${JSON.stringify(body).slice(0, 600)}`);
    return body;
};

// Find or create a "Bundle Discount" Service item used for negative-amount
// discount lines. Indonesian QBO may not have native DiscountLineDetail
// configured (requires DiscountAccountRef), so a Service item is the portable
// fallback. Returns { id, accountId }.
let _discountItemId = null;
const ensureDiscountItem = async (qbo) => {
    if (_discountItemId) return _discountItemId;
    const NAME = 'Bundle Discount';
    const q = `SELECT * FROM Item WHERE Name = '${NAME}'`;
    const found = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
    const existing = (found?.QueryResponse?.Item || []).find(i => i.Active);
    if (existing) {
        _discountItemId = existing.Id;
        console.log(`   Discount item: existing id=${existing.Id} "${existing.Name}"`);
        return _discountItemId;
    }
    // Need an income account to create — query for any Income account
    const acct = await qboFetch(qbo, `/query?query=${encodeURIComponent("SELECT Id, Name FROM Account WHERE AccountType = 'Income' AND Active = true")}`);
    const incomeAcct = (acct?.QueryResponse?.Account || []).find(a => /sale|penjualan/i.test(a.Name)) || acct?.QueryResponse?.Account?.[0];
    if (!incomeAcct) throw new Error('No Income account found to create Bundle Discount item');
    const created = await qboFetch(qbo, '/item', {
        method: 'POST',
        body: JSON.stringify({
            Name: NAME,
            Type: 'Service',
            IncomeAccountRef: { value: incomeAcct.Id },
        }),
    });
    _discountItemId = created?.Item?.Id;
    console.log(`   Discount item: CREATED id=${_discountItemId} "${NAME}" (income acct=${incomeAcct.Id})`);
    return _discountItemId;
};

const buildNewLines = (oldInv, target) => {
    const productLines = (oldInv.Line || []).filter(l => l.DetailType === 'SalesItemLineDetail');
    const otherLines = (oldInv.Line || []).filter(l => l.DetailType !== 'SalesItemLineDetail' && l.DetailType !== 'SubTotalLineDetail');

    // Preserve TaxCodeRef from the original product line — Indonesian QBO with
    // AST rejects updates whose lines lack TaxCodeRef when the invoice's
    // GlobalTaxCalculation isn't NotApplicable (quirk #3 in memory). Fall back
    // to id=7 ("No VAT" zero-rate) which is the integration's canonical safe code.
    const originalTaxCodeId = productLines[0]?.SalesItemLineDetail?.TaxCodeRef?.value || '7';

    const lines = [];

    // 1. Component lines at canonical UnitPrice — explicit expansion of the
    // bundle (QBO Group line auto-expansion would leave subtotal=0 at validation
    // time, breaking DiscountLineDetail "amount > subtotal" check).
    const componentSum = target.components.reduce((s, c) => s + c.unitPrice * c.qty, 0);
    for (const c of target.components) {
        lines.push({
            Description: `[${target.bundleSku}] ${c.desc}`,
            Amount: c.unitPrice * c.qty,
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: {
                ItemRef: { value: c.itemId },
                Qty: c.qty,
                UnitPrice: c.unitPrice,
                TaxCodeRef: { value: originalTaxCodeId },
            },
        });
    }

    // 2. Discount line bringing total back to actual paid amount.
    const discountAmt = componentSum - target.expectedTotal;
    if (discountAmt > 0) {
        lines.push({
            Description: `${target.bundleSku} bundle discount (channel/promo)`,
            Amount: discountAmt,
            DetailType: 'DiscountLineDetail',
            DiscountLineDetail: { PercentBased: false },
        });
    }

    // 3. Preserve any non-product lines (none expected for these 2 invoices).
    lines.push(...otherLines);

    return { lines, replacedProductLines: productLines.length, discountAmt, componentSum, taxCodeId: originalTaxCodeId };
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const qbo = await getQboInstance();

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const auditFile = `redirect-bundle-audit-${ts}.jsonl`;
    const audit = (e) => fs.appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');

    console.log(`\n🚀 Redirect bundle invoices · mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
    console.log(`📋 ${TARGETS.length} invoices · 📝 ${auditFile}\n`);

    const stats = { processed: 0, applied: 0, errors: 0 };

    for (const t of TARGETS) {
        try {
            const body = await qboFetch(qbo, `/invoice/${t.qboInvoiceId}`);
            const inv = body?.Invoice;
            if (!inv) { console.log(`❌ ${t.salesorder_no}: invoice ${t.qboInvoiceId} not found`); stats.errors++; continue; }

            console.log(`━━━ ${t.salesorder_no} (qbo id=${inv.Id}, doc=${inv.DocNumber}, syncToken=${inv.SyncToken})`);
            console.log(`    Current total=Rp ${(inv.TotalAmt || 0).toLocaleString('id-ID')}, balance=Rp ${(inv.Balance || 0).toLocaleString('id-ID')}`);
            console.log(`    Existing lines:`);
            for (const l of inv.Line || []) {
                const detail = l.SalesItemLineDetail || l.GroupLineDetail || l.SubTotalLineDetail || {};
                const ref = detail.ItemRef || detail.GroupItemRef || {};
                console.log(`      • ${l.DetailType} amt=${l.Amount} ref=${ref.value || '-'}/"${(ref.name || '').slice(0,30)}"`);
            }

            const { lines, replacedProductLines, discountAmt, componentSum } = buildNewLines(inv, t);
            console.log(`    Plan: replace ${replacedProductLines} product line(s) → ${t.components.length} component line(s) (${t.bundleSku}) + 1 discount line Rp ${discountAmt.toLocaleString('id-ID')}`);
            console.log(`    Expected new total: Rp ${(componentSum - discountAmt).toLocaleString('id-ID')} (= componentSum ${componentSum.toLocaleString('id-ID')} − discount ${discountAmt.toLocaleString('id-ID')})`);

            audit({ salesorder_no: t.salesorder_no, qboInvoiceId: inv.Id, plan: { bundleItemId: t.bundleItemId, discountAmt, lines }, dryRun: !apply });

            if (!apply) {
                console.log(`    📝 DRY-RUN — no changes\n`);
                stats.processed++;
                continue;
            }

            // Build sparse update payload preserving CustomerRef + TxnTaxDetail
            const payload = {
                Id: inv.Id,
                SyncToken: inv.SyncToken,
                sparse: true,
                Line: lines,
                TxnTaxDetail: {},  // force recompute per quirk #5
            };

            const updated = await qboFetch(qbo, '/invoice', {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            const newInv = updated?.Invoice;
            console.log(`    ✅ Applied (newSyncToken=${newInv?.SyncToken}, newTotal=Rp ${(newInv?.TotalAmt || 0).toLocaleString('id-ID')}, balance=Rp ${(newInv?.Balance || 0).toLocaleString('id-ID')})`);
            audit({ salesorder_no: t.salesorder_no, qboInvoiceId: inv.Id, status: 'applied', newSyncToken: newInv?.SyncToken, newTotal: newInv?.TotalAmt });
            stats.applied++;
            await sleep(150);
        } catch (e) {
            console.error(`💥 ${t.salesorder_no}: ${e.message.slice(0, 500)}`);
            audit({ salesorder_no: t.salesorder_no, status: 'error', error: e.message });
            stats.errors++;
        }
        console.log();
    }

    console.log(`📊 SUMMARY  processed=${stats.processed} applied=${stats.applied} errors=${stats.errors}`);
    console.log(`📝 Audit: ${auditFile}`);
    await mongoose.disconnect();
})().catch(async e => { console.error('💥 FATAL:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
