const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getQboInstance } = require('../services/qboService');
const { alertWebhookError, alertAuthRejected, sendTestAlert, isConfigured: alertsConfigured } = require('../services/alertService');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');

// Fire-and-forget: persist full webhook payload for later debugging. Logging
// failures MUST NOT block the actual sync flow — we swallow errors here.
const logJubelioPayload = (endpoint, body) => {
    if (!body || typeof body !== 'object') return;
    JubelioPayloadLog.create({
        endpoint,
        salesorder_id: body.salesorder_id,
        salesorder_no: body.salesorder_no,
        invoice_no: body.invoice_no,
        action: body.action,
        status: body.status,
        is_canceled: !!body.is_canceled,
        source_name: body.source_name || body.source,
        transaction_date_raw: body.transaction_date ? String(body.transaction_date) : undefined,
        created_date_raw: body.created_date ? String(body.created_date) : undefined,
        invoice_created_date_raw: body.invoice_created_date ? String(body.invoice_created_date) : undefined,
        payload: body,
    }).catch(e => console.warn(`⚠️ JubelioPayloadLog insert failed: ${e.message}`));
};

// ─── Jubelio Webhook Verification ───
// Confirmed via production log: Jubelio does NOT send a signature header on
// webhook callbacks (only Vercel infra x-* headers arrived). Their docs describe
// the SHA256(payload + secret) formula but don't specify the header name, and
// in practice the signature is absent. We fall back to URL-secrecy + optional
// checks:
//   JUBELIO_ENFORCE_SIGNATURE=1   — strict: require valid HMAC header (rejects all current Jubelio traffic — for future use if they start signing)
//   JUBELIO_ALLOWED_IPS=1.2.3.4,5.6.7.8  — allowlist of Jubelio source IPs (comma separated)
//   JUBELIO_WEBHOOK_SECRET        — still used if a signature header is present
const SIG_HEADER_CANDIDATES = [
    'x-hook-signature',
    'x-jubelio-signature',
    'x-jubelio-hmac-sha256',
    'x-signature',
    'x-hmac-sha256',
    'x-hub-signature-256',
    'x-hub-signature',
    'signature',
];

const stripPrefix = (s) => String(s).trim().replace(/^sha256=/i, '');

const ALLOWED_IPS = new Set(
    (process.env.JUBELIO_ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean)
);

// Returns { ok: boolean, reason: string }
const tryVerifyHmac = (req) => {
    const secret = process.env.JUBELIO_WEBHOOK_SECRET;
    if (!secret || !req.rawBody) return { ok: false, reason: 'no-secret-or-body' };

    const explicit = process.env.JUBELIO_SIGNATURE_HEADER?.toLowerCase();
    const headerNames = explicit ? [explicit, ...SIG_HEADER_CANDIDATES] : SIG_HEADER_CANDIDATES;
    const candidates = [];
    for (const h of headerNames) {
        const v = req.headers[h];
        if (v) candidates.push({ header: h, value: stripPrefix(v) });
    }
    if (candidates.length === 0) return { ok: false, reason: 'no-header' };

    const raw = req.rawBody.toString('utf8');
    const hash = crypto.createHash('sha256').update(raw + secret).digest();
    const hex = hash.toString('hex');
    const b64 = hash.toString('base64');
    const timingSafe = (a, b) => {
        const A = Buffer.from(a, 'utf8');
        const B = Buffer.from(b, 'utf8');
        return A.length === B.length && crypto.timingSafeEqual(A, B);
    };
    for (const c of candidates) {
        if (timingSafe(c.value, hex) || timingSafe(c.value, b64)) {
            return { ok: true, reason: `matched on ${c.header}` };
        }
    }
    return { ok: false, reason: 'mismatch' };
};

const checkJubelioRequest = (req) => {
    // 1. HMAC check (if Jubelio ever starts sending signatures, we accept).
    const hmac = tryVerifyHmac(req);
    if (hmac.ok) {
        console.log(`🔐 HMAC verified (${hmac.reason})`);
        return true;
    }

    // 2. Strict mode: require HMAC to pass — reject otherwise.
    if (process.env.JUBELIO_ENFORCE_SIGNATURE === '1') {
        const xHeaders = Object.fromEntries(
            Object.entries(req.headers).filter(([k]) => k.toLowerCase().startsWith('x-') || k.toLowerCase() === 'signature')
        );
        console.error(`🔐 ENFORCE mode, HMAC failed (${hmac.reason}). x-* headers:`, JSON.stringify(xHeaders));
        return false;
    }

    // 3. IP allowlist (if configured).
    if (ALLOWED_IPS.size > 0) {
        const candidateIps = [
            req.headers['x-forwarded-for'],
            req.headers['x-real-ip'],
            req.headers['x-vercel-forwarded-for'],
            req.ip,
        ].flatMap(v => String(v || '').split(',').map(s => s.trim())).filter(Boolean);
        const match = candidateIps.find(ip => ALLOWED_IPS.has(ip));
        if (match) {
            console.log(`🌐 IP allowlist OK (${match})`);
            return true;
        }
        console.error(`🌐 IP not in allowlist. candidates=${JSON.stringify(candidateIps)}`);
        return false;
    }

    // 4. Fallback: accept by URL secrecy (the current Jubelio behaviour is no-sig).
    console.warn(`⚠️ Webhook accepted via URL-secrecy (HMAC ${hmac.reason}). Set JUBELIO_ALLOWED_IPS for extra safety.`);
    return true;
};

// Backward-compatible alias used by route handlers below.
const verifyJubelioSignature = checkJubelioRequest;

// Invoice term days by channel prefix di salesorder_no.
//   CS (Consignment) → Net 7
//   SP/TP/SHF/LB/DP/DW/... (semua selain CS) → Net 14
const getSoPrefix = (so) => {
    const m = String(so.salesorder_no || '').match(/^([A-Z]{2,5})-/);
    return m ? m[1] : '';
};
const getTermDays = (so) => {
    const prefix = getSoPrefix(so);
    return prefix === 'CS' ? 7 : 14;
};
// Jubelio sends `transaction_date` etc. as ISO UTC strings. Naively taking
// `substring(0, 10)` returns the UTC date — which is "yesterday" for any
// timestamp between 17:00 WIB and 23:59 WIB (the UTC day rollover happens at
// 07:00 WIB). Always project to Asia/Jakarta (UTC+7) before formatting.
const JKT_OFFSET_MS = 7 * 60 * 60 * 1000;
const isoDateJakarta = (raw) => {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const s = String(raw).trim();
    if (!s || s === '-') return undefined;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s.substring(0, 10);
    return new Date(d.getTime() + JKT_OFFSET_MS).toISOString().substring(0, 10);
};
const addDays = (isoDate, days) => {
    const d = new Date(isoDate);
    if (Number.isNaN(d.getTime())) return undefined;
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().substring(0, 10);
};

const INVOICE_MEMO = `Crafted with care and passion, each product is a testament to our dedication to premium quality and ethical practices.

Thank you for choosing Treelogy!`;

// ─── QBO Error Helper ───
const extractQboError = (err, body) => {
    if (body?.Fault?.Error) return body.Fault.Error.map(e => `${e.Message} - ${e.Detail}`).join('; ');
    if (err?.Fault?.Error) return err.Fault.Error.map(e => `${e.Message} - ${e.Detail}`).join('; ');
    if (err?.response?.data?.Fault?.Error) return err.response.data.Fault.Error.map(e => `${e.Message} - ${e.Detail}`).join('; ');
    if (err?.response?.data) return JSON.stringify(err.response.data);
    return err?.message || String(err);
};

