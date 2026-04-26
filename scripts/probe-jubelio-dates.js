// Probe what transaction_date values Jubelio actually returns on page 1
// for each list endpoint, sorted by date desc — so we can verify the
// `until` predicate is working correctly.

require('dotenv').config();
const jubelio = require('../services/jubelioApiService');

const JKT_OFFSET_MS = 7 * 60 * 60 * 1000;
const toJkt = (raw) => {
    if (!raw) return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() + JKT_OFFSET_MS).toISOString().substring(0, 10);
};

(async () => {
    await jubelio.login();

    const probes = [
        { ep: '/wms/sales/shipped/', sortBy: 'shipment_date', label: 'shipped' },
        { ep: '/sales/orders/completed/', sortBy: 'transaction_date', label: 'completed' },
        { ep: '/sales/orders/cancel/', sortBy: 'transaction_date', label: 'canceled' },
    ];

    for (const { ep, sortBy, label } of probes) {
        console.log(`\n━━━ ${label} (sort=${sortBy} desc, page 1, size 10) ━━━`);
        const body = await jubelio.apiGet(ep, { sortBy, sortDirection: 'desc', page: 1, pageSize: 10 });
        const items = body?.data || [];
        const dates = items.map(i => ({
            so: i.salesorder_no,
            txnRaw: i.transaction_date,
            txnWib: toJkt(i.transaction_date),
            shipRaw: i.shipment_date,
            shipWib: toJkt(i.shipment_date),
        }));
        for (const d of dates) console.log(' ', d);

        // Distribution check
        const wibDates = items.map(i => toJkt(i.transaction_date)).filter(Boolean);
        const histogram = wibDates.reduce((m, d) => { m[d] = (m[d] || 0) + 1; return m; }, {});
        console.log('  histogram (wib):', histogram);
    }

    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
