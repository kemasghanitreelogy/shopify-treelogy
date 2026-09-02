// Test untuk hardening outage QBO (2026-09-02).
// Menguji predikat & jalur tax-code yang asli dari routes/jubelioWebhook.js —
// bukan salinannya — supaya test tidak bisa melenceng dari kode produksi.
//
//   node scripts/_test-qbo-timeout-classifier.js
require('dotenv').config();
const wh = require('../routes/jubelioWebhook');

let pass = 0, fail = 0;
const ok = (cond, label) => { cond ? (pass++, console.log(`  ✅ ${label}`)) : (fail++, console.log(`  ❌ ${label}`)); };

const PROD_ERROR = new Error('findTaxCodes: "stream timeout"');   // persis dari alert Telegram

console.log('\n▸ Error dari outage harus dianggap transient');
ok(wh.isRetryableQboError(PROD_ERROR), 'stream timeout → di-retry di dalam proses');
ok(wh.isLikelyTransientError(PROD_ERROR), 'stream timeout → alert ditahan sampai retry Jubelio habis');
for (const m of ['timeout of 60000ms exceeded', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'Client network socket disconnected before secure TLS connection']) {
    ok(wh.isRetryableQboError(new Error(m)) && wh.isLikelyTransientError(new Error(m)), `varian timeout: ${m.slice(0, 42)}`);
}

console.log('\n▸ Error nyata JANGAN ikut tertelan (regresi)');
ok(!wh.isRetryableQboError(new Error('Invalid tax rate id - 9')), 'tax rate invalid tetap non-retryable');
ok(!wh.isLikelyTransientError(new Error('Business Validation Error: Amount must equal Qty x UnitPrice')), 'validation error tetap alert langsung');
ok(!wh.isLikelyTransientError(new Error('Jubelio SO tidak punya items — tidak bisa buat Invoice.')), 'payload rusak tetap alert langsung');

console.log('\n▸ Tax code: pin lewat env (tanpa round-trip ke QBO)');
const explodingQbo = { findTaxCodes: () => { throw new Error('QBO seharusnya TIDAK dipanggil saat env di-pin'); } };
(async () => {
    process.env.QBO_TAX_CODE = '9,7,15';
    const pinned = await wh.getUsableTaxCodes(explodingQbo);
    ok(JSON.stringify(pinned) === '["9","7","15"]', `daftar ter-pin dipakai apa adanya → ${JSON.stringify(pinned)}`);
    process.env.QBO_TAX_CODE = ' 9 ';
    ok(JSON.stringify(await wh.getUsableTaxCodes(explodingQbo)) === '["9"]', 'nilai tunggal + spasi tetap terbaca');
    delete process.env.QBO_TAX_CODE;

    console.log('\n▸ Tax code: cache basi dipakai saat QBO mati');
    const liveQbo = {
        calls: 0,
        findTaxCodes(_c, cb) {
            this.calls++;
            cb(null, { QueryResponse: { TaxCode: [
                { Id: 15, Name: '12.0% S', Active: true, SalesTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: '5' } }] } },
                { Id: 9, Name: '0.0% Z Export', Active: true, SalesTaxRateList: { TaxRateDetail: [{ TaxRateRef: { value: '4' } }] } },
                { Id: 99, Name: 'Rusak', Active: true, SalesTaxRateList: { TaxRateDetail: [] } },
            ] } });
        },
    };
    const fresh = await wh.getUsableTaxCodes(liveQbo);
    ok(JSON.stringify(fresh) === '["9","15"]', `zero-rate diurut duluan, code tanpa rate dibuang → ${JSON.stringify(fresh)}`);

    const deadQbo = { findTaxCodes: (_c, cb) => cb(new Error('stream timeout'), null) };
    const stale = await wh.getUsableTaxCodes(deadQbo);   // TTL belum lewat → cache segar
    ok(JSON.stringify(stale) === '["9","15"]', 'cache segar dipakai, QBO tidak disentuh');

    // paksa TTL lewat supaya jalur serve-stale yang diuji
    const t0 = Date.now();
    const serveStale = await new Promise((resolve) => {
        const orig = Date.now;
        Date.now = () => orig() + 2 * 60 * 60 * 1000;   // maju 2 jam
        wh.getUsableTaxCodes(deadQbo).then((r) => { Date.now = orig; resolve(r); }, (e) => { Date.now = orig; resolve(e); });
    });
    ok(Array.isArray(serveStale) && JSON.stringify(serveStale) === '["9","15"]',
        `TTL habis + QBO mati → tetap balikan cache basi (bukan throw) — ${Math.round((Date.now() - t0) / 1000)}s`);

    console.log(`\n${pass} lulus, ${fail} gagal`);
    process.exit(fail ? 1 : 0);
})();