// ─── QBO Metadata Cache ───
let _cachedTaxCodeId = null;
let _cachedIncomeAccountId = null;

const getDefaultTaxCode = (qbo) => {
    if (process.env.QBO_TAX_CODE) return Promise.resolve(process.env.QBO_TAX_CODE);
    if (_cachedTaxCodeId) return Promise.resolve(_cachedTaxCodeId);
    return new Promise((resolve) => {
        qbo.findTaxCodes([], (err, body) => {
            const codes = body?.QueryResponse?.TaxCode;
            if (codes && codes.length > 0) {
                const zeroRate = codes.find(c =>
                    c.Active !== false && (
                        /free|exempt|zero|nil|none|nol|bebas/i.test(c.Name) ||
                        c.Name === 'FRE' || c.Name === 'Z' || c.Name === 'NON'
                    )
                );
                _cachedTaxCodeId = zeroRate ? String(zeroRate.Id) : String(codes[0].Id);
            } else {
                _cachedTaxCodeId = null;
            }
            resolve(_cachedTaxCodeId);
        });
    });
};

const getIncomeAccountId = (qbo) => {
    if (process.env.QBO_INCOME_ACCOUNT_ID) return Promise.resolve(process.env.QBO_INCOME_ACCOUNT_ID);
    if (_cachedIncomeAccountId) return Promise.resolve(_cachedIncomeAccountId);
    return new Promise((resolve) => {
        qbo.findAccounts(
            [{ field: 'AccountType', value: 'Income', operator: '=' }],
            (err, body) => {
                const accounts = body?.QueryResponse?.Account;
                if (accounts && accounts.length > 0) {
                    const sales = accounts.find(a => /sales|revenue|pendapatan|penjualan/i.test(a.Name)) || accounts[0];
                    _cachedIncomeAccountId = String(sales.Id);
                } else {
                    _cachedIncomeAccountId = null;
                }
                resolve(_cachedIncomeAccountId);
            }
        );
    });
};

// ─── Customer lookup (by email, then DisplayName, else create) ───
const findCustomersByField = (qbo, field, value) => withQboRetry('findCustomers', () => new Promise((resolve, reject) => {
    qbo.findCustomers([{ field, value, operator: '=' }], (err, body) => {
        if (err) return reject(new Error('findCustomers: ' + extractQboError(err, body)));
        resolve(body?.QueryResponse?.Customer || []);
    });
}));

// Tokopedia (and some other channels) redact customer/shipping names in
// webhook payloads for privacy — values look like "A*** y***nto". Detect
// these so we can fetch the unredacted form via Jubelio API directly.
const isRedactedName = (name) => /\*{2,}/.test(String(name || ''));

// In-memory cache for /sales/orders/{id} responses. Webhooks for the same SO
// re-fire often (status transitions, idempotency rejects, retries) — caching
// for 60s eliminates repeated outbound API hits without risking stale data.
const _soFetchCache = new Map(); // salesorder_id → { data, expiresAt }
const SO_FETCH_TTL_MS = 60_000;
let _jubelioApiModule = null;
const fetchUnredactedSo = async (salesorderId) => {
    if (!salesorderId) return null;
    const now = Date.now();
    const cached = _soFetchCache.get(salesorderId);
    if (cached && cached.expiresAt > now) return cached.data;
    if (!_jubelioApiModule) _jubelioApiModule = require('../services/jubelioApiService');
    if (!_jubelioApiModule.isConfigured()) return null;
    try {
        const res = await _jubelioApiModule.getOrderDetail(salesorderId);
        // Endpoint returns { data: {...} } in some cases, full object in others
        const data = res?.data || res;
        _soFetchCache.set(salesorderId, { data, expiresAt: now + SO_FETCH_TTL_MS });
        // Cap cache size — drop expired entries when over 200 keys
        if (_soFetchCache.size > 200) {
            for (const [k, v] of _soFetchCache) if (v.expiresAt < now) _soFetchCache.delete(k);
        }
        return data;
    } catch (e) {
        console.warn(`⚠️ fetchUnredactedSo(${salesorderId}) failed: ${e.message?.slice(0, 200)}`);
        return null;
    }
};

// Strip channel prefix from customer DisplayName so dedup catches both
// "TP - Adha Yuwanto" and "Adha Yuwanto" as the same person.
const stripCustomerChannelPrefix = (name) =>
    String(name || '').replace(/^\s*(SP|TP|SHF|LB|CS|DP|DW|WX|D)\s*-\s*/i, '').trim();

const buildShipAddr = (so) => {
    if (!so.shipping_address && !so.shipping_city) return undefined;
    return {
        Line1: so.shipping_full_name || so.customer_name || undefined,
        Line2: so.shipping_address || undefined,
        City: so.shipping_city || undefined,
        CountrySubDivisionCode: so.shipping_province || undefined,
        PostalCode: so.shipping_post_code ? String(so.shipping_post_code) : undefined,
        Country: so.shipping_country || undefined,
    };
};

const getOrCreateCustomer = async (qbo, so) => {
    let email = so.customer_email;
    let phone = so.customer_phone;
    let displayName = (so.customer_name || 'Jubelio Customer').trim().substring(0, 100);
    let shipFullName = so.shipping_full_name;
    let shipAddr = buildShipAddr(so);

    // Tokopedia & some channels redact customer info in webhook payloads.
    // When detected, fetch the unredacted form from Jubelio API directly.
    // Cached + graceful fallback so the webhook never fails on this path.
    if (isRedactedName(displayName) && so.salesorder_id) {
        const fullSo = await fetchUnredactedSo(so.salesorder_id);
        if (fullSo) {
            const realName = String(fullSo.customer_name || fullSo.shipping_full_name || '').trim();
            if (realName && !isRedactedName(realName)) {
                console.log(`🔓 Unredacted customer: "${displayName}" → "${realName}" (SO ${so.salesorder_id})`);
                displayName = realName.substring(0, 100);
                email = email || fullSo.customer_email || null;
                phone = phone || fullSo.customer_phone || null;
                shipFullName = shipFullName || fullSo.shipping_full_name;
                if (!shipAddr) shipAddr = buildShipAddr(fullSo);
            }
        }
        // If still redacted after fetch, we proceed with the redacted name —
        // worst case is consistent grouping under the placeholder, which is
        // strictly better than failing the webhook outright.
    }

    // 1. Match by email (most specific identifier).
    if (email) {
        const byEmail = await findCustomersByField(qbo, 'PrimaryEmailAddr', email);
        if (byEmail.length > 0) return byEmail[0].Id;
    }

    // 2. Multi-variant DisplayName lookup. Reduces duplicate creation when
    // QBO already has the customer under a different naming convention
    // (with/without channel prefix). Try most specific first.
    const variants = [];
    const seen = new Set();
    const addVariant = (v) => {
        const trimmed = String(v || '').trim().substring(0, 100);
        if (trimmed && !seen.has(trimmed.toLowerCase())) {
            seen.add(trimmed.toLowerCase());
            variants.push(trimmed);
        }
    };
    addVariant(displayName);
    const stripped = stripCustomerChannelPrefix(displayName);
    if (stripped !== displayName) addVariant(stripped);
    const prefix = getSoPrefix(so);
    if (prefix && !displayName.toUpperCase().startsWith(`${prefix} -`)) {
        addVariant(`${prefix} - ${displayName}`);
        if (stripped !== displayName) addVariant(`${prefix} - ${stripped}`);
    }

    for (const v of variants) {
        const byName = await findCustomersByField(qbo, 'DisplayName', v);
        if (byName.length > 0) {
            if (v !== displayName) {
                console.log(`✅ Customer match by variant "${v}" (asked "${displayName}") → id=${byName[0].Id}`);
            }
            return byName[0].Id;
        }
    }

    // 3. Create new customer; recover existing Id on race-induced duplicate.
    return withQboRetry('createCustomer', () => new Promise((resolve, reject) => {
        const payload = {
            DisplayName: displayName,
            GivenName: displayName.split(' ')[0] || 'Jubelio',
            FamilyName: displayName.split(' ').slice(1).join(' ') || 'Customer',
        };
        if (email) payload.PrimaryEmailAddr = { Address: email };
        if (phone) payload.PrimaryPhone = { FreeFormNumber: String(phone) };
        if (shipAddr) {
            payload.ShipAddr = shipAddr;
            payload.BillAddr = shipAddr; // Jubelio only exposes shipping address — use as billing too.
        }
        qbo.createCustomer(payload, (errC, bodyC) => {
            if (errC) {
                const detail = extractQboError(errC, bodyC);
                // Race recovery: another concurrent webhook just created this name.
                const dupMatch = /Id=(\d+)/i.exec(detail);
                if (dupMatch) {
                    console.log(`ℹ️ Customer "${displayName}" sudah ada (id=${dupMatch[1]}) — race-recovered.`);
                    return resolve(dupMatch[1]);
                }
                return reject(new Error('createCustomer: ' + detail));
            }
            console.log(`✅ Customer baru: ${bodyC.Id} (${displayName})`);
            resolve(bodyC.Id);
        });
    }));
};

