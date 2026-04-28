// Audit QBO Items (Products & Services) — classify legacy vs Jubelio integration.
//
// Read-only. Pulls all QBO Items (Active + Inactive), then classifies each
// using signals from the integration code:
//
//   - "Jubelio Sync Item*"     → routes/jubelioWebhook.js:553 generic fallback
//   - "Shipping Charge"        → routes/jubelioWebhook.js:588 shipping helper
//   - Service + Sku non-empty  → routes/jubelioWebhook.js:643 getOrCreateItem
//                                (integrasi selalu bikin Type=Service dgn Sku=item_code)
//   - Inventory / NonInventory → legacy (integrasi tidak pernah bikin Inventory)
//   - Service tanpa Sku        → ambigu (bisa legacy, bisa generic ter-rename)
//
// Usage:
//   node scripts/audit-qbo-items.js                 # console summary
//   node scripts/audit-qbo-items.js --csv=items.csv # also write CSV
//   node scripts/audit-qbo-items.js --json=items.json
//   node scripts/audit-qbo-items.js --include-inactive

require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { getQboInstance } = require('../services/qboService');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');

const args = process.argv.slice(2);
const arg = (k, def) => {
    const hit = args.find(a => a.startsWith(`--${k}=`));
    return hit ? hit.split('=')[1] : def;
};
const csvPath = arg('csv', '');
const jsonPath = arg('json', '');
const includeInactive = args.includes('--include-inactive');

const qboBaseUrl = (qbo) => {
    const host = qbo.useSandbox ? 'sandbox-quickbooks.api.intuit.com' : 'quickbooks.api.intuit.com';
    return `https://${host}/v3/company/${qbo.realmId}`;
};

const qboFetch = async (qbo, path) => {
    const url = `${qboBaseUrl(qbo)}${path}${path.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${qbo.token}`,
            Accept: 'application/json',
        },
    });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) {
        throw new Error(`QBO ${path} (${res.status}): ${JSON.stringify(body).slice(0, 400)}`);
    }
    return body;
};

const fetchAllItems = async (qbo) => {
    const out = [];
    const PAGE = 200;
    for (let startPosition = 1; startPosition < 10000; startPosition += PAGE) {
        // SELECT * returns Sku reliably (explicit field list sometimes omits it)
        const where = includeInactive ? '' : ` WHERE Active = true`;
        const q = `SELECT * FROM Item${where} STARTPOSITION ${startPosition} MAXRESULTS ${PAGE}`;
        const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
        const items = body?.QueryResponse?.Item || [];
        if (items.length === 0) break;
        out.push(...items);
        if (items.length < PAGE) break;
    }
    return out;
};

const classify = (item, jubelioFirstSeen) => {
    const name = String(item.Name || '');
    const type = item.Type || 'Unknown';
    const sku = String(item.Sku || '').trim();
    const created = item.MetaData?.CreateTime ? new Date(item.MetaData.CreateTime) : null;

    if (/^Jubelio Sync Item/i.test(name)) {
        return { bucket: 'JUBELIO_GENERIC_FALLBACK', confidence: 'high', reason: 'name starts with "Jubelio Sync Item"' };
    }
    if (/^Shipping Charge$/i.test(name)) {
        return { bucket: 'JUBELIO_SHIPPING', confidence: 'high', reason: 'matches getShippingItem helper name' };
    }
    if (type === 'Category') {
        return { bucket: 'CATEGORY', confidence: 'n/a', reason: 'organizational only, no SKU' };
    }
    if (type === 'Inventory' || type === 'NonInventory') {
        return { bucket: 'LEGACY_INVENTORY', confidence: 'high', reason: `Type=${type} — integration only creates Service items` };
    }
    // Service items
    if (type === 'Service') {
        if (sku) {
            // SKU populated — likely from integration (or backfilled to match a Jubelio item_code)
            const createdAfterJubelio = jubelioFirstSeen && created && created >= jubelioFirstSeen;
            return {
                bucket: 'JUBELIO_INTEGRATION',
                confidence: createdAfterJubelio ? 'high' : 'medium',
                reason: createdAfterJubelio
                    ? `Service+Sku, created ${created?.toISOString().slice(0, 10)} (after first Jubelio webhook)`
                    : 'Service+Sku — likely from integration or SKU-backfilled',
            };
        }
        return {
            bucket: 'AMBIGUOUS_SERVICE',
            confidence: 'low',
            reason: 'Service without Sku — could be legacy or renamed generic',
        };
    }
    return { bucket: 'OTHER', confidence: 'low', reason: `Type=${type}` };
};

