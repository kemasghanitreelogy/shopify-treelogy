// Probe Jubelio list endpoints to discover the exact accepted query params.
// Strategy: call with NO params → server returns either default page OR an
// error message that names the required params. Then try common name variants.

require('dotenv').config();
const jubelio = require('../services/jubelioApiService');

const tryGet = async (label, path, params) => {
    process.stdout.write(`  ${label.padEnd(60)} `);
    try {
        const body = await jubelio.apiGet(path, params);
        const dataLen = (body?.data || body?.items || []).length;
        const total = body?.totalCount ?? body?.total ?? '?';
        const sampleKeys = Object.keys(body || {}).slice(0, 8);
        console.log(`✅ data=${dataLen} total=${total} keys=${sampleKeys.join(',')}`);
        if (dataLen > 0) {
            const item = (body.data || body.items)[0];
            const itemKeys = Object.keys(item).filter(k => /date|status|salesorder/i.test(k));
            console.log(`     item.dateLikeKeys: ${itemKeys.slice(0, 12).join(',')}`);
        }
    } catch (e) {
        const msg = String(e.message).slice(0, 250);
        console.log(`❌ ${msg}`);
    }
};

(async () => {
    console.log('\n🔍 Jubelio param discovery\n');

    await jubelio.login();

    const probes = [
        { ep: '/wms/sales/shipped/', label: '/wms/sales/shipped' },
        { ep: '/sales/orders/completed/', label: '/sales/orders/completed' },
        { ep: '/sales/orders/cancel/', label: '/sales/orders/cancel' },
    ];

    for (const { ep, label } of probes) {
        console.log(`\n━━━ ${label} ━━━`);
        await tryGet('no params', ep, {});
        await tryGet('pageSize=5', ep, { pageSize: 5 });
        await tryGet('page=1 + pageSize=5', ep, { page: 1, pageSize: 5 });
        await tryGet('q=""', ep, { q: '' });
        await tryGet('sortBy=transaction_date', ep, { sortBy: 'transaction_date' });
        await tryGet('sortBy=transaction_date + order=desc', ep, { sortBy: 'transaction_date', order: 'desc' });
        await tryGet('sortBy + sortDirection=desc', ep, { sortBy: 'transaction_date', sortDirection: 'desc' });
        await tryGet('startDate=2026-04-25', ep, { startDate: '2026-04-25' });
        await tryGet('start_date=2026-04-25', ep, { start_date: '2026-04-25' });
        await tryGet('from=2026-04-25', ep, { from: '2026-04-25' });
        await tryGet('dateFrom=2026-04-25', ep, { dateFrom: '2026-04-25' });
        await tryGet('startDate+endDate', ep, { startDate: '2026-04-25', endDate: '2026-04-25' });
        await tryGet('start_date+end_date', ep, { start_date: '2026-04-25', end_date: '2026-04-25' });
        await tryGet('from+to', ep, { from: '2026-04-25', to: '2026-04-25' });
    }

    process.exit(0);
})().catch(e => {
    console.error('💥', e);
    process.exit(1);
});