// QBO Item Name rules: max 100 chars, cannot contain `:`, must be unique.
// Jubelio item names can have `/`, parens, Indonesian words — usually fine
// after stripping colons and collapsing whitespace.
// Strip leading brand prefix from item names. Jubelio products carry the brand
// in item_name (e.g. "TREELOGY Premium Organic..."), but in QBO we want just
// the product portion since the brand is implicit (single-tenant). Handles
// "Treelogy" lowercase too and absorbs trailing separators like ` | ` ` - `.
const stripBrandPrefix = (s) => String(s || '').replace(/^\s*TREELOGY\b[\s|,\-]*/i, '').trim();

const sanitizeItemName = (raw) => {
    const cleaned = stripBrandPrefix(String(raw || ''))
        .replace(/:/g, '-')        // colons are hard-forbidden in QBO item names
        .replace(/[\u0000-\u001F]/g, '')  // control chars
        .replace(/\s+/g, ' ')
        .replace(/'/g, '')
        .trim();
    return cleaned.substring(0, 100);
};

// ─── Item lookup (by item_code → item_name → generic fallback) ───
let _genericItemId = null;
const getGenericItem = async (qbo, incomeAccountId) => {
    if (_genericItemId) return _genericItemId;
    const NAME = 'Jubelio Sync Item';
    try {
        const q = encodeURIComponent(`SELECT * FROM Item WHERE Name = '${NAME}'`);
        const found = await qboFetch(qbo, `/query?query=${q}`);
        const existing = found?.QueryResponse?.Item?.[0];
        if (existing) { _genericItemId = existing.Id; return _genericItemId; }
        if (!incomeAccountId) return null;
        const created = await qboFetch(qbo, '/item', {
            method: 'POST',
            body: JSON.stringify({
                Name: NAME,
                Type: 'Service',
                IncomeAccountRef: { value: incomeAccountId },
            }),
        });
        _genericItemId = created?.Item?.Id || null;
        if (_genericItemId) console.log(`✅ Generic Item dibuat: ${NAME} (ID: ${_genericItemId})`);
        return _genericItemId;
    } catch (e) {
        console.log(`⚠️ getGenericItem gagal: ${e.message}`);
        return null;
    }
};

// QBO Item types that can be used as Invoice line items.
// "Category" is organizational-only and will cause createInvoice to fail with
// "Invalid Reference Id : An item in this transaction is set up as a category
// instead of a product or service." — must be skipped on lookup.
const SAFE_ITEM_TYPES = new Set(['Service', 'Inventory', 'NonInventory']);

const qboFindItemsByField = (qbo, field, value) => new Promise((resolve) => {
    qbo.findItems([{ field, value, operator: '=' }], (err, body) => {
        if (err) return resolve([]);
        resolve(body?.QueryResponse?.Item || []);
    });
});
const qboFindItemsByName = (qbo, name) => qboFindItemsByField(qbo, 'Name', name);
const qboFindItemsBySku = (qbo, sku) => qboFindItemsByField(qbo, 'Sku', sku);

const qboGetItemType = (qbo, id) => new Promise((resolve) => {
    qbo.getItem(id, (err, body) => resolve(err ? null : (body?.Type || null)));
});

// Item resolution strategy (priority order):
//   1. SKU match — Jubelio item_code matches QBO Item.Sku → use existing
//      (most reliable: SKU is the canonical cross-system product identifier)
//   2. Name match — sanitized full item_name matches QBO Item.Name → use existing
//      (lets pre-existing Inventory items in QBO get reused without retyping)
//   3. Create new Service with Name=full_name, Sku=item_code, Description=full_name
//   4. On Category/duplicate collision: try variant "<name> (<code>)" then "(Service)"
//   5. Generic fallback "Jubelio Sync Item" only if every name attempt fails
const getOrCreateItem = async (qbo, item, incomeAccountId) => {
    const itemCode = String(item.item_code || '').trim();
    const fullName = sanitizeItemName(item.item_name || item.description || '') || itemCode || 'Jubelio Item';
    const description = String(item.item_name || item.description || '').trim().substring(0, 4000);

    // 1) SKU lookup — match existing QBO Inventory/Service by Sku field.
    if (itemCode) {
        const bySku = await qboFindItemsBySku(qbo, itemCode);
        const usable = bySku.find(i => SAFE_ITEM_TYPES.has(i.Type));
        if (usable) {
            console.log(`✅ Item match by SKU="${itemCode}" → existing id=${usable.Id} name="${usable.Name}" type=${usable.Type}`);
            return usable.Id;
        }
    }

    // 2) Name lookup — match existing QBO item by full sanitized name.
    if (fullName) {
        const byName = await qboFindItemsByName(qbo, fullName);
        const usable = byName.find(i => SAFE_ITEM_TYPES.has(i.Type));
        if (usable) {
            // Lazy Sku backfill: when an existing QBO item matches by Name but
            // has no Sku populated (created manually or by pre-SKU integration
            // version), persist the Jubelio item_code as Sku so the NEXT
            // webhook for this product can resolve via the SKU lookup above —
            // robust even if Jubelio later tweaks the marketing name.
            //
            // VARIANT GUARD: only backfill when Sku is empty. If the Item
            // already has a different Sku, this is likely a multi-variant
            // product (one Jubelio name shared by multiple sizes) and we must
            // not overwrite — leave the variant collision for manual triage.
            if (itemCode && !usable.Sku) {
                try {
                    await new Promise((resolve) => {
                        qbo.updateItem({
                            Id: String(usable.Id),
                            SyncToken: String(usable.SyncToken),
                            sparse: true,
                            Sku: itemCode,
                        }, (err) => {
                            if (err) {
                                console.log(`⚠️ Sku backfill failed Item ${usable.Id}: ${extractQboError(err)?.slice(0, 200)}`);
                            } else {
                                console.log(`🏷️  Backfilled Sku="${itemCode}" on Item ${usable.Id}`);
                            }
                            resolve();
                        });
                    });
                } catch (e) {
                    // Never block sync on backfill error
                    console.log(`⚠️ Sku backfill exception Item ${usable.Id}: ${e.message?.slice(0, 200)}`);
                }
            }
            console.log(`✅ Item match by Name="${fullName}" → existing id=${usable.Id} type=${usable.Type}`);
            return usable.Id;
        }
    }

    // 3) Create new. Use full name as primary, fall back to suffixed variants
    // if we hit Category collision or duplicate-name errors.
    if (!incomeAccountId) {
        console.log(`⚠️ Item "${fullName}" tidak ada & tidak bisa auto-create (no income account)`);
        return null;
    }

    const candidates = [
        fullName,
        itemCode && fullName !== itemCode ? sanitizeItemName(`${fullName} (${itemCode})`) : null,
        sanitizeItemName(`${fullName} (Service)`),
    ].filter(Boolean);

    for (const lookupName of candidates) {
        // Re-check by name in case a parallel webhook created it between our
        // initial lookup and this attempt.
        const found = await qboFindItemsByName(qbo, lookupName);
        const usable = found.find(i => SAFE_ITEM_TYPES.has(i.Type));
        if (usable) {
            console.log(`✅ Item raced & found existing "${lookupName}" id=${usable.Id}`);
            return usable.Id;
        }
        if (found.some(i => i.Type === 'Category')) {
            console.log(`⚠️ Item name "${lookupName}" bentrok dengan Category — coba variant berikutnya`);
            continue;
        }

        const payload = {
            Name: lookupName,
            Type: 'Service',
            IncomeAccountRef: { value: incomeAccountId },
            UnitPrice: Number(item.sell_price || item.price) || 0,
        };
        if (itemCode) payload.Sku = itemCode;
        if (description) payload.Description = description;

        const { errC, bodyC } = await new Promise((resolve) => {
            qbo.createItem(payload, (e, b) => resolve({ errC: e, bodyC: b }));
        });
        if (!errC) {
            console.log(`✅ Item created: "${lookupName}" sku="${itemCode}" id=${bodyC.Id}`);
            return bodyC.Id;
        }

        const detail = extractQboError(errC, bodyC);
        const dupMatch = /Id=(\d+)/i.exec(detail);
        if (dupMatch) {
            const existingId = dupMatch[1];
            const existingType = await qboGetItemType(qbo, existingId);
            if (existingType && SAFE_ITEM_TYPES.has(existingType)) {
                console.log(`ℹ️ Item "${lookupName}" sudah ada (id=${existingId} type=${existingType}) — pakai existing.`);
                return existingId;
            }
            console.log(`⚠️ Item "${lookupName}" bentrok dengan ${existingType || 'unknown'} (id=${existingId}) — coba variant berikutnya`);
            continue;
        }

        console.log(`⚠️ createItem gagal "${lookupName}": ${detail}`);
        break;
    }

    console.log(`⚠️ Semua nama kandidat gagal untuk item "${fullName}" sku="${itemCode}" — fallback ke generic item`);
    return await getGenericItem(qbo, incomeAccountId);
};

// ─── Build QBO Invoice Line array from Jubelio SO ───
// Per Jubelio spec (openapijubelio.md):
//   items[].disc        = discount % (number)
//   items[].disc_amount = discount in IDR (number)
//   items[].amount      = already has disc_amount subtracted
// We embed discount info in Description so audit trail is visible in QBO.
const buildLines = async (qbo, so, taxCodeId, incomeAccountId) => {
    const lines = [];
    const items = Array.isArray(so.items) ? so.items : [];
    const serviceDate = isoDateJakarta(so.transaction_date);

    for (const it of items) {
        const qty = Number(it.qty_in_base ?? it.qty ?? 1) || 1;
        const price = Number(it.sell_price ?? it.price ?? 0) || 0;
        const discPct = Number(it.disc ?? 0) || 0;
        const discAmt = Number(it.disc_amount ?? 0) || 0;
        const gross = qty * price;
        const lineAmount = Number(it.amount ?? (gross - discAmt));
        const jubelioAmount = Math.round(lineAmount * 100) / 100;
        // QBO hard-validates Amount == Qty * UnitPrice on each line. We round
        // UnitPrice to 2 decimals, then recompute Amount from the rounded unit
        // price so the invariant ALWAYS holds. This may sacrifice up to 0.01
        // per line on non-evenly-divisible cases (e.g. 336100/3) — acceptable
        // trade-off since QBO would otherwise reject the invoice outright.
        const effectiveUnitPrice = qty > 0 ? Math.round((jubelioAmount / qty) * 100) / 100 : jubelioAmount;
        const amount = Math.round((effectiveUnitPrice * qty) * 100) / 100;
        if (Math.abs(amount - jubelioAmount) >= 0.01) {
            console.log(`⚠️ Line amount adjusted ${jubelioAmount} → ${amount} (QBO precision for qty=${qty})`);
        }

        const itemId = await getOrCreateItem(qbo, it, incomeAccountId);
        const detail = { Qty: qty, UnitPrice: effectiveUnitPrice };
        if (itemId) detail.ItemRef = { value: itemId };
        if (taxCodeId) detail.TaxCodeRef = { value: taxCodeId };
        if (serviceDate) detail.ServiceDate = serviceDate;

        let description = it.description || it.item_name || it.item_code || '';
        if (discAmt > 0 || discPct > 0) {
            const parts = [];
            if (discPct > 0) parts.push(`${discPct}%`);
            if (discAmt > 0) parts.push(`Rp${discAmt.toLocaleString('id-ID')}`);
            const original = `@Rp${price.toLocaleString('id-ID')}`;
            description = `${description} [${original} · disc: ${parts.join(' / ')}]`.trim();
        }

        lines.push({
            Description: description.substring(0, 4000),
            Amount: amount,
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: detail,
        });
    }

    // Shipping fee (if any) as extra line
    const shipping = Number(so.shipping_cost || 0);
    if (shipping > 0) {
        const detail = { Qty: 1, UnitPrice: shipping };
        if (taxCodeId) detail.TaxCodeRef = { value: taxCodeId };
        if (serviceDate) detail.ServiceDate = serviceDate;
        lines.push({
            Description: `Shipping (${so.courier || so.shipper || 'N/A'})`,
            Amount: Math.round(shipping * 100) / 100,
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: detail,
        });
    }

    return lines;
};

// ─── Raw QBO REST helpers (for entities node-quickbooks doesn't expose) ───
const qboBaseUrl = (qbo) => {
    const host = qbo.useSandbox ? 'sandbox-quickbooks.api.intuit.com' : 'quickbooks.api.intuit.com';
    return `https://${host}/v3/company/${qbo.realmId}`;
};

const qboFetch = async (qbo, path, opts = {}) => {
    const url = `${qboBaseUrl(qbo)}${path}${path.includes('?') ? '&' : '?'}minorversion=${qbo.minorversion || '65'}`;
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
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) {
        throw new Error(`QBO ${opts.method || 'GET'} ${path} (${res.status}): ${extractQboError(null, body)}`);
    }
    return body;
};

