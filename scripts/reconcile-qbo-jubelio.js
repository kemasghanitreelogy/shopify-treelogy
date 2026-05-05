// Reconcile QBO Items with Jubelio canonical product variants.
//
// Goal: produce a per-variant recommendation so QBO matches Jubelio exactly
// — no ambiguity, no fallback. Each Jubelio variant (item_code) should map
// to exactly one active QBO item with Sku=item_code and a unique Name.
//
// Inputs:
//   qbo-items-audit.json    (from scripts/audit-qbo-items.js)
//   jubelio-products.json   (from scripts/fetch-jubelio-products.js)
// Output:
//   qbo-jubelio-reconciliation.json

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const qboData = JSON.parse(fs.readFileSync(path.join(ROOT, 'qbo-items-audit.json'), 'utf8'));
const jubData = JSON.parse(fs.readFileSync(path.join(ROOT, 'jubelio-products.json'), 'utf8'));

const stripBrand = (s) => String(s || '').replace(/^\s*TREELOGY\b[\s|,\-]*/i, '').trim();
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Flatten Jubelio: one row per variant (item_code is canonical SKU)
const flattenJubelio = (groups, archived) => {
    const out = [];
    for (const g of groups) {
        for (const v of (g.variants || [])) {
            const variationLabel = (v.variation_values || [])
                .map(vv => `${vv.label}=${vv.value}`)
                .join(' | ') || null;
            out.push({
                source: archived ? 'archived' : 'active',
                item_group_id: g.item_group_id,
                item_id: v.item_id,
                item_code: String(v.item_code || '').trim(),
                item_name: String(v.item_name || '').trim(),
                stripped_name: stripBrand(v.item_name),
                variation_label: variationLabel,
                sell_price: v.sell_price,
                end_qty: v.end_qty,
                available_qty: v.available_qty,
                stores: (v.store_names || []).map(s => s.store_name).filter(Boolean),
                tax_rate: v.tax_rate,
            });
        }
    }
    return out;
};

const jubVariants = [
    ...flattenJubelio(jubData.active || [], false),
    ...flattenJubelio(jubData.archived || [], true),
];

const qboItems = qboData.items;

// ── Build matching ──────────────────────────────────────────────────────────
// Step 1: match QBO → Jubelio by SKU (highest confidence)
// Step 2: among unmatched, match by exact normalized name (when Jubelio has only 1 variant for that name)
// Step 3: leave remaining as "no Jubelio match"

const matchByCode = new Map(); // Jubelio item_code → array of QBO items
const qboMatched = new Set();   // QBO id

const jubByCode = new Map(jubVariants.map(v => [v.item_code, v]));

for (const it of qboItems) {
    const sku = (it.sku || '').trim();
    if (!sku) continue;
    if (jubByCode.has(sku)) {
        if (!matchByCode.has(sku)) matchByCode.set(sku, []);
        matchByCode.get(sku).push(it);
        qboMatched.add(it.id);
    }
}

// Pass 2: name match — only when Jubelio has unique stripped name
const jubByStrippedName = new Map();
for (const v of jubVariants) {
    const k = norm(v.stripped_name);
    if (!jubByStrippedName.has(k)) jubByStrippedName.set(k, []);
    jubByStrippedName.get(k).push(v);
}

const matchByName = new Map(); // QBO id → Jubelio variant
for (const it of qboItems) {
    if (qboMatched.has(it.id)) continue;
    if (it.bucket === 'CATEGORY') continue;
    const k = norm(stripBrand(it.name));
    const candidates = jubByStrippedName.get(k);
    if (candidates && candidates.length === 1) {
        matchByName.set(it.id, candidates[0]);
        qboMatched.add(it.id);
        const code = candidates[0].item_code;
        if (!matchByCode.has(code)) matchByCode.set(code, []);
        matchByCode.get(code).push({ ...it, _matchedBy: 'name' });
    }
}

