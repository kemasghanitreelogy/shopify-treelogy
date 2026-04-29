// Pure unit-test of the new line+discount math. Doesn't import buildLines
// (which requires QBO client + DB) — replicates the line/discount computation
// inline so we can validate the algorithm against the actual WS-Y4HBQ8P9...
// scenario from Jubelio UI.

const cases = [
    {
        name: 'WS-Y4HBQ8P9 (wholesale, 10×690k @ 30% off)',
        items: [
            { item_code: 'OMC-180-001', qty: 10, qty_in_base: 10, sell_price: 690000, disc: 30, disc_amount: 2070000, amount: 4830000 },
        ],
        grand_total: 4830000,
        expected: {
            lineGross: 6900000,
            itemDiscount: 2070000,
            mergedDiscountLine: 2070000,
            invoiceTotal: 4830000,
        },
    },
    {
        name: 'Marketplace order (no item disc, no marketplace fee)',
        items: [
            { item_code: 'OMC-180-001', qty: 1, qty_in_base: 1, sell_price: 690000, disc: 0, disc_amount: 0, amount: 690000 },
        ],
        grand_total: 690000,
        expected: {
            lineGross: 690000,
            itemDiscount: 0,
            mergedDiscountLine: 0,  // no DiscountLineDetail emitted
            invoiceTotal: 690000,
        },
    },
    {
        name: 'Shopee order with marketplace fee (no item disc)',
        items: [
            { item_code: 'OMP-90-001', qty: 1, qty_in_base: 1, sell_price: 470000, disc: 0, disc_amount: 0, amount: 470000 },
        ],
        grand_total: 405300,  // grand_total = customer_paid − marketplace fees
        expected: {
            lineGross: 470000,
            itemDiscount: 0,
            mergedDiscountLine: 64700,  // 470000 - 405300 = mkt fee absorbed
            invoiceTotal: 405300,
        },
    },
    {
        name: 'Mixed: 2 items each with different disc',
        items: [
            { item_code: 'OMC-180-001', qty: 5, qty_in_base: 5, sell_price: 690000, disc: 20, disc_amount: 690000, amount: 2760000 },
            { item_code: 'OMP-45-001', qty: 3, qty_in_base: 3, sell_price: 320000, disc: 10, disc_amount: 96000, amount: 864000 },
        ],
        grand_total: 3624000,
        expected: {
            lineGross: 3450000 + 960000,  // = 4410000
            itemDiscount: 690000 + 96000,  // = 786000
            mergedDiscountLine: 786000,
            invoiceTotal: 3624000,
        },
    },
];

const computeLine = (it) => {
    const qty = Number(it.qty_in_base ?? it.qty ?? 1) || 1;
    const price = Number(it.sell_price ?? it.price ?? 0) || 0;
    const discAmt = Number(it.disc_amount ?? 0) || 0;
    const gross = qty * price;
    const lineAmount = Number(it.amount ?? (gross - discAmt));
    const jubelioAmount = Math.round(lineAmount * 100) / 100;
    const grossRounded = Math.round(gross * 100) / 100;
    const itemDiscount = Math.round((grossRounded - jubelioAmount) * 100) / 100;
    const effectiveUnitPrice = qty > 0 ? Math.round((grossRounded / qty) * 100) / 100 : grossRounded;
    const amount = Math.round((effectiveUnitPrice * qty) * 100) / 100;
    return { qty, price, gross: grossRounded, jubelioAmount, itemDiscount, effectiveUnitPrice, amount };
};

const fmt = (n) => `Rp ${(n || 0).toLocaleString('id-ID')}`;

let passed = 0, failed = 0;
for (const c of cases) {
    console.log(`\n━━━ ${c.name} ━━━`);
    const computed = c.items.map(computeLine);
    const lineGross = computed.reduce((s, x) => s + x.amount, 0);
    const totalItemDiscount = computed.reduce((s, x) => s + x.itemDiscount, 0);
    const linesTotal = lineGross;  // all SalesItemLineDetail before discount
    const adjustment = Math.round((linesTotal - c.grand_total) * 100) / 100;
    const mergedDiscountLine = adjustment > 0.01 ? adjustment : 0;
    const invoiceTotal = linesTotal - mergedDiscountLine;

    for (let i = 0; i < computed.length; i++) {
        const x = computed[i];
        console.log(`  line[${i}] ${c.items[i].item_code}: qty=${x.qty} × ${fmt(x.effectiveUnitPrice)} = ${fmt(x.amount)}  (gross=${fmt(x.gross)}, itemDisc=${fmt(x.itemDiscount)})`);
    }
    if (mergedDiscountLine > 0) {
        console.log(`  DiscountLineDetail: -${fmt(mergedDiscountLine)}`);
    }
    console.log(`  Invoice TOTAL = ${fmt(invoiceTotal)}  (Jubelio grand_total=${fmt(c.grand_total)})`);

    const checks = [
        { name: 'lineGross', got: lineGross, want: c.expected.lineGross },
        { name: 'itemDiscount', got: totalItemDiscount, want: c.expected.itemDiscount },
        { name: 'mergedDiscountLine', got: mergedDiscountLine, want: c.expected.mergedDiscountLine },
        { name: 'invoiceTotal', got: invoiceTotal, want: c.expected.invoiceTotal },
    ];
    let caseOk = true;
    for (const ck of checks) {
        if (Math.abs(ck.got - ck.want) > 0.01) {
            console.log(`  ❌ ${ck.name}: got ${fmt(ck.got)}, want ${fmt(ck.want)}`);
            caseOk = false;
        }
    }
    if (caseOk) { console.log(`  ✓ all checks pass`); passed++; } else { failed++; }
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`SUMMARY  passed=${passed}  failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