// QBO ShipMethod entity is NOT supported in QuickBooks Australia/UK editions
// (verified: QBO sandbox AU returns "Metadata not found for Entity: ShipMethod").
// So "Ship via" field cannot be populated programmatically on those editions —
// must be set manually in QBO UI. Courier info tetap visible di shipping line
// description + PrivateNote.
const _shipMethodCache = new Map();
const getOrCreateShipMethod = async (qbo, name) => {
    const clean = String(name || '').trim().substring(0, 31);
    if (!clean) return null;
    if (_shipMethodCache.has(clean)) return _shipMethodCache.get(clean);

    // Skip entirely if we already know this QBO region doesn't support it.
    if (_shipMethodCache.get('__UNSUPPORTED__')) return null;

    try {
        const escaped = clean.replace(/'/g, "\\'");
        const query = encodeURIComponent(`SELECT * FROM ShipMethod WHERE Name = '${escaped}'`);
        const found = await qboFetch(qbo, `/query?query=${query}`);
        const existing = found?.QueryResponse?.ShipMethod?.[0];
        if (existing) {
            _shipMethodCache.set(clean, existing.Id);
            return existing.Id;
        }
        const created = await qboFetch(qbo, '/shipmethod', {
            method: 'POST',
            body: JSON.stringify({ Name: clean, Active: true }),
        });
        const id = created?.ShipMethod?.Id;
        if (id) {
            _shipMethodCache.set(clean, id);
            console.log(`🚚 ShipMethod created: ${clean} (ID: ${id})`);
            return id;
        }
    } catch (err) {
        if (/Metadata not found for Entity: ShipMethod/i.test(err.message)) {
            console.warn('⚠️ ShipMethod entity tidak tersedia di QBO edition ini (AU/UK). Ship via akan kosong, isi manual di QBO UI.');
            _shipMethodCache.set('__UNSUPPORTED__', true);
        } else {
            console.log(`⚠️ ShipMethod '${clean}' gagal: ${err.message}`);
        }
    }
    return null;
};

// ─── Term (payment terms) find-or-create ───
const _termCache = new Map();
const getOrCreateTerm = (qbo, days) => new Promise((resolve) => {
    if (!days || days <= 0) return resolve(null);
    if (_termCache.has(days)) return resolve(_termCache.get(days));
    const name = `Net ${days}`;
    qbo.findTerms([{ field: 'Name', value: name, operator: '=' }], (err, body) => {
        const existing = body?.QueryResponse?.Term?.[0];
        if (!err && existing) {
            _termCache.set(days, existing.Id);
            return resolve(existing.Id);
        }
        qbo.createTerm({ Name: name, Type: 'STANDARD', DueDays: days, Active: true }, (errC, bodyC) => {
            if (errC) {
                const detail = extractQboError(errC, bodyC);
                // Reuse existing id if duplicate error surfaces it (like Item).
                const dup = /Id=(\d+)/i.exec(detail);
                if (dup) {
                    _termCache.set(days, dup[1]);
                    return resolve(dup[1]);
                }
                console.log(`⚠️ createTerm '${name}' gagal: ${detail}`);
                return resolve(null);
            }
            _termCache.set(days, bodyC.Id);
            console.log(`📅 Term created: ${name} (ID: ${bodyC.Id})`);
            resolve(bodyC.Id);
        });
    });
});

// Detects QBO throttle/transient errors that are safe to retry.
// QBO returns HTTP 429 + errorCode 003001 ("ThrottleExceeded"), and
// occasionally 5xx for transient platform issues.
const isRetryableQboError = (err) => {
    if (!err) return false;
    const msg = String(err.message || err);
    return /ThrottleExceeded|statusCode=429|errorCode=003001|"code":"?3001|"code":"?3002/i.test(msg)
        || /statusCode=5\d\d|HTTP 5\d\d|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
};

// Wraps a QBO call with exponential-backoff retry on throttle/transient errors.
// Attempts: 1, 2, 3, 4 → waits 1s, 2s, 4s between (plus ±300ms jitter).
const withQboRetry = async (label, fn, { maxAttempts = 4, baseDelayMs = 1000 } = {}) => {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (attempt < maxAttempts && isRetryableQboError(err)) {
                const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 300);
                console.warn(`⏳ QBO retry ${label} attempt ${attempt}/${maxAttempts} (wait ${delay}ms): ${String(err.message).slice(0, 120)}`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
};

// ─── Promisified QBO helpers (all wrapped with throttle-aware retry) ───
const qboGetInvoice = (qbo, id) => withQboRetry('getInvoice', () => new Promise((resolve, reject) => {
    qbo.getInvoice(id, (err, body) => err ? reject(new Error('getInvoice: ' + extractQboError(err, body))) : resolve(body));
}));
const qboCreateInvoice = (qbo, payload) => withQboRetry('createInvoice', () => new Promise((resolve, reject) => {
    qbo.createInvoice(payload, (err, body) => err ? reject(new Error('createInvoice: ' + extractQboError(err, body))) : resolve(body));
}));
const qboUpdateInvoice = (qbo, payload) => withQboRetry('updateInvoice', () => new Promise((resolve, reject) => {
    qbo.updateInvoice(payload, (err, body) => err ? reject(new Error('updateInvoice: ' + extractQboError(err, body))) : resolve(body));
}));
const qboVoidInvoice = (qbo, id) => withQboRetry('voidInvoice', () => new Promise((resolve, reject) => {
    qbo.voidInvoice(id, (err, body) => err ? reject(new Error('voidInvoice: ' + extractQboError(err, body))) : resolve(body));
}));
const qboCreatePayment = (qbo, payload) => withQboRetry('createPayment', () => new Promise((resolve, reject) => {
    qbo.createPayment(payload, (err, body) => err ? reject(new Error('createPayment: ' + extractQboError(err, body))) : resolve(body));
}));
const qboFindPayments = (qbo, criteria) => withQboRetry('findPayments', () => new Promise((resolve, reject) => {
    qbo.findPayments(criteria, (err, body) => err ? reject(new Error('findPayments: ' + extractQboError(err, body))) : resolve(body?.QueryResponse?.Payment || []));
}));

// Retry on QBO "stale SyncToken" when two webhooks for the same SO race.
const STALE_TOKEN_RE = /stale|synctoken|object version|out[- ]of[- ]date/i;
const qboUpdateInvoiceSafe = async (qbo, invoiceId, mutatePayload) => {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        const current = await qboGetInvoice(qbo, invoiceId);
        try {
            return await qboUpdateInvoice(qbo, {
                ...mutatePayload(current),
                Id: invoiceId,
                SyncToken: current.SyncToken,
                sparse: true,
            });
        } catch (err) {
            lastErr = err;
            if (attempt < 3 && STALE_TOKEN_RE.test(err.message)) {
                console.warn(`⚠️ SyncToken stale invoice ${invoiceId}, retry ${attempt}/3`);
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
};

// Paid statuses from Jubelio SO that should auto-mark the QBO invoice paid.
const PAID_STATUSES = new Set(['PAID', 'COMPLETED']);

// Only sync to QBO once the SO has SHIPPED (courier, tracking_no, shipped_date
// are populated). Earlier statuses (PENDING, INVOICED, PAID, PROCESSING) are
// acknowledged but skipped so the final invoice has complete data.
// Override via env JUBELIO_SYNC_STATUSES=SHIPPED,COMPLETED (comma list).
const SYNC_STATUSES = new Set(
    (process.env.JUBELIO_SYNC_STATUSES || 'SHIPPED,COMPLETED')
        .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
);

// Prefix-based bypass: direct-sale channels (La Brisa, Consignment, WhatsApp,
// Walk-in) have no courier shipping flow, so sync immediately regardless of
// status. Marketplace channels (SP Shopee, TP Tokopedia) still gate on
// SYNC_STATUSES because they carry courier/tracking data. Override via env
// JUBELIO_BYPASS_STATUS_PREFIXES.
const BYPASS_STATUS_PREFIXES = new Set(
    (process.env.JUBELIO_BYPASS_STATUS_PREFIXES || 'LB,CS,DP,DW')
        .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
);

const markQboInvoicePaid = async (qbo, invoice, customerId, so) => {
    const invoiceId = String(invoice.Id);
    const balance = Number(invoice.Balance ?? invoice.TotalAmt ?? 0);
    if (balance <= 0) {
        console.log(`ℹ️ Invoice ${invoiceId} sudah 0 balance — skip payment.`);
        return null;
    }

    // Idempotency: scan recent payments for this customer; skip if one already links this invoice.
    const payments = await qboFindPayments(qbo, [
        { field: 'CustomerRef', value: String(customerId), operator: '=' },
    ]);
    const alreadyLinked = payments.some(p =>
        (p.Line || []).some(l => (l.LinkedTxn || []).some(t => String(t.TxnId) === invoiceId && t.TxnType === 'Invoice'))
    );
    if (alreadyLinked) {
        console.log(`ℹ️ Payment untuk invoice ${invoiceId} sudah ada — skip.`);
        return null;
    }

    // Reuse the invoice DocNumber on the Payment so the QBO Sales transactions
    // list shows a meaningful "NO." instead of an empty cell. QBO Payment
    // DocNumber is freeform string, doesn't need to be unique across types.
    const paymentDocNumber = (invoice.DocNumber || String(so.salesorder_no || '').substring(0, 21)) || undefined;

    const payload = {
        CustomerRef: { value: String(customerId) },
        TotalAmt: balance,
        TxnDate: isoDateJakarta(so.transaction_date),
        DocNumber: paymentDocNumber,
        PrivateNote: `Auto-paid from Jubelio SO #${so.salesorder_no} status=${so.status}`,
        Line: [{
            Amount: balance,
            LinkedTxn: [{ TxnId: invoiceId, TxnType: 'Invoice' }],
        }],
    };
    const created = await qboCreatePayment(qbo, payload);
    console.log(`💰 Payment created: ${created.Id} for invoice ${invoiceId} (${balance})`);
    return created;
};

// ─── Upsert Invoice ───
const upsertQboInvoice = async (qbo, so, realmId) => {
    // Idempotency guard: Jubelio re-fires webhooks multiple times for the same
    // final-state SO (status transitions, tracking updates, escrow changes).
    // If status + grand_total + transaction_date are identical to last sync,
    // QBO state is already correct — skip the update. Also sidesteps QBO AST
    // validator rejecting redundant sparse updates with "sales tax rate" errors.
    const existing = await JubelioOrderMap.findOne({ salesorder_id: so.salesorder_id, qbo_realm_id: realmId });
    if (existing) {
        const sameStatus = existing.last_status === so.status;
        const sameTotal = Number(existing.last_grand_total) === Number(so.grand_total);
        const incomingRaw = so.transaction_date ? String(so.transaction_date) : null;
        const sameTxnDate = (existing.last_transaction_date_raw || null) === incomingRaw;
        if (sameStatus && sameTotal && sameTxnDate) {
            console.log(`ℹ️ SO ${so.salesorder_no} tidak berubah (status=${so.status} total=${so.grand_total}) — skip QBO update.`);
            await JubelioOrderMap.updateOne({ _id: existing._id }, { last_synced_at: new Date() });
            return {
                action: 'skipped',
                invoice: { Id: existing.qbo_invoice_id, DocNumber: existing.qbo_doc_number },
                customerId: null,
            };
        }
    }

    const [taxCodeId, incomeAccountId] = await Promise.all([
        getDefaultTaxCode(qbo),
        getIncomeAccountId(qbo),
    ]);

    const customerId = await getOrCreateCustomer(qbo, so);
    const lines = await buildLines(qbo, so, taxCodeId, incomeAccountId);

    if (lines.length === 0) {
        throw new Error('Jubelio SO tidak punya items — tidak bisa buat Invoice.');
    }

    const txnDate = isoDateJakarta(so.transaction_date);
    if (so.transaction_date) {
        console.log(`📅 SO ${so.salesorder_no} transaction_date raw="${so.transaction_date}" → TxnDate=${txnDate}`);
    }
    const termDays = getTermDays(so);
    const dueDate = txnDate ? addDays(txnDate, termDays) : undefined;
    const shipAddr = buildShipAddr(so);
    const courier = so.courier || so.shipper;
    // Invoice # = No Pesanan Jubelio (salesorder_no), bukan invoice_no internal.
    // QBO DocNumber default max 21 chars — enable "Custom transaction numbers"
    // di QBO (Settings → Advanced → Sales form content) untuk support lebih panjang.
    const rawSoNo = String(so.salesorder_no || so.invoice_no || '');
    if (rawSoNo.length > 21) {
        console.warn(`⚠️ salesorder_no ${rawSoNo.length} chars > QBO DocNumber limit (21). Akan di-truncate. Enable "Custom transaction numbers" di QBO untuk support penuh.`);
    }
    const docNumber = rawSoNo.substring(0, 21) || undefined;
    // Shipping date fallback chain (Jubelio doesn't consistently fill shipped_date):
    //   shipped_date → tn_created_date (tracking no. issued) → mp_completed_date
    //   → completed_date → received_date
    // Treat "-" or "" as missing.
    const dateCandidates = [
        so.shipped_date,
        so.tn_created_date,
        so.mp_completed_date,
        so.completed_date,
        so.received_date,
    ].map(v => (v ? String(v).trim() : '')).filter(v => v && v !== '-');
    const validShipDate = isoDateJakarta(dateCandidates[0]);
    // Shopify and some other channels send a full URL as tracking_no
    // (e.g. "https://lionparcel.com/track/stt?q=11LP1776…"). QBO TrackingNum
    // max is 31 chars, so extract the actual tracking code from the URL.
    const normalizeTracking = (raw) => {
        if (!raw) return undefined;
        const s = String(raw).trim();
        if (!s || s === '-') return undefined;
        let code = s;
        if (/^https?:\/\//i.test(s)) {
            try {
                const u = new URL(s);
                code = u.searchParams.get('q')
                    || u.searchParams.get('no')
                    || u.searchParams.get('awb')
                    || u.searchParams.get('tracking')
                    || u.searchParams.get('tracking_no')
                    || u.pathname.split('/').filter(Boolean).pop()
                    || s;
            } catch { /* keep code = s */ }
        }
        return code.substring(0, 31) || undefined;
    };
    const trackingNum = normalizeTracking(so.tracking_no || so.tracking_number);
    const shipMethodId = courier ? await getOrCreateShipMethod(qbo, courier) : null;
    const termId = await getOrCreateTerm(qbo, termDays);
    console.log(`🧾 Invoice build: docNo=${docNumber || '-'} courier=${courier || '-'} shipMethodId=${shipMethodId || '-'} tracking=${trackingNum || '-'} shipDate=${validShipDate || '-'} termId=${termId || '-'} (Net${termDays})`);

    const privateParts = [
        `Jubelio SO #${so.salesorder_no} (id ${so.salesorder_id})`,
        `channel=${so.source_name || so.source || 'N/A'}`,
        `term=Net${termDays}`,
    ];
    if (courier) privateParts.push(`courier=${courier}`);

    const basePayload = {
        Line: lines,
        CustomerRef: { value: String(customerId) },
        DocNumber: docNumber,
        TxnDate: txnDate,
        DueDate: dueDate,
        // Tax=NO VAT. GlobalTaxCalculation=NotApplicable supaya QBO tidak kenakan tax apapun.
        GlobalTaxCalculation: 'NotApplicable',
        CustomerMemo: { value: INVOICE_MEMO },
        PrivateNote: privateParts.join(' · '),
    };
    if (termId) basePayload.SalesTermRef = { value: String(termId) };
    // Jubelio only exposes shipping address → pakai sebagai billing juga.
    if (shipAddr) {
        basePayload.BillAddr = shipAddr;
        basePayload.ShipAddr = shipAddr;
    }
    if (shipMethodId) {
        // Real ShipMethod entity exists (QBO US/others)
        basePayload.ShipMethodRef = { value: String(shipMethodId) };
    } else if (courier) {
        // Fallback (QBO AU etc): pass courier as free-text ShipMethodRef.
        // Some QBO editions accept name-only reference and display it in "Ship via".
        basePayload.ShipMethodRef = { value: courier, name: courier };
    }
    if (validShipDate) basePayload.ShipDate = validShipDate;
    if (trackingNum) basePayload.TrackingNum = trackingNum;

    // If QBO rejects ShipMethodRef (e.g. AU edition quirks), strip it and retry.
    const stripShipMethod = (p) => { const clone = { ...p }; delete clone.ShipMethodRef; return clone; };
    const isShipMethodErr = (msg) => /ShipMethod|ShipMethodRef|Ship Via|Invalid Reference/i.test(msg);

    if (existing) {
        console.log(`♻️ Update QBO Invoice ${existing.qbo_invoice_id} untuk SO ${so.salesorder_no}`);
        let updated;
        try {
            updated = await qboUpdateInvoiceSafe(qbo, existing.qbo_invoice_id, () => basePayload);
        } catch (err) {
            if (basePayload.ShipMethodRef && isShipMethodErr(err.message)) {
                console.warn(`⚠️ updateInvoice gagal karena ShipMethodRef — retry tanpa Ship via: ${err.message}`);
                updated = await qboUpdateInvoiceSafe(qbo, existing.qbo_invoice_id, () => stripShipMethod(basePayload));
            } else { throw err; }
        }
        await JubelioOrderMap.updateOne(
            { salesorder_id: so.salesorder_id, qbo_realm_id: realmId },
            {
                qbo_doc_number: updated.DocNumber,
                last_status: so.status,
                last_grand_total: so.grand_total,
                last_synced_at: new Date(),
                last_transaction_date_raw: so.transaction_date ? String(so.transaction_date) : null,
                last_txn_date: txnDate || null,
            }
        );
        return { action: 'updated', invoice: updated, customerId };
    }

    console.log(`🆕 Create QBO Invoice untuk SO ${so.salesorder_no}`);
    let created;
    try {
        created = await qboCreateInvoice(qbo, basePayload);
    } catch (err) {
        if (basePayload.ShipMethodRef && isShipMethodErr(err.message)) {
            console.warn(`⚠️ createInvoice gagal karena ShipMethodRef — retry tanpa Ship via: ${err.message}`);
            created = await qboCreateInvoice(qbo, stripShipMethod(basePayload));
        } else { throw err; }
    }
    await JubelioOrderMap.create({
        salesorder_id: so.salesorder_id,
        salesorder_no: so.salesorder_no,
        qbo_realm_id: realmId,
        qbo_invoice_id: String(created.Id),
        qbo_doc_number: created.DocNumber,
        last_status: so.status,
        last_grand_total: so.grand_total,
        last_synced_at: new Date(),
        last_transaction_date_raw: so.transaction_date ? String(so.transaction_date) : null,
        last_txn_date: txnDate || null,
    });
    return { action: 'created', invoice: created, customerId };
};

// Shared helper: void a QBO invoice by Jubelio SO identifier. Idempotent.
// Filters by current realm so sandbox mappings never get voided from production (and vice versa).
const voidMappedInvoice = async (qbo, query, reason) => {
    const scopedQuery = { ...query, qbo_realm_id: qbo.realmId };
    const mapping = await JubelioOrderMap.findOne(scopedQuery);
    if (!mapping) return { voided: false, reason: 'no-mapping' };
    if (mapping.last_status === 'VOIDED') {
        console.log(`ℹ️ Invoice ${mapping.qbo_invoice_id} sudah VOIDED — skip.`);
        return { voided: false, reason: 'already-voided', qbo_invoice_id: mapping.qbo_invoice_id };
    }
    await qboVoidInvoice(qbo, mapping.qbo_invoice_id);
    await JubelioOrderMap.updateOne(
        { _id: mapping._id },
        { last_status: 'VOIDED', last_synced_at: new Date() }
    );
    console.log(`🗑️ Void QBO Invoice ${mapping.qbo_invoice_id} (${reason}).`);
    return { voided: true, qbo_invoice_id: mapping.qbo_invoice_id };
};

// ─── Webhook: Pesanan / Sales Order (create, update, status change) ───
// Jubelio action examples: "update-salesorder"
// Full payload carries items, customer, shipping, totals — no extra fetch needed.
router.post('/pesanan', async (req, res) => {
    const t0 = Date.now();
    const reqId = `req_${t0.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const log = (msg) => console.log(`[${reqId}] ${msg}`);
    const warn = (msg) => console.warn(`[${reqId}] ${msg}`);
    const err = (msg) => console.error(`[${reqId}] ${msg}`);

    log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    log(`📥 [1/8] REQUEST RECEIVED POST /api/webhook/jubelio/pesanan`);
    log(`    ip=${req.headers['x-forwarded-for'] || req.ip} ua=${(req.headers['user-agent'] || '').slice(0, 60)}`);
    log(`    content-length=${req.headers['content-length'] || '?'} content-type=${req.headers['content-type'] || '?'}`);

    if (!verifyJubelioSignature(req)) {
        err(`🚫 [AUTH] Rejected — unauthorized`);
        alertAuthRejected({
            endpoint: 'POST /api/webhook/jubelio/pesanan',
            ip: req.headers['x-forwarded-for'] || req.ip,
            reason: 'signature verification failed',
        });
        return res.status(401).send('Unauthorized');
    }
    log(`🔓 [2/8] AUTH PASSED`);

    const payload = req.body || {};
    const statusUpper = String(payload.status || '').toUpperCase();
    log(`📦 [3/8] PAYLOAD action=${payload.action || '-'} SO=${payload.salesorder_no || '-'} id=${payload.salesorder_id || '-'} status=${statusUpper || '-'} canceled=${!!payload.is_canceled} items=${Array.isArray(payload.items) ? payload.items.length : 0} grandTotal=${payload.grand_total ?? '-'}`);
    try { log(`📋 PAYLOAD JSON: ${JSON.stringify(payload)}`); } catch { log('📋 PAYLOAD JSON: <stringify failed>'); }
    logJubelioPayload('pesanan', payload);

    try {
        if (!payload.salesorder_id) {
            warn(`⚠️ [VALIDATION] Missing salesorder_id — abort`);
            return res.status(400).send('Missing salesorder_id');
        }

        // Webhook payload carries all 167 fields we need (courier, tracking_no,
        // source_name, shipping address, items with disc_amount, etc.) — no
        // outbound API call required.
        const so = payload;
        const shouldVoid = !!payload.is_canceled;
        const prefix = getSoPrefix(so);
        const bypassStatus = BYPASS_STATUS_PREFIXES.has(prefix);
        const shouldSync = bypassStatus || SYNC_STATUSES.has(statusUpper);
        log(`🧭 [4/8] DECISION shouldVoid=${shouldVoid} shouldSync=${shouldSync} prefix=${prefix || '-'} bypassStatus=${bypassStatus} syncStatuses=[${[...SYNC_STATUSES].join(',')}]`);

        // Skip early (before QBO connect) if status hasn't matured. Saves latency
        // and avoids rate-limiting QBO for webhooks we'd drop anyway.
        if (!shouldVoid && !shouldSync) {
            log(`⏸️  [DONE-SKIP] SO ${so.salesorder_no} status=${statusUpper} — skip (waiting for ${[...SYNC_STATUSES].join('/')}) ${Date.now() - t0}ms`);
            return res.status(200).json({ ok: true, skipped: true, reason: 'waiting-for-status', status: statusUpper, reqId });
        }

        log(`🔌 [5/8] CONNECTING to QBO…`);
        const qbo = await getQboInstance();
        const realmId = qbo.realmId;
        log(`    ✅ QBO connected realmId=${realmId} env=${process.env.QBO_ENVIRONMENT || 'sandbox'}`);

        // Canceled SO: void the mapped invoice (if any) and we're done.
        if (shouldVoid) {
            log(`🗑️ [6/8] VOIDING mapped invoice (SO canceled)…`);
            const result = await voidMappedInvoice(
                qbo,
                { salesorder_id: payload.salesorder_id },
                `SO ${payload.salesorder_no} canceled: ${payload.cancel_reason || 'no-reason'}`,
            );
            log(`✅ [DONE-VOID] ${JSON.stringify(result)} duration=${Date.now() - t0}ms`);
            return res.status(200).json({ ok: true, canceled: true, reqId, ...result });
        }

        if (!Array.isArray(so.items) || so.items.length === 0) {
            warn(`⚠️ [VALIDATION] SO has no items — abort`);
            return res.status(400).send('SO has no items');
        }

        log(`🧾 [6/8] UPSERT QBO Invoice…`);
        const upserted = await upsertQboInvoice(qbo, so, realmId);
        log(`    ✅ Invoice ${upserted.action}: id=${upserted.invoice.Id} docNo=${upserted.invoice.DocNumber || '-'} total=${upserted.invoice.TotalAmt ?? '-'} balance=${upserted.invoice.Balance ?? '-'}`);

        // Auto-mark Paid when Jubelio status is PAID/COMPLETED.
        // Skipped upserts mean SO is unchanged from last sync — payment side is
        // already reconciled from the earlier webhook, no need to re-run.
        let payment = null;
        if (upserted.action === 'skipped') {
            log(`💰 [7/8] Upsert skipped (idempotent) — skip payment too.`);
        } else if (PAID_STATUSES.has(statusUpper)) {
            log(`💰 [7/8] Status ${statusUpper} — marking Invoice as PAID…`);
            payment = await markQboInvoicePaid(qbo, upserted.invoice, upserted.customerId, so);
            log(`    ✅ Payment created: id=${payment?.Id || '-'} amount=${payment?.TotalAmt ?? '-'}`);
        } else {
            log(`💰 [7/8] Status ${statusUpper} — skip payment (not in ${[...PAID_STATUSES].join('/')})`);
        }

        log(`🎉 [8/8] DONE action=${upserted.action} invoiceId=${upserted.invoice.Id} paymentId=${payment?.Id || '-'} duration=${Date.now() - t0}ms`);
        res.status(200).json({
            ok: true,
            action: upserted.action,
            qbo_invoice_id: String(upserted.invoice.Id),
            qbo_payment_id: payment ? String(payment.Id) : null,
            reqId,
        });
    } catch (error) {
        err(`❌ [FAIL] Jubelio → QBO: ${error.message}`);
        if (error.stack) err(error.stack.split('\n').slice(0, 6).join('\n'));
        if (error.intuit_tid || error.Fault) {
            err(`    intuit_tid=${error.intuit_tid || '-'} fault=${JSON.stringify(error.Fault || error.fault || {}).slice(0, 300)}`);
        }
        err(`    duration=${Date.now() - t0}ms`);
        alertWebhookError({
            endpoint: 'POST /api/webhook/jubelio/pesanan',
            reqId,
            payload: req.body,
            error,
            intuitTid: error.intuit_tid,
        });
        // 500 → Jubelio akan retry (up to 3x per docs)
        res.status(500).send(`Error: ${error.message}`);
    }
});

// ─── Webhook: Faktur / Invoice (create, edit, delete) ───
// Jubelio payload is minimal: { action, invoice_id, invoice_no, ref_no }
// ref_no = salesorder_no (link back to the SO already synced via /pesanan).
// Primary sync happens on /pesanan; /faktur mostly acknowledges, but handles
// delete by voiding the mapped QBO Invoice so QBO stays in sync.
router.post('/faktur', async (req, res) => {
    if (!verifyJubelioSignature(req)) {
        alertAuthRejected({
            endpoint: 'POST /api/webhook/jubelio/faktur',
            ip: req.headers['x-forwarded-for'] || req.ip,
            reason: 'signature verification failed',
        });
        return res.status(401).send('Unauthorized');
    }

    const { action, invoice_no, ref_no } = req.body || {};
    console.log(`📄 Jubelio /faktur: action=${action} invoice=${invoice_no} ref=${ref_no}`);
    try { console.log(`📋 /faktur PAYLOAD JSON: ${JSON.stringify(req.body || {})}`); } catch { console.log('📋 /faktur PAYLOAD JSON: <stringify failed>'); }
    logJubelioPayload('faktur', req.body || {});

    const isDelete = typeof action === 'string' && /delete/i.test(action);
    if (!isDelete) {
        return res.status(200).json({ ok: true, acknowledged: true });
    }

    if (!ref_no) {
        console.warn('⚠️ Faktur delete tanpa ref_no — skip.');
        return res.status(200).send('Skipped (no ref_no)');
    }

    try {
        const qbo = await getQboInstance();
        const result = await voidMappedInvoice(
            qbo,
            { salesorder_no: ref_no },
            `Jubelio Faktur ${invoice_no} deleted`,
        );
        res.status(200).json({ ok: true, ...result });
    } catch (error) {
        console.error('❌ /faktur delete error:', error.message);
        alertWebhookError({
            endpoint: 'POST /api/webhook/jubelio/faktur',
            reqId: `faktur_${Date.now().toString(36)}`,
            payload: { salesorder_no: ref_no, action, invoice_no },
            error,
            intuitTid: error.intuit_tid,
        });
        res.status(500).send(`Error: ${error.message}`);
    }
});

// ─── Health ───
router.get('/ping', (_req, res) => res.json({
    ok: true,
    integration: 'jubelio-qbo',
    alerts: alertsConfigured() ? 'enabled' : 'disabled',
}));

// ─── Debug: send a test Telegram alert ───
router.get('/debug-alert', async (_req, res) => {
    const result = await sendTestAlert();
    res.status(result.ok ? 200 : 400).json(result);
});

module.exports = router;