// ── Build per-Jubelio-variant report ────────────────────────────────────────
const jubelioReport = jubVariants.map(v => {
    const qboCandidates = matchByCode.get(v.item_code) || [];
    const matchedBySku = qboCandidates.filter(q => !q._matchedBy);
    const matchedByName = qboCandidates.filter(q => q._matchedBy === 'name');

    let canonicalQbo = null;
    let extras = [];

    // Pick canonical: prefer Service + correct SKU + active + most-recently-updated
    const ranked = [...qboCandidates].sort((a, b) => {
        const score = (q) => {
            let s = 0;
            if (q.type === 'Service') s += 10;       // integration creates Service
            if (q.sku === v.item_code) s += 8;       // exact SKU
            if (q.active) s += 4;
            if (q.bucket === 'JUBELIO_INTEGRATION') s += 2;
            return s;
        };
        const sb = score(b) - score(a);
        if (sb !== 0) return sb;
        // tiebreaker: most recently updated
        return String(b.lastUpdated).localeCompare(String(a.lastUpdated));
    });
    if (ranked.length > 0) {
        canonicalQbo = ranked[0];
        extras = ranked.slice(1);
    }

    // Recommendation for this Jubelio variant
    let action;
    let recommendation;
    if (qboCandidates.length === 0) {
        action = 'CREATE_QBO_ITEM';
        recommendation = `Buat QBO Service item baru: Name="${v.item_name} (${v.variation_label || v.item_code})", Sku="${v.item_code}".`;
    } else if (qboCandidates.length === 1) {
        const q = canonicalQbo;
        const fixes = [];
        if (q.sku !== v.item_code) fixes.push(`set Sku="${v.item_code}" (sekarang "${q.sku || '—'}")`);
        const desiredName = `${v.item_name} (${v.variation_label || v.item_code})`.substring(0, 100);
        if (norm(q.name) !== norm(desiredName) && norm(q.name) !== norm(v.item_name)) {
            // OK if matches the bare item_name (group name) — but for variants in same group, we want suffixed
            // Only flag rename if QBO name is the bare group name AND there are multiple variants in that group
            const groupSize = jubVariants.filter(x => x.item_group_id === v.item_group_id).length;
            if (groupSize > 1 && norm(q.name) === norm(v.item_name)) {
                fixes.push(`rename ke "${desiredName}" agar varian unik`);
            }
        }
        if (q.type === 'Inventory') {
            fixes.push('keep as Inventory (legacy stock tracking) — tapi pastikan integrasi pakai item ini, bukan bikin Service paralel');
        }
        if (fixes.length === 0) {
            action = 'OK_AS_IS';
            recommendation = `Sudah benar — id ${q.id} Sku=${q.sku} Type=${q.type}.`;
        } else {
            action = 'PATCH_QBO_ITEM';
            recommendation = `Patch id ${q.id}: ${fixes.join('; ')}.`;
        }
    } else {
        action = 'CONSOLIDATE_DUPLICATES';
        const keepDesc = canonicalQbo
            ? `KEEP id=${canonicalQbo.id} (${canonicalQbo.type}, sku=${canonicalQbo.sku || '—'})`
            : 'KEEP best candidate';
        const dropDesc = extras.map(e => `INACTIVATE id=${e.id} (sku=${e.sku || '—'}, ${e.type})`).join('; ');
        recommendation = `${keepDesc}; redirect invoice lines lalu ${dropDesc}.`;
    }

    return {
        jubelio: v,
        qboCanonical: canonicalQbo,
        qboExtras: extras,
        matchedBySku: matchedBySku.length,
        matchedByName: matchedByName.length,
        action,
        recommendation,
    };
});