const escCsv = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

(async () => {
    if (!process.env.MONGODB_URI) {
        console.error('❌ MONGODB_URI not set in .env');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGODB_URI);

    try {
        const qbo = await getQboInstance();
        console.log(`🔌 Connected to QBO realm ${qbo.realmId} (${qbo.useSandbox ? 'sandbox' : 'production'})`);

        // Find earliest Jubelio webhook timestamp — used to date-bucket integration items
        const earliest = await JubelioPayloadLog.findOne({}).sort({ received_at: 1 }).select('received_at').lean();
        const jubelioFirstSeen = earliest?.received_at ? new Date(earliest.received_at) : null;
        console.log(`📅 Earliest Jubelio webhook in log: ${jubelioFirstSeen ? jubelioFirstSeen.toISOString() : 'none (only 30d rolling window)'}`);

        const items = await fetchAllItems(qbo);
        console.log(`📦 Fetched ${items.length} QBO Items (${includeInactive ? 'incl. inactive' : 'active only'})\n`);

        const rows = items.map(it => {
            const cls = classify(it, jubelioFirstSeen);
            return {
                id: it.Id,
                name: it.Name,
                fullyQualifiedName: it.FullyQualifiedName,
                type: it.Type,
                sku: it.Sku || '',
                active: it.Active,
                createTime: it.MetaData?.CreateTime || '',
                lastUpdated: it.MetaData?.LastUpdatedTime || '',
                incomeAccount: it.IncomeAccountRef?.name || '',
                bucket: cls.bucket,
                confidence: cls.confidence,
                reason: cls.reason,
            };
        });

        const buckets = {};
        for (const r of rows) {
            if (!buckets[r.bucket]) buckets[r.bucket] = [];
            buckets[r.bucket].push(r);
        }

        console.log('📊 SUMMARY\n' + '─'.repeat(60));
        const order = [
            'JUBELIO_GENERIC_FALLBACK',
            'JUBELIO_SHIPPING',
            'JUBELIO_INTEGRATION',
            'AMBIGUOUS_SERVICE',
            'LEGACY_INVENTORY',
            'CATEGORY',
            'OTHER',
        ];
        for (const k of order) {
            const list = buckets[k] || [];
            console.log(`${k.padEnd(28)} ${String(list.length).padStart(4)} items`);
        }
        console.log('─'.repeat(60));
        console.log(`TOTAL                        ${String(rows.length).padStart(4)} items\n`);

        // Show samples per bucket
        for (const k of order) {
            const list = buckets[k] || [];
            if (list.length === 0) continue;
            console.log(`\n── ${k} (${list.length}) ──`);
            const sample = list.slice(0, 8);
            for (const r of sample) {
                const sku = r.sku ? ` sku=${r.sku}` : '';
                const date = r.createTime ? ` (${r.createTime.slice(0, 10)})` : '';
                console.log(`  [${r.id}] ${r.type.padEnd(12)} "${r.name.slice(0, 60)}"${sku}${date}`);
            }
            if (list.length > sample.length) console.log(`  … +${list.length - sample.length} more`);
        }

        if (csvPath) {
            const header = 'id,name,fullyQualifiedName,type,sku,active,createTime,lastUpdated,incomeAccount,bucket,confidence,reason\n';
            const lines = rows.map(r => [
                r.id, r.name, r.fullyQualifiedName, r.type, r.sku, r.active,
                r.createTime, r.lastUpdated, r.incomeAccount, r.bucket, r.confidence, r.reason,
            ].map(escCsv).join(','));
            fs.writeFileSync(csvPath, header + lines.join('\n') + '\n');
            console.log(`\n💾 CSV ditulis ke ${csvPath}`);
        }
        if (jsonPath) {
            fs.writeFileSync(jsonPath, JSON.stringify({ summary: Object.fromEntries(order.map(k => [k, (buckets[k] || []).length])), total: rows.length, items: rows }, null, 2));
            console.log(`💾 JSON ditulis ke ${jsonPath}`);
        }
    } finally {
        await mongoose.disconnect();
    }
})().catch(e => {
    console.error('❌', e.message);
    process.exit(1);
});
