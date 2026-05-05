// Investigation: how many QBO Customers are the result of `buyer_id` fast-path
// merging 2+ distinct Jubelio recipients (different `contact_id`s) into one
// record? Driven by 2026-05-05 finding that a single Tokopedia buyer_id can
// span multiple shipping recipients (dropshipper/reseller pattern).
//
// Approach:
//   1. Scan JubelioPayloadLog (endpoint='pesanan') and group every order by
//      (source, buyer_id), recording every distinct `contact_id` seen plus
//      sample customer_name and shipping_phone for each.
//   2. Cross-reference JubelioCustomerMap to learn which qbo_customer_id the
//      group landed on (the merge target).
//   3. Surface groups where contact_ids.length >= 2 — those are the merges.
//
// Output:
//   - audit-merged-customers-{ts}.json — full structured detail
//   - audit-merged-customers-{ts}.csv  — finance-friendly summary
//
// Read-only; no QBO writes.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const JubelioCustomerMap = require('../models/JubelioCustomerMap');

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const jsonOut = path.join(process.cwd(), `audit-merged-customers-${ts}.json`);
const csvOut = path.join(process.cwd(), `audit-merged-customers-${ts}.csv`);

const csvEscape = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

(async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('🔍 Aggregating SO payload logs by (source, buyer_id) ...');

    const t0 = Date.now();
    const grouped = await JubelioPayloadLog.aggregate([
        {
            $match: {
                endpoint: 'pesanan',
                'payload.buyer_id': { $exists: true, $ne: null, $ne: '' },
                'payload.source_name': { $exists: true, $ne: null },
            },
        },
        {
            $group: {
                _id: {
                    source: '$payload.source_name',
                    buyer_id: '$payload.buyer_id',
                    contact_id: '$payload.contact_id',
                },
                orders: { $sum: 1 },
                sample_customer_name: { $first: '$payload.customer_name' },
                sample_shipping_full_name: { $first: '$payload.shipping_full_name' },
                sample_shipping_phone: { $first: '$payload.shipping_phone' },
                sample_shipping_city: { $first: '$payload.shipping_city' },
                sample_so_no: { $first: '$payload.salesorder_no' },
                first_seen: { $min: '$received_at' },
                last_seen: { $max: '$received_at' },
            },
        },
        {
            $group: {
                _id: { source: '$_id.source', buyer_id: '$_id.buyer_id' },
                contacts: {
                    $push: {
                        contact_id: '$_id.contact_id',
                        orders: '$orders',
                        sample_customer_name: '$sample_customer_name',
                        sample_shipping_full_name: '$sample_shipping_full_name',
                        sample_shipping_phone: '$sample_shipping_phone',
                        sample_shipping_city: '$sample_shipping_city',
                        sample_so_no: '$sample_so_no',
                        first_seen: '$first_seen',
                        last_seen: '$last_seen',
                    },
                },
                contact_count: { $sum: 1 },
                total_orders: { $sum: '$orders' },
            },
        },
    ]).allowDiskUse(true);

    console.log(`  ${grouped.length} (source, buyer_id) groups · ${(Date.now() - t0)}ms`);

    const merged = grouped.filter(g => g.contact_count >= 2);
    console.log(`  ${merged.length} groups have ≥2 distinct contact_ids (merge candidates)`);

    if (merged.length === 0) {
        console.log('\n✅ No merged customers found.');
        await mongoose.disconnect();
        return;
    }

    console.log('🔗 Cross-referencing JubelioCustomerMap for QBO target ids ...');
    const realmDocs = await JubelioCustomerMap.find({}).lean();
    const cmapByKey = new Map();
    for (const m of realmDocs) {
        cmapByKey.set(`${m.source}::${m.buyer_id}`, m);
    }

    const enriched = merged.map(g => {
        const key = `${g._id.source}::${g._id.buyer_id}`;
        const cmap = cmapByKey.get(key);
        return {
            source: g._id.source,
            buyer_id: g._id.buyer_id,
            contact_count: g.contact_count,
            total_orders: g.total_orders,
            qbo_customer_id: cmap?.qbo_customer_id || null,
            qbo_customer_name: cmap?.last_customer_name_qbo || null,
            jubelio_last_name: cmap?.last_customer_name_jubelio || null,
            contacts: g.contacts.map(c => ({
                contact_id: c.contact_id,
                orders: c.orders,
                customer_name: c.sample_customer_name,
                shipping_full_name: c.sample_shipping_full_name,
                shipping_phone: c.sample_shipping_phone,
                shipping_city: c.sample_shipping_city,
                sample_so_no: c.sample_so_no,
                first_seen: c.first_seen,
                last_seen: c.last_seen,
            })),
        };
    });

    enriched.sort((a, b) => b.total_orders - a.total_orders);

    const summary = {
        ran_at: new Date().toISOString(),
        groups_total: grouped.length,
        merged_groups: merged.length,
        merged_orders_total: enriched.reduce((s, g) => s + g.total_orders, 0),
        with_qbo_mapping: enriched.filter(e => e.qbo_customer_id).length,
        without_qbo_mapping: enriched.filter(e => !e.qbo_customer_id).length,
        by_source: enriched.reduce((acc, g) => {
            acc[g.source] = (acc[g.source] || 0) + 1;
            return acc;
        }, {}),
        top_examples: enriched.slice(0, 10).map(g => ({
            source: g.source,
            buyer_id: g.buyer_id,
            qbo_customer_id: g.qbo_customer_id,
            qbo_customer_name: g.qbo_customer_name,
            contact_count: g.contact_count,
            total_orders: g.total_orders,
            distinct_recipients: g.contacts.map(c => c.customer_name).slice(0, 5),
        })),
    };

    fs.writeFileSync(jsonOut, JSON.stringify({ summary, details: enriched }, null, 2));

    const csvLines = ['source,buyer_id,qbo_customer_id,qbo_customer_name,contact_count,total_orders,contact_id,recipient_name,shipping_phone,shipping_city,orders,sample_so_no,first_seen,last_seen'];
    for (const g of enriched) {
        for (const c of g.contacts) {
            csvLines.push([
                g.source,
                g.buyer_id,
                g.qbo_customer_id || '',
                g.qbo_customer_name || '',
                g.contact_count,
                g.total_orders,
                c.contact_id,
                c.customer_name || '',
                c.shipping_phone || '',
                c.shipping_city || '',
                c.orders,
                c.sample_so_no || '',
                c.first_seen?.toISOString?.() || '',
                c.last_seen?.toISOString?.() || '',
            ].map(csvEscape).join(','));
        }
    }
    fs.writeFileSync(csvOut, csvLines.join('\n'));

    console.log(`\n📊 Summary:`);
    console.log(`   Total (source, buyer_id) groups : ${summary.groups_total}`);
    console.log(`   Merged groups (≥2 contact_ids)  : ${summary.merged_groups}`);
    console.log(`   Total orders involved           : ${summary.merged_orders_total}`);
    console.log(`   With QBO mapping                : ${summary.with_qbo_mapping}`);
    console.log(`   Without QBO mapping             : ${summary.without_qbo_mapping}`);
    console.log(`   By source                       : ${JSON.stringify(summary.by_source)}`);
    console.log(`\n🔝 Top 10 most-merged buyers:`);
    summary.top_examples.forEach((e, i) => {
        console.log(`   ${i + 1}. [${e.source}] buyer=${e.buyer_id} → qbo=${e.qbo_customer_id || '(none)'} "${e.qbo_customer_name || '-'}" — ${e.contact_count} contacts, ${e.total_orders} orders`);
        e.distinct_recipients.forEach(n => console.log(`         · ${n}`));
    });
    console.log(`\n📁 ${jsonOut}`);
    console.log(`📁 ${csvOut}`);

    await mongoose.disconnect();
})().catch(async (e) => {
    console.error(e);
    try { await mongoose.disconnect(); } catch {}
    process.exit(1);
});