// ── Build per-QBO-item report (orphans = no Jubelio match) ──────────────────
const qboReport = qboItems.map(it => {
    if (qboMatched.has(it.id)) {
        const jub = jubByCode.get(it.sku) || matchByName.get(it.id);
        return {
            qbo: it,
            matchedTo: jub ? { item_code: jub.item_code, item_name: jub.item_name, source: jub.source } : null,
            action: 'MATCHED',
        };
    }
    // Orphan — no Jubelio match
    let action, recommendation;
    if (it.bucket === 'CATEGORY') {
        action = 'KEEP_LEGACY';
        recommendation = 'Folder organisasi QBO — biarkan, tidak perlu sync ke Jubelio.';
    } else if (it.bucket === 'JUBELIO_GENERIC_FALLBACK') {
        action = 'INACTIVATE_GENERIC';
        recommendation = 'Migrasikan invoice yang reference item ini lalu inactivate (jalankan /api/admin/migrate-items).';
    } else if (it.bucket === 'JUBELIO_SHIPPING') {
        action = 'KEEP_HELPER';
        recommendation = 'Helper "Shipping Charge" untuk biaya kirim — biarkan aktif, dipakai integrasi.';
    } else if (it.id === '1' || it.id === '2') {
        action = 'KEEP_LEGACY';
        recommendation = 'QBO default ("Sales", "Hours") — biarkan, tidak perlu sync.';
    } else if (/^Shopify /i.test(it.name)) {
        action = 'REVIEW_SHOPIFY';
        recommendation = 'Item dari Shopify connector (bukan Jubelio). Konfirmasi: Shopify connector masih aktif? Kalau tidak, inactivate.';
    } else if (it.bucket === 'LEGACY_INVENTORY') {
        action = 'INACTIVATE_OR_KEEP';
        recommendation = 'Legacy Inventory tanpa padanan Jubelio — kemungkinan barang lama / sudah tidak dijual. Konfirmasi finance lalu inactivate.';
    } else if (/copy$/i.test(it.name)) {
        action = 'INACTIVATE_COPY';
        recommendation = `Item duplikat (suffix "copy") — redirect invoice lines ke item asli lalu inactivate.`;
    } else if (it.bucket === 'AMBIGUOUS_SERVICE') {
        action = 'REVIEW_MANUAL';
        recommendation = 'Service tanpa SKU & tanpa padanan Jubelio — cek apakah masih dipakai. Kalau tidak, inactivate.';
    } else {
        action = 'REVIEW_MANUAL';
        recommendation = 'Tidak ada padanan Jubelio — review manual.';
    }
    return { qbo: it, matchedTo: null, action, recommendation };
});

// ── Aggregate stats ─────────────────────────────────────────────────────────
const summary = {
    jubelio: {
        totalVariants: jubVariants.length,
        activeVariants: jubVariants.filter(v => v.source === 'active').length,
        archivedVariants: jubVariants.filter(v => v.source === 'archived').length,
        actions: {
            OK_AS_IS: jubelioReport.filter(r => r.action === 'OK_AS_IS').length,
            PATCH_QBO_ITEM: jubelioReport.filter(r => r.action === 'PATCH_QBO_ITEM').length,
            CONSOLIDATE_DUPLICATES: jubelioReport.filter(r => r.action === 'CONSOLIDATE_DUPLICATES').length,
            CREATE_QBO_ITEM: jubelioReport.filter(r => r.action === 'CREATE_QBO_ITEM').length,
        },
    },
    qbo: {
        total: qboItems.length,
        matched: qboReport.filter(r => r.action === 'MATCHED').length,
        orphans: qboReport.filter(r => r.action !== 'MATCHED').length,
        actions: qboReport.reduce((acc, r) => {
            acc[r.action] = (acc[r.action] || 0) + 1;
            return acc;
        }, {}),
    },
};

const out = {
    generatedAt: new Date().toISOString(),
    summary,
    jubelioReport,
    qboReport,
};

const outPath = path.join(ROOT, 'qbo-jubelio-reconciliation.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`💾 ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
console.log('\n📊 SUMMARY');
console.log(JSON.stringify(summary, null, 2));

console.log('\n📋 PER-JUBELIO-VARIANT RECOMMENDATIONS:\n');
for (const r of jubelioReport) {
    const tag = `[${r.jubelio.source.toUpperCase()}]`;
    console.log(`${tag} ${r.jubelio.item_code.padEnd(20)} ${r.action}`);
    console.log(`  Jubelio: "${r.jubelio.item_name.slice(0, 60)}" (${r.jubelio.variation_label || '—'})`);
    if (r.qboCanonical) console.log(`  QBO: id=${r.qboCanonical.id} type=${r.qboCanonical.type} sku=${r.qboCanonical.sku || '—'} name="${r.qboCanonical.name.slice(0, 50)}"`);
    if (r.qboExtras.length > 0) console.log(`  Duplikat: ${r.qboExtras.map(e => `id=${e.id}`).join(', ')}`);
    console.log(`  → ${r.recommendation}\n`);
}

console.log('\n📋 QBO ORPHANS (no Jubelio match):\n');
for (const r of qboReport.filter(x => x.action !== 'MATCHED')) {
    console.log(`  [${r.qbo.id}] ${r.action.padEnd(22)} "${r.qbo.name.slice(0, 50)}" (${r.qbo.type}/${r.qbo.bucket})`);
    console.log(`     → ${r.recommendation}`);
}
