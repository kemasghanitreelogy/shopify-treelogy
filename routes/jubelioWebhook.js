const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getQboInstance } = require('../services/qboService');
const { alertWebhookError, alertAuthRejected, alertShfRouteFailed, sendTestAlert, isConfigured: alertsConfigured } = require('../services/alertService');
const { isBundleSku, getBundleComposition } = require('../services/bundleService');
const JubelioOrderMap = require('../models/JubelioOrderMap');
const JubelioPayloadLog = require('../models/JubelioPayloadLog');
const JubelioCustomerMap = require('../models/JubelioCustomerMap');
const WebhookFailure = require('../models/WebhookFailure');
const { toQboTxnDate, toQboTime } = require('../lib/jubelioTime');

// ─── Deferred-alert failure counter ───────────────────────────────────────
// We alert only once Jubelio's retries are exhausted. A failed webhook returns
// 500 → Jubelio re-delivers the identical payload. We count failures per
// logical event; the alert fires only when the count reaches this threshold.
// Default 3 matches Jubelio's "retry up to 3x". Env-overridable.
const WEBHOOK_ALERT_AFTER_ATTEMPTS = Math.max(1, Number(process.env.WEBHOOK_ALERT_AFTER_ATTEMPTS) || 3);

// Records one failure for `key` and returns whether this failure should alert.
// Fail-OPEN: if the counter store itself errors, we alert (a noisy alert beats
// a silently-swallowed permanent failure).
const recordFailureAndShouldAlert = async (key, endpoint, errMsg) => {
    try {
        const doc = await WebhookFailure.findOneAndUpdate(
            { key },
            {
                $inc: { count: 1 },
                $set: { last_at: new Date(), last_error: String(errMsg || '').slice(0, 500), endpoint },
                $setOnInsert: { first_at: new Date() },
            },
            { upsert: true, new: true },
        );
        if (doc.count >= WEBHOOK_ALERT_AFTER_ATTEMPTS && !doc.alerted) {
            // Latch the alert flag so we fire exactly once even if Jubelio
            // retries past the threshold or two increments race.
            const latched = await WebhookFailure.findOneAndUpdate(
                { key, alerted: false },
                { $set: { alerted: true } },
                { new: true },
            );
            return { count: doc.count, shouldAlert: !!latched };
        }
        return { count: doc.count, shouldAlert: false };
    } catch (e) {
        console.error(`[alert] failure-counter error for ${key}: ${e.message}`);
        return { count: null, shouldAlert: true };
    }
};

// Clears the failure counter for `key` after a successful sync so a later,
// unrelated failure starts a fresh count. Fire-and-forget.
const clearFailureCounter = (key) => {
    if (!key) return;
    WebhookFailure.deleteOne({ key }).catch(e =>
        console.error(`[alert] failure-counter clear error for ${key}: ${e.message}`));
};

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
// Jubelio raw timestamps are real UTC. QBO TxnDate must reflect the WIB
// (UTC+7) calendar date when payment was received — that's the Jakarta
// business day finance reports against. See lib/jubelioTime.js for the
// canonical helper and its semantic model.
//
// Note: pre-2026-05 this code used +8h ("isoDateJakarta") which produced
// WITA dates matching Jubelio admin UI. Migrated to WIB (toQboTxnDate) in
// the forward-only cutover; historical invoices left untouched.
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
// Tax codes are returned as a RANKED candidate list (zero-rate first, then any
// other usable code) instead of a single id. We retry with the next candidate
// when QBO rejects with "Invalid Tax Rate" (the chosen code's underlying tax
// rate was deleted/disabled by an admin). Cache TTL is 1 hour so the list
// refreshes automatically after admins reorganize the tax catalog.
//
// QBO_TAX_CODE (optional) pins the candidate list and skips the lookup
// entirely — accepts a comma-separated list so the fallback chain survives,
// e.g. "9,7,15". Pinning removes one QBO round-trip per cold start, which is
// what turned the 2026-09-02 Intuit outage into a total sync stop: the very
// first QBO call of every invocation was findTaxCodes.
let _cachedTaxCodes = null;
let _cachedTaxAt = 0;
const TAX_CACHE_TTL_MS = 60 * 60 * 1000;
let _cachedIncomeAccountId = null;

// A tax code is USABLE if Active and has at least one populated TaxRateDetail
// entry. Inactive codes or codes whose TaxRateRef list is empty (e.g. "12.0%
// S Import" without a configured rate) cause AST validator to throw with
// "Invalid tax rate id - <n>" when used on a line.
const isUsableTaxCode = (c) => c.Active !== false
    && Array.isArray(c.SalesTaxRateList?.TaxRateDetail)
    && c.SalesTaxRateList.TaxRateDetail.length > 0
    && c.SalesTaxRateList.TaxRateDetail.some(d => d.TaxRateRef?.value);

// Score: 0 = best (zero-rate names), 1 = neutral, 2 = taxable.
const rankTaxCode = (c) => {
    const name = String(c.Name || '');
    if (/no.?vat|exempt|zero|nil|none|nol|bebas|0\.?0%|^z\b|^non$|^fre$/i.test(name)) return 0;
    if (/^\d+(\.\d+)?\s*%/i.test(name)) return 2; // looks like a percent code
    return 1;
};

const pinnedTaxCodes = () => String(process.env.QBO_TAX_CODE || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const fetchTaxCodes = (qbo) => new Promise((resolve, reject) => {
    qbo.findTaxCodes([], (err, body) => {
        if (err) return reject(new Error('findTaxCodes: ' + extractQboError(err, body)));
        resolve(body?.QueryResponse?.TaxCode || []);
    });
});

const getUsableTaxCodes = async (qbo) => {
    const pinned = pinnedTaxCodes();
    if (pinned.length) return pinned;

    if (_cachedTaxCodes && Date.now() - _cachedTaxAt < TAX_CACHE_TTL_MS) {
        return _cachedTaxCodes;
    }

    let codes;
    try {
        codes = await withQboRetry('findTaxCodes', () => fetchTaxCodes(qbo));
    } catch (err) {
        // Serve stale rather than fail the whole sync. Tax codes change maybe
        // once a year; a list that is an hour (or a day) old is still correct,
        // and during a QBO outage this is the difference between "invoice
        // posts on the next retry" and "every order backs up". Only when we
        // have never fetched successfully is there nothing to fall back to.
        if (_cachedTaxCodes?.length) {
            const ageMin = Math.round((Date.now() - _cachedTaxAt) / 60000);
            console.warn(`⚠️ findTaxCodes gagal (${String(err.message).slice(0, 120)}) — pakai cache basi umur ${ageMin}m: [${_cachedTaxCodes.join(',')}]`);
            return _cachedTaxCodes;
        }
        throw err;
    }

    const ranked = codes.filter(isUsableTaxCode).sort((a, b) => rankTaxCode(a) - rankTaxCode(b));
    _cachedTaxCodes = ranked.map(c => String(c.Id));
    // Fall-back to ANY active code id if filter eliminated everything (very
    // misconfigured tenant) — better than no candidate at all.
    if (_cachedTaxCodes.length === 0) {
        _cachedTaxCodes = codes.filter(c => c.Active !== false).map(c => String(c.Id));
    }
    _cachedTaxAt = Date.now();
    return _cachedTaxCodes;
};

const getDefaultTaxCode = async (qbo) => {
    const list = await getUsableTaxCodes(qbo);
    return list[0] || null;
};

const invalidateTaxCache = () => { _cachedTaxCodes = null; _cachedTaxAt = 0; };

// Detect QBO tax-validator errors so we can retry with a different code.
const isTaxRateError = (err) => {
    const msg = String(err?.message || err || '');
    return /Invalid Tax Rate|Invalid tax|sales tax rate/i.test(msg);
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

// node-quickbooks builds every criteria lookup as a GET URL and URL-encodes
// only % ' = < > & # \ + (node_modules/node-quickbooks/index.js ~L2575).
// Characters RFC 3986 forbids in a query but that list misses — | { } ^ ` "
// and control chars — reach Intuit's Tomcat gateway raw and come back as an
// HTML "HTTP Status 400 – Bad Request" page, which surfaces here as
// `findCustomers: <!doctype html>…` and 500s the whole webhook. Real case:
// Shopee SO SP-260725JJYAV9YS, buyer "SIT| NURTAMSIAH" — stuck since 27 Jul.
const QBO_URL_UNSAFE = /[|{}^`"\x00-\x1F\x7F]/;

// Lossless fallback for those values: build the SOQL ourselves and
// encodeURIComponent the whole query string (same approach as
// findCustomerByDisplayNameAnyState below), so the match stays EXACT rather
// than us mangling the search term to keep the transport happy.
const qboQueryByField = async (qbo, entity, field, value) => {
    const escaped = String(value).replace(/'/g, "\\'").substring(0, 100);
    const q = `SELECT * FROM ${entity} WHERE ${field} = '${escaped}'`;
    const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
    const rows = body?.QueryResponse?.[entity];
    return Array.isArray(rows) ? rows : (rows ? [rows] : []);
};

// ─── Customer lookup (by email, then DisplayName, else create) ───
const findCustomersByField = (qbo, field, value) => withQboRetry('findCustomers', async () => {
    if (QBO_URL_UNSAFE.test(String(value ?? ''))) {
        const rows = await qboQueryByField(qbo, 'Customer', field, value);
        // node-quickbooks' wrapper leans toward active records; mirror that
        // preference so this path can't resolve to an archived customer while
        // a live one exists.
        return rows.sort((a, b) => Number(b.Active === true) - Number(a.Active === true));
    }
    return await new Promise((resolve, reject) => {
        qbo.findCustomers([{ field, value, operator: '=' }], (err, body) => {
            if (err) return reject(new Error('findCustomers: ' + extractQboError(err, body)));
            resolve(body?.QueryResponse?.Customer || []);
        });
    });
});

// Fallback for "Duplicate Name Exists" recovery when the QBO error message
// lacks an Id=... fragment. node-quickbooks' findCustomers wrapper sometimes
// applies an implicit Active=true filter; this raw SOQL include inactive too,
// so we can recover Customers that finance has soft-deleted but whose
// DisplayName still blocks creation per QBO's case-insensitive uniqueness rule.
const findCustomerByDisplayNameAnyState = async (qbo, displayName) => {
    const escaped = String(displayName).replace(/'/g, "\\'").substring(0, 100);
    const q = `SELECT Id, DisplayName, Active FROM Customer WHERE DisplayName = '${escaped}'`;
    const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
    return body?.QueryResponse?.Customer?.[0] || null;
};

// Tokopedia (and some other channels) redact customer/shipping names in
// webhook payloads for privacy — values look like "A*** y***nto". Detect
// these so we can fetch the unredacted form via Jubelio API directly.
const isRedactedName = (name) => /\*{2,}/.test(String(name || ''));

// QBO's API gateway (Apache Tomcat) rejects bare RFC-3986-reserved/unsafe
// chars in query URLs with HTTP 400, even though they're legal inside SOQL
// string literals. node-quickbooks builds findCustomers as a GET URL and
// URL-encodes only a fixed set (% ' = < > & # \ +) — it leaves `| { } ^ \``
// through, so any of those in a customer DisplayName crashes the lookup.
// Strip them here, plus collapse whitespace and trim leading/trailing
// punctuation (Jubelio sometimes emits names like "| Gusti Made ..." where
// an empty dropshipper prefix leaks the separator). Conservative — we drop
// the offending chars rather than guess substitutions; if finance wants
// "I Gusti …" they fix it in Jubelio and the next sync picks it up.
const sanitizeCustomerName = (name) => {
    if (name == null) return name;
    let s = String(name).replace(/[|{}^`\\]/g, ' ');
    s = s.replace(/:/g, '-');                 // ':' is reserved in QBO DisplayName (parent:sub-customer separator) — mirror sanitizeItemName
    s = s.replace(/[\x00-\x1F]/g, "");     // strip control chars QBO rejects
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/^[\s\-_.,;:]+|[\s\-_.,;:]+$/g, '');
    return s;
};

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
    String(name || '').replace(/^\s*(SP|TP|TT|SHF|LB|CS|DP|DW|WS|WX|WA|D)\s*-\s*/i, '').trim();

// Channel prefix codes derived from salesorder_no. Used to auto-prefix new
// customer DisplayNames so the QBO customer list always shows the channel
// origin (matches the existing Treelogy convention "TP - Adha Yuwanto").
//   SP=Shopee · TP/TT=Tokopedia · SHF=Shopify · LB=La Brisa · CS=Consignment
//   DP=WhatsApp/direct · DW=Walk-in · WS=Wholesale
const KNOWN_CHANNEL_PREFIXES = new Set(['SP', 'TP', 'TT', 'SHF', 'LB', 'CS', 'DP', 'DW', 'WS']);
const PREFIX_CANONICAL = { TT: 'TP' }; // TT is a Tokopedia variant — canonical TP
const channelPrefixOf = (so) => {
    const raw = String(so?.salesorder_no || '').match(/^([A-Z]{2,5})-/)?.[1] || null;
    if (!raw || !KNOWN_CHANNEL_PREFIXES.has(raw)) return null;
    return PREFIX_CANONICAL[raw] || raw;
};

// Strict channel-prefix check on a DisplayName. Returns true when the name
// starts with `${expectedPrefix} -` (case-insensitive, with TT→TP canonical
// folding). When expectedPrefix is null/falsy (channel unknown), the policy
// is not enforced and we return true so callers fall back to legacy dedup.
const hasMatchingChannelPrefix = (name, expectedPrefix) => {
    if (!expectedPrefix) return true;
    const m = String(name || '').match(/^\s*([A-Z]{2,5})\s*-/i);
    if (!m) return false;
    const actual = (PREFIX_CANONICAL[m[1].toUpperCase()] || m[1].toUpperCase());
    return actual === expectedPrefix;
};

// ─── Shopify payment-route split (SHF → WA / WX) ────────────────────────────
// Jubelio delivers every Shopify order as `SHF-<shopifyOrderNo>-<storeId>`
// regardless of how the buyer paid. Finance wants the QBO channel code to
// reflect the payment route instead:
//   WA = third-party gateway (Xendit)        (detection API payment=0)
//   WX = native Shopify Payments (Airwallex)  (detection API payment=1)
// The route isn't in the Jubelio payload, so we ask the standalone
// payment-shopify-detection service (it reads Shopify directly). The 4+ digit
// segment after `SHF-` is the Shopify order name (#8018), which is the `code`
// that endpoint expects.
//
// Safety: a paid order's gateway never changes, so results are cached forever
// (per Shopify order #). Any failure — unreachable, non-2xx, timeout, or an
// unrecognized payment value — FALLS BACK to plain `SHF` so the webhook never
// breaks on this enrichment, and fires a Telegram alert (deduped per order #
// so a downed API doesn't spam on every webhook retry).
const SHOPIFY_PAYMENT_API = (process.env.SHOPIFY_PAYMENT_API_URL || 'https://payment-shopify-detection.vercel.app').replace(/\/+$/, '');
const SHF_ROUTE_TIMEOUT_MS = Number(process.env.SHOPIFY_PAYMENT_API_TIMEOUT_MS || 4000);
const shfRouteCache = new Map();      // shopifyOrderNo → 'WA' | 'WX' (process-lifetime, success only)
const shfRouteAlerted = new Set();    // shopifyOrderNo already alerted (dedup)
const shfRequestMemo = new WeakMap(); // so payload → resolved code, so the customer prefix and the
                                      // invoice DocNumber within ONE webhook always agree even if a
                                      // transient detection failure would otherwise resolve differently
                                      // across the two call sites.

const resolveShfChannelCode = async (so) => {
    if (!so) return 'SHF';
    if (shfRequestMemo.has(so)) return shfRequestMemo.get(so);
    const m = String(so.salesorder_no || '').match(/^SHF-(\d+)-/);
    if (!m) { shfRequestMemo.set(so, 'SHF'); return 'SHF'; } // not a Shopify SO — leave untouched
    const orderNo = m[1];
    if (shfRouteCache.has(orderNo)) {
        const cached = shfRouteCache.get(orderNo);
        shfRequestMemo.set(so, cached);
        return cached;
    }

    let httpStatus = null;
    try {
        const res = await fetch(`${SHOPIFY_PAYMENT_API}/api/orders/payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: orderNo }),
            signal: AbortSignal.timeout(SHF_ROUTE_TIMEOUT_MS),
        });
        httpStatus = res.status;
        if (!res.ok) throw new Error(`detection API HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        const body = await res.json();
        const code = body.payment === 0 ? 'WA' : body.payment === 1 ? 'WX' : null;
        if (!code) throw new Error(`unrecognized payment=${JSON.stringify(body.payment)} (channel=${body.paymentChannel || '?'})`);
        shfRouteCache.set(orderNo, code);
        shfRequestMemo.set(so, code);
        console.log(`🔀 SHF route: #${orderNo} payment=${body.payment} (${body.paymentMethod || '?'}) → ${code}`);
        return code;
    } catch (err) {
        console.warn(`⚠️ SHF route lookup failed for #${orderNo} (${so.salesorder_no}): ${err.message} — fallback SHF`);
        if (!shfRouteAlerted.has(orderNo)) {
            shfRouteAlerted.add(orderNo);
            alertShfRouteFailed({ salesorderNo: so.salesorder_no, shopifyOrderNo: orderNo, error: err, httpStatus });
        }
        // Memo SHF for THIS request only (keeps customer + DocNumber consistent);
        // global shfRouteCache stays empty so a later webhook retries the lookup.
        shfRequestMemo.set(so, 'SHF');
        return 'SHF';
    }
};

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

// Lookup an active QBO Customer by id for the JubelioCustomerMap fast path.
// Returns the Customer body when present & active, null when QBO confirms
// missing/inactive, and the sentinel `{ status: 'unknown' }` for transient
// errors so callers can keep trusting the cache rather than spuriously
// creating duplicates on QBO flakiness.
const qboGetActiveCustomer = (qbo, customerId) => withQboRetry('getCustomer', () => new Promise((resolve) => {
    qbo.getCustomer(String(customerId), (err, body) => {
        if (err) {
            const msg = String(err.message || err);
            if (/Object Not Found|6240|404|invalid/i.test(msg)) return resolve(null);
            return resolve({ status: 'unknown' });
        }
        if (!body || body.Active === false) return resolve(null);
        resolve(body);
    });
}));

const getOrCreateCustomer = async (qbo, so) => {
    let email = so.customer_email;
    let phone = so.customer_phone;
    let displayName = (sanitizeCustomerName(so.customer_name) || 'Jubelio Customer').substring(0, 100);
    let shipFullName = sanitizeCustomerName(so.shipping_full_name);
    let shipAddr = buildShipAddr(so);

    const source = String(so.source_name || so.source || '').toUpperCase().trim();
    const buyerId = so.buyer_id ? String(so.buyer_id).trim() : null;
    const realmId = String(qbo.realmId);

    // Strict channel prefix policy: every customer used for an SO must carry
    // its channel's prefix in DisplayName (e.g. `SHF - Veranika Effendy` for
    // a Shopify SO). Cached or pre-existing customers without that prefix —
    // or with the wrong prefix — are bypassed so a properly prefixed record
    // gets created, even if it means a parallel entry per channel.
    // For Shopify orders, split the generic SHF code into WA (third-party /
    // Xendit) or WX (native Shopify Payments) per the payment route. Falls back
    // to SHF on any detection failure. Resolved once here and used everywhere
    // the channel prefix feeds the DisplayName below.
    let channelPrefix = channelPrefixOf(so);
    if (channelPrefix === 'SHF') channelPrefix = await resolveShfChannelCode(so);

    // ─── Resolve canonical DisplayName BEFORE any cache lookup ──────────
    // We compare cached customer records against the webhook's canonical
    // displayName so the QBO Customer name always tracks what Jubelio sends
    // (= what the Jubelio UI shows for that order). The unredact-fetch and
    // prefix-forcing both feed into that canonical form, so they must run
    // before the buyer_id fast path.

    // Tokopedia & some channels redact customer info in webhook payloads.
    // When detected, fetch the unredacted form from Jubelio API directly.
    // Cached + graceful fallback so the webhook never fails on this path.
    if (isRedactedName(displayName) && so.salesorder_id) {
        const fullSo = await fetchUnredactedSo(so.salesorder_id);
        if (fullSo) {
            const realName = sanitizeCustomerName(fullSo.customer_name || fullSo.shipping_full_name || '');
            if (realName && !isRedactedName(realName)) {
                console.log(`🔓 Unredacted customer: "${displayName}" → "${realName}" (SO ${so.salesorder_id})`);
                displayName = realName.substring(0, 100);
                email = email || fullSo.customer_email || null;
                phone = phone || fullSo.customer_phone || null;
                shipFullName = shipFullName || sanitizeCustomerName(fullSo.shipping_full_name);
                if (!shipAddr) shipAddr = buildShipAddr(fullSo);
            }
        }
        // If still redacted after fetch, we proceed with the redacted name —
        // worst case is consistent grouping under the placeholder, which is
        // strictly better than failing the webhook outright.
    }

    // Force the canonical DisplayName to carry the SO's channel prefix.
    // We override even when the raw name already starts with some other
    // known prefix (e.g. Jubelio fed us `TP - Yenny` for an SHF order) —
    // the prefix must reflect THIS SO's channel.
    if (channelPrefix && !hasMatchingChannelPrefix(displayName, channelPrefix)) {
        const stripped = stripCustomerChannelPrefix(displayName);
        displayName = `${channelPrefix} - ${stripped}`.substring(0, 100);
    }

    // ─── buyer_id fast path (gated on canonical-name equality) ──────────
    // (source, buyer_id) → qbo_customer_id is stored in JubelioCustomerMap
    // as a fast lookup. We trust the cache ONLY when the cached customer's
    // DisplayName equals the canonical displayName we just resolved. This
    // ensures repeat orders for the same recipient are deduped, while a
    // single Tokopedia account shipping to a different recipient
    // (dropship / reseller / gift) falls through to find-or-create so the
    // QBO record reflects THIS order's recipient — matching what Jubelio
    // UI shows for that order.
    if (source && buyerId) {
        const mapped = await JubelioCustomerMap.findOne({
            source, buyer_id: buyerId, qbo_realm_id: realmId,
        }).lean();
        if (mapped?.qbo_customer_id) {
            const cached = await qboGetActiveCustomer(qbo, mapped.qbo_customer_id);
            if (cached) {
                const transient = cached.status === 'unknown';
                const cachedName = transient ? '' : (cached.DisplayName || '');
                const nameOk = transient || (cachedName.trim().toLowerCase() === displayName.trim().toLowerCase());
                if (nameOk) {
                    JubelioCustomerMap.updateOne(
                        { _id: mapped._id },
                        {
                            last_seen_at: new Date(),
                            last_so_no: so.salesorder_no,
                            last_customer_name_jubelio: displayName,
                        }
                    ).catch(e => console.warn(`⚠️ JubelioCustomerMap touch failed: ${e.message}`));
                    console.log(`✅ Customer match by buyer_id source=${source} buyer_id=${buyerId} → qbo_id=${mapped.qbo_customer_id}`);
                    return mapped.qbo_customer_id;
                }
                console.warn(`⚠️ JubelioCustomerMap mismatch: buyer_id=${buyerId} cached DisplayName="${cachedName}" but webhook says "${displayName}" — bypassing cache (likely a different recipient on the same buyer account; mapping will be overwritten to track the latest recipient)`);
            } else {
                console.warn(`⚠️ JubelioCustomerMap stale: qbo_customer_id=${mapped.qbo_customer_id} no longer exists, re-resolving (will rebuild map)`);
            }
        }
    }

    // Resolve customerId via email → name → create.
    let resolvedCustomerId = null;
    let resolvedQboName = null;

    // 1. Match by email (most specific identifier). Under the strict prefix
    // policy, only reuse an email-matched customer when its DisplayName
    // already carries this SO's channel prefix; otherwise a parallel
    // properly prefixed record will be created below.
    if (email) {
        const byEmail = await findCustomersByField(qbo, 'PrimaryEmailAddr', email);
        if (byEmail.length > 0) {
            const match = channelPrefix
                ? byEmail.find(c => hasMatchingChannelPrefix(c.DisplayName, channelPrefix))
                : byEmail[0];
            if (match) {
                resolvedCustomerId = match.Id;
                resolvedQboName = match.DisplayName;
            } else {
                console.log(`⏭️  Skip email match: ${byEmail.length} candidate(s) for ${email} lack "${channelPrefix} -" prefix — will create new prefixed customer`);
            }
        }
    }

    // 2. Multi-variant DisplayName lookup. When the channel prefix is
    // known we only consider variants that already carry it, so we never
    // lock this SO into a wrong-channel or un-prefixed record. The
    // unprefixed/stripped forms are still emitted for the (rare) channel-
    // unknown path which falls back to legacy dedup.
    if (!resolvedCustomerId) {
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
        // Emit prefixed variants for both the effective channel code (which for
        // Shopify is the WA/WX split) and the raw salesorder_no prefix, so we
        // still match canonical-folded records (e.g. TT→TP) on non-Shopify SOs.
        for (const prefix of [channelPrefix, getSoPrefix(so)]) {
            if (prefix && !displayName.toUpperCase().startsWith(`${prefix} -`)) {
                addVariant(`${prefix} - ${displayName}`);
                if (stripped !== displayName) addVariant(`${prefix} - ${stripped}`);
            }
        }

        const candidates = channelPrefix
            ? variants.filter(v => hasMatchingChannelPrefix(v, channelPrefix))
            : variants;

        for (const v of candidates) {
            const byName = await findCustomersByField(qbo, 'DisplayName', v);
            if (byName.length > 0) {
                if (v !== displayName) {
                    console.log(`✅ Customer match by variant "${v}" (asked "${displayName}") → id=${byName[0].Id}`);
                }
                resolvedCustomerId = byName[0].Id;
                resolvedQboName = byName[0].DisplayName;
                break;
            }
        }
    }

    // 3. Create new customer; recover existing Id on race-induced duplicate.
    if (!resolvedCustomerId) {
        const created = await withQboRetry('createCustomer', () => new Promise((resolve, reject) => {
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
            qbo.createCustomer(payload, async (errC, bodyC) => {
                if (errC) {
                    const detail = extractQboError(errC, bodyC);
                    const dupMatch = /Id=(\d+)/i.exec(detail);
                    if (dupMatch) {
                        console.log(`ℹ️ Customer "${displayName}" sudah ada (id=${dupMatch[1]}) — race-recovered.`);
                        return resolve({ Id: dupMatch[1], DisplayName: displayName });
                    }
                    // QBO sometimes returns "Duplicate Name Exists Error - The name
                    // supplied already exists. : null" without surfacing the conflicting
                    // Id (esp. when the existing record is Active=false). Run a follow-up
                    // query that includes inactive customers to recover the id.
                    if (/Duplicate Name Exists|name supplied already exists/i.test(detail)) {
                        try {
                            const found = await findCustomerByDisplayNameAnyState(qbo, displayName);
                            if (found) {
                                console.log(`ℹ️ Customer "${displayName}" recovered via fallback lookup (id=${found.Id} active=${found.Active})`);
                                return resolve({ Id: found.Id, DisplayName: found.DisplayName || displayName });
                            }
                        } catch (lookupErr) {
                            return reject(new Error(`createCustomer: ${detail} (fallback lookup failed: ${lookupErr.message})`));
                        }
                        return reject(new Error(`createCustomer: ${detail} (fallback lookup returned 0 — DisplayName likely differs only in case/whitespace from a record QBO considers a duplicate; manual rename in QBO needed)`));
                    }
                    return reject(new Error('createCustomer: ' + detail));
                }
                console.log(`✅ Customer baru: ${bodyC.Id} (${displayName})`);
                resolve(bodyC);
            });
        }));
        resolvedCustomerId = created.Id;
        resolvedQboName = created.DisplayName || displayName;
    }

    // Upsert JubelioCustomerMap so future webhooks for this buyer skip the
    // entire lookup chain and survive any QBO-side renames. Async — never
    // block the webhook on this audit write.
    if (source && buyerId && resolvedCustomerId) {
        JubelioCustomerMap.findOneAndUpdate(
            { source, buyer_id: buyerId, qbo_realm_id: realmId },
            {
                qbo_customer_id: String(resolvedCustomerId),
                last_seen_at: new Date(),
                last_so_no: so.salesorder_no,
                last_customer_name_jubelio: displayName,
                last_customer_name_qbo: resolvedQboName,
            },
            { upsert: true, new: true }
        ).catch(e => console.warn(`⚠️ JubelioCustomerMap upsert failed: ${e.message}`));
    }

    return resolvedCustomerId;
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

// Dedicated Shipping item resolver. Without an ItemRef, shipping lines fall
// into QBO's built-in generic "Sales" item — which makes "Sales by
// Product/Service" reports pile every shipping fee under an opaque "Sales" row.
// Shopify orders already get this right because their items[] array carries a
// "Shipping Charge" line item that flows through getOrCreateItem; non-Shopify
// channels (Tokopedia, Shopee, Direct, DealPos) put the value in
// so.shipping_cost on the SO header, which is why the dedicated lookup lives
// here.
let _shippingItemId = null;
const getShippingItem = async (qbo, incomeAccountId) => {
    if (_shippingItemId) return _shippingItemId;
    const NAME = 'Shipping Charge';
    try {
        const byName = await qboFindItemsByName(qbo, NAME);
        const usable = byName.find(i => SAFE_ITEM_TYPES.has(i.Type));
        if (usable) {
            _shippingItemId = usable.Id;
            return _shippingItemId;
        }
        if (!incomeAccountId) return null;
        const created = await qboFetch(qbo, '/item', {
            method: 'POST',
            body: JSON.stringify({
                Name: NAME,
                Type: 'Service',
                IncomeAccountRef: { value: incomeAccountId },
            }),
        });
        _shippingItemId = created?.Item?.Id || null;
        if (_shippingItemId) console.log(`✅ Shipping Item dibuat: ${NAME} (ID: ${_shippingItemId})`);
        return _shippingItemId;
    } catch (e) {
        console.log(`⚠️ getShippingItem gagal: ${e.message}`);
        return null;
    }
};

// QBO Item types that can be used as Invoice line items.
// "Category" is organizational-only and will cause createInvoice to fail with
// "Invalid Reference Id : An item in this transaction is set up as a category
// instead of a product or service." — must be skipped on lookup.
const SAFE_ITEM_TYPES = new Set(['Service', 'Inventory', 'NonInventory']);

const qboFindItemsByField = async (qbo, field, value) => {
    // Same URL-encoding gap as findCustomersByField. Item lookups swallow
    // errors (resolve([])), so an item_code or item_name carrying | { } ^ ` "
    // wouldn't 500 — it would silently miss the existing item and create a
    // duplicate one instead. Route those through the encoded query as well.
    if (QBO_URL_UNSAFE.test(String(value ?? ''))) {
        try { return await qboQueryByField(qbo, 'Item', field, value); }
        catch { return []; }
    }
    return await new Promise((resolve) => {
        qbo.findItems([{ field, value, operator: '=' }], (err, body) => {
            if (err) return resolve([]);
            resolve(body?.QueryResponse?.Item || []);
        });
    });
};
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
    // Same SKU may exist on BOTH the canonical Inventory item (post-Phase 1
    // rename) AND a legacy Service item (pre-migration). Prefer Inventory >
    // NonInventory > Service so the line uses the canonical record (quirk
    // #10). Without this, QBO's natural return order may pick the legacy
    // Service whose UnitPrice has stale variant-collapsed data.
    const TYPE_RANK = { Inventory: 0, NonInventory: 1, Service: 2 };
    if (itemCode) {
        const bySku = await qboFindItemsBySku(qbo, itemCode);
        const candidates = bySku.filter(i => SAFE_ITEM_TYPES.has(i.Type));
        candidates.sort((a, b) => (TYPE_RANK[a.Type] ?? 9) - (TYPE_RANK[b.Type] ?? 9));
        const usable = candidates[0];
        if (usable) {
            console.log(`✅ Item match by SKU="${itemCode}" → existing id=${usable.Id} name="${usable.Name}" type=${usable.Type}`);
            return usable.Id;
        }
    }

    // 2) Name lookup — match existing QBO item by full sanitized name.
    if (fullName) {
        const byName = await qboFindItemsByName(qbo, fullName);
        const candidates = byName.filter(i => SAFE_ITEM_TYPES.has(i.Type));
        candidates.sort((a, b) => (TYPE_RANK[a.Type] ?? 9) - (TYPE_RANK[b.Type] ?? 9));
        const usable = candidates[0];
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
    const bundleNotes = []; // accumulated bundle discounts → merged into single DiscountLineDetail at end
    const items = Array.isArray(so.items) ? so.items : [];
    const serviceDate = toQboTxnDate(so.transaction_date);

    for (const it of items) {
        const qty = Number(it.qty_in_base ?? it.qty ?? 1) || 1;
        const price = Number(it.sell_price ?? it.price ?? 0) || 0;
        const discPct = Number(it.disc ?? 0) || 0;
        const discAmt = Number(it.disc_amount ?? 0) || 0;
        const gross = qty * price;
        const lineAmount = Number(it.amount ?? (gross - discAmt));
        const jubelioAmount = Math.round(lineAmount * 100) / 100;

        // ── Bundle expansion ──
        // When item_code matches a canonical bundle SKU, emit per-component
        // SalesItemLineDetail lines (each at canonical unitPrice) plus a
        // DiscountLineDetail to balance to the actual paid line amount. Skip
        // the regular getOrCreateItem flow entirely for the bundle SKU so QBO
        // never sees a generic "Sales" or auto-created bundle-shaped Service
        // item.
        const itemCode = String(it.item_code || '').trim();
        if (isBundleSku(itemCode)) {
            const composition = getBundleComposition(itemCode);
            const skuToItem = new Map();
            let allComponentsResolved = true;
            for (const c of composition.components) {
                const found = await qboFindItemsBySku(qbo, c.sku);
                // Prefer Inventory over Service when SKU collides — legacy
                // Service items from pre-migration era share SKUs with the
                // canonical Inventory ids and carry stale prices (variant
                // collapse, quirk #10). Inventory is the post-migration source
                // of truth.
                const TYPE_RANK = { Inventory: 0, NonInventory: 1, Service: 2 };
                const candidates = found.filter(i => SAFE_ITEM_TYPES.has(i.Type) && i.Active !== false);
                candidates.sort((a, b) => (TYPE_RANK[a.Type] ?? 9) - (TYPE_RANK[b.Type] ?? 9));
                const usable = candidates[0];
                if (!usable) {
                    console.log(`⚠️ Bundle ${itemCode}: component SKU "${c.sku}" not found in QBO — falling back to non-bundle path`);
                    allComponentsResolved = false;
                    break;
                }
                skuToItem.set(c.sku, usable);
            }

            if (allComponentsResolved) {
                let componentSum = 0;
                for (const c of composition.components) {
                    const compQty = c.qty * qty;
                    const compAmount = Math.round(c.unitPrice * compQty * 100) / 100;
                    componentSum += compAmount;
                    const compItem = skuToItem.get(c.sku);
                    const compDetail = {
                        Qty: compQty,
                        UnitPrice: c.unitPrice,
                        ItemRef: { value: compItem.Id },
                    };
                    if (taxCodeId) compDetail.TaxCodeRef = { value: taxCodeId };
                    if (serviceDate) compDetail.ServiceDate = serviceDate;
                    lines.push({
                        Description: `[${itemCode}] ${compItem.Name}`.substring(0, 4000),
                        Amount: compAmount,
                        DetailType: 'SalesItemLineDetail',
                        SalesItemLineDetail: compDetail,
                    });
                }
                const discount = Math.round((componentSum - jubelioAmount) * 100) / 100;
                if (discount > 0) {
                    // Accumulate bundle discount; emit ONE merged DiscountLineDetail
                    // at the end of buildLines (combined with item-level discounts).
                    // QBO Indonesia drops a 2nd DiscountLineDetail silently (quirk #14).
                    bundleNotes.push({ sku: itemCode, discount });
                } else if (discount < 0) {
                    // Customer paid MORE than canonical components — extremely
                    // rare (would mean bundle sold above retail). Log and
                    // continue without discount; component lines already cover
                    // the canonical sum, leaving a small unpaid balance which
                    // surfaces in reconciliation.
                    console.warn(`⚠️ Bundle ${itemCode}: paid Rp${jubelioAmount} > componentSum Rp${componentSum}; no discount accumulated`);
                }
                console.log(`📦 Bundle expanded: ${itemCode} qty=${qty} → ${composition.components.length} components, sum=Rp${componentSum}, paid=Rp${jubelioAmount}, accumulatedDisc=Rp${Math.max(0, discount)}`);
                continue;  // skip regular item flow
            }
        }
        // ── End bundle expansion ──

        // Emit at GROSS (qty × sell_price) so QBO shows original price + the
        // discount as a separate value matching the Jubelio UI's "Diskon" field.
        // The line-level discount accumulates into the merged DiscountLineDetail
        // at the end (alongside bundle discount + customer-facing adjustments)
        // — QBO Indonesia only accepts ONE DiscountLineDetail per invoice (quirk #14).
        //
        // Shopee-only payout fees (service_fee + order_processing_fee) are NOT
        // subtracted here — they surface as balance-due against the auto-Payment
        // which is capped at so.grand_total. All other channel adjustments
        // (add_disc, discount_marketplace, etc.) are customer-facing and DO
        // get absorbed into the discount line.
        const grossRaw = qty * price;
        const grossRounded = Math.round(grossRaw * 100) / 100;
        const itemDiscount = Math.round((grossRounded - jubelioAmount) * 100) / 100;

        // QBO hard-validates Amount == Qty * UnitPrice on each line. We round
        // UnitPrice to 2 decimals, then recompute Amount from the rounded unit
        // price so the invariant ALWAYS holds.
        const effectiveUnitPrice = qty > 0 ? Math.round((grossRounded / qty) * 100) / 100 : grossRounded;
        const amount = Math.round((effectiveUnitPrice * qty) * 100) / 100;
        if (Math.abs(amount - grossRounded) >= 0.01) {
            console.log(`⚠️ Line amount adjusted ${grossRounded} → ${amount} (QBO precision for qty=${qty})`);
        }

        const itemId = await getOrCreateItem(qbo, it, incomeAccountId);
        const detail = { Qty: qty, UnitPrice: effectiveUnitPrice };
        if (itemId) detail.ItemRef = { value: itemId };
        // QBO Indonesia AST requires a TaxCodeRef even when the invoice
        // header carries GlobalTaxCalculation: NotApplicable. The id is
        // resolved upstream (getDefaultTaxCode → ranked usable codes) and
        // we retry with the next candidate on tax errors.
        if (taxCodeId) detail.TaxCodeRef = { value: taxCodeId };
        if (serviceDate) detail.ServiceDate = serviceDate;

        const description = it.description || it.item_name || it.item_code || '';

        lines.push({
            Description: description.substring(0, 4000),
            Amount: amount,
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: detail,
        });

        if (itemDiscount > 0.01) {
            // Capture per-item discount; merged into the single DiscountLineDetail
            // at the end of buildLines together with bundle disc + mkt-fee adj.
            const discPctTxt = discPct > 0 ? ` ${discPct}%` : '';
            bundleNotes.push({
                sku: it.item_code || it.item_name || '?',
                discount: itemDiscount,
                kind: 'item',
                label: `${it.item_code || it.item_name || '?'} item-disc${discPctTxt}`,
            });
        }
    }

    // Shipping fee (if any) as extra line. Setting ItemRef = "Shipping Charge"
    // is required so the line shows up under its own product/service row in
    // QBO reports (Sales by Product/Service Summary, etc.) instead of getting
    // bucketed into the opaque generic "Sales" row.
    const shipping = Number(so.shipping_cost || 0);
    if (shipping > 0) {
        const shippingItemId = await getShippingItem(qbo, incomeAccountId);
        const detail = { Qty: 1, UnitPrice: shipping };
        if (shippingItemId) detail.ItemRef = { value: shippingItemId };
        if (taxCodeId) detail.TaxCodeRef = { value: taxCodeId };
        if (serviceDate) detail.ServiceDate = serviceDate;
        lines.push({
            Description: `Shipping (${so.courier || so.shipper || 'N/A'})`,
            Amount: Math.round(shipping * 100) / 100,
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: detail,
        });
    }

    // ── Combined discount line ──
    // Policy (2026-05-14, refined): invoice TotalAmt must reflect what the
    // CUSTOMER ACTUALLY PAID (gross of payout-side deductions, net of any
    // customer-facing discount).
    //
    // Per-field semantics (verified 2026-05-14):
    //   • service_fee, order_processing_fee  → ONLY on Shopee (SP-). These are
    //     deducted from merchant payout — customer NEVER sees them. Must NOT
    //     be absorbed into the invoice discount; surface as balance-due gap.
    //   • add_disc, discount_marketplace, insurance_cost, add_fee,
    //     shipping_cost_discount → customer-facing adjustments (real promo /
    //     manual disc / extra fee at checkout). Must be absorbed so invoice
    //     reflects what customer paid out of pocket.
    //
    // Formula:
    //     customerPaid = grand_total + (service_fee + order_processing_fee)
    //     adjustment   = linesTotal − customerPaid
    //
    // For Shopee: service_fee/OPF > 0 → adjustment excludes Shopee fees.
    //   TotalAmt = customerPaid (gross). Payment caps at grand_total (net payout).
    //   Balance = customerPaid − grand_total = Shopee fee gap (finance reconcile).
    // For other channels: service_fee/OPF = 0 → customerPaid = grand_total.
    //   adjustment naturally absorbs any customer-facing discount.
    //   TotalAmt = grand_total, Payment = grand_total, Balance = 0.
    //
    // QBO Indonesia still accepts only ONE DiscountLineDetail per invoice
    // (quirk #14, 2026-04-28) — bundle/item disc + any customer-side
    // adjustment are merged into a single line.
    const grandTotal = Number(so.grand_total ?? NaN);
    const bundleDiscSum = bundleNotes.reduce((s, b) => s + b.discount, 0);
    const shopeeFees = Math.round(((Number(so.service_fee) || 0) + (Number(so.order_processing_fee) || 0)) * 100) / 100;
    let adjustment = 0;
    let hasGrandTotal = false;
    let customerPaid = NaN;

    if (Number.isFinite(grandTotal)) {
        hasGrandTotal = true;
        customerPaid = Math.round((grandTotal + shopeeFees) * 100) / 100;
        const linesTotal = lines.reduce((s, l) =>
            s + (l.DetailType === 'DiscountLineDetail' ? -Number(l.Amount || 0) : Number(l.Amount || 0)), 0);
        adjustment = Math.round((linesTotal - customerPaid) * 100) / 100;
        if (adjustment < -0.01) {
            // Customer paid more than line+shipping (e.g., insurance added on top).
            // Negative discount not supported; log and let invoice be off-by-this.
            console.warn(`⚠️ ${so.salesorder_no}: customerPaid ${customerPaid} > linesTotal ${linesTotal} (diff ${-adjustment}); no discount line emitted`);
            adjustment = 0;
        }
    } else if (bundleDiscSum > 0) {
        // Defensive fallback when grand_total is missing — preserve bundle promo.
        adjustment = bundleDiscSum;
    }

    if (adjustment > 0.01) {
        const fmt = (n) => `Rp ${Number(n).toLocaleString('id-ID')}`;
        const parts = [];
        for (const bn of bundleNotes) {
            const label = bn.label || `${bn.sku} bundle`;
            parts.push(`${label} ${fmt(bn.discount)}`);
        }
        if (hasGrandTotal) {
            // Customer-facing components (NOT Shopee payout fees). These are
            // included in the discount because the customer actually saw them.
            if (Number(so.insurance_cost) > 0) parts.push(`insurance ${fmt(so.insurance_cost)}`);
            if (Number(so.add_fee) > 0) parts.push(`add_fee ${fmt(so.add_fee)}`);
            if (Number(so.add_disc) > 0) parts.push(`add_disc ${fmt(so.add_disc)}`);
            if (Number(so.discount_marketplace) > 0) parts.push(`discount_marketplace ${fmt(so.discount_marketplace)}`);
            if (Number(so.shipping_cost_discount) > 0) parts.push(`shipping_disc ${fmt(so.shipping_cost_discount)}`);
        }
        const hasItem = bundleNotes.some(b => b.kind === 'item');
        const hasBundle = bundleNotes.some(b => !b.kind || b.kind === 'bundle');
        const labelParts = [];
        if (hasItem) labelParts.push('Item discount');
        if (hasBundle) labelParts.push('Bundle discount');
        if (hasGrandTotal) labelParts.push('Customer adjustments');
        const baseDesc = labelParts.length ? labelParts.join(' + ') : 'Discount';
        lines.push({
            Description: `${baseDesc}${parts.length ? ` (${parts.join(' + ')})` : ''}`.substring(0, 4000),
            Amount: adjustment,
            DetailType: 'DiscountLineDetail',
            DiscountLineDetail: { PercentBased: false },
        });
        console.log(`💸 Combined discount: Rp ${adjustment.toLocaleString('id-ID')} (bundles=${bundleNotes.length}, shopeeFees=${shopeeFees}, customerPaid=${Number.isFinite(customerPaid) ? customerPaid : 'n/a'})`);
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

// QBO inventory concurrency lock. Surfaces as HTTP 400 "Business Validation
// Error" with text "another user was creating/editing/deleting a transaction
// with inventory products at exactly the same time. Please try again in 30 min."
// Despite the 30-min hint, contention almost always clears within seconds —
// it's our own bursty webhook traffic + QBO's per-realm inventory recompute.
const isInventoryLockError = (err) => {
    if (!err) return false;
    const msg = String(err.message || err);
    return /another user was (creating|editing|deleting)/i.test(msg)
        || /transaction with inventory products at exactly the same time/i.test(msg);
};

// Detects QBO throttle/transient errors that are safe to retry.
// QBO returns HTTP 429 + errorCode 003001 ("ThrottleExceeded"), occasionally
// 5xx for transient platform issues, and HTTP 400 "Business Validation Error"
// for inventory-lock contention (handled with longer backoff in withQboRetry).
// Intuit's gateway answers a stalled backend with the literal body
// "stream timeout" (HTTP 200-shaped error, no Fault object) — verified during
// the 2026-09-02 outage where authenticated calls hung with no response while
// unauthenticated ones still returned 401 in ~1s. Axios' own client-side
// timeouts surface as ECONNABORTED / "timeout of Nms exceeded". None of these
// mean our payload is wrong, so they belong in the retry+suppress bucket.
const QBO_TIMEOUT_PATTERN = /stream timeout|ESOCKETTIMEDOUT|ECONNABORTED|timeout of \d+ ?ms exceeded|Client network socket disconnected/i;

const isRetryableQboError = (err) => {
    if (!err) return false;
    const msg = String(err.message || err);
    return /ThrottleExceeded|statusCode=429|errorCode=003001|"code":"?3001|"code":"?3002/i.test(msg)
        || /statusCode=5\d\d|HTTP 5\d\d|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg)
        || QBO_TIMEOUT_PATTERN.test(msg)
        || isInventoryLockError(err);
};

// Errors that are known self-healing under Jubelio's 3x retry policy:
// concurrent webhook races, QBO sync-token contention, transient network
// blips. We still return 500 so Jubelio retries, but we DON'T fire a
// Telegram alert on the first failure — alerting would only create noise
// because the next retry almost always succeeds (verified via incident
// 2026-04-29: race-cond DupName fired 2 alerts but Jubelio retries
// successfully created both invoices within seconds).
//
// Permanent errors (AST tax exhausted, missing fields, validation) bypass
// this filter and alert immediately because retry won't help.
const isLikelyTransientError = (err) => {
    if (!err) return false;
    const msg = String(err.message || err);
    if (/Duplicate Name Exists|name supplied already exists/i.test(msg)) return true;
    // Duplicate DocNumber (QBO 6140) is now self-healed in upsertQboInvoice
    // (recover by DocNumber + rebuild mapping). If the recovery query itself
    // fails on a transient blip, suppress the alert and rely on Jubelio's
    // retry — the next attempt will hit the self-heal path again and most
    // likely succeed.
    if (/Duplicate Document Number|specify a different number|\b6140\b/i.test(msg)) return true;
    if (/SyncToken|stale\s+(?:invoice|object)/i.test(msg)) return true;
    if (/ThrottleExceeded|statusCode=429|errorCode=003001|"code":"?3001|"code":"?3002/i.test(msg)) return true;
    if (/statusCode=5\d\d|HTTP 5\d\d|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg)) return true;
    if (/ESERVFAIL|EAI_AGAIN|getaddrinfo|ENOTFOUND/i.test(msg)) return true;
    // QBO/Intuit unresponsive (see QBO_TIMEOUT_PATTERN). Nothing we can fix
    // from here — hold the Telegram alert until Jubelio's retries are spent so
    // an Intuit blip doesn't page anyone, while a real outage still surfaces.
    if (QBO_TIMEOUT_PATTERN.test(msg)) return true;
    if (isInventoryLockError(err)) return true;
    return false;
};

// Wraps a QBO call with exponential-backoff retry on throttle/transient errors.
// Default (throttle/5xx): 4 attempts, base 1s → waits 1s, 2s, 4s (~7s total).
// Inventory-lock errors use base 3s → waits 3s, 6s, 12s (~21s total) since
// inventory contention clears slower than rate-limit throttle.
const withQboRetry = async (label, fn, { maxAttempts = 4, baseDelayMs = 1000 } = {}) => {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (attempt < maxAttempts && isRetryableQboError(err)) {
                const lockHit = isInventoryLockError(err);
                const base = lockHit ? Math.max(baseDelayMs, 3000) : baseDelayMs;
                const delay = base * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
                const tag = lockHit ? '[INV_LOCK]' : '[transient]';
                console.warn(`⏳ QBO retry ${label} attempt ${attempt}/${maxAttempts} ${tag} (wait ${delay}ms): ${String(err.message).slice(0, 200)}`);
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

// QBO error 6140 — DocNumber uniqueness collision. Surfaces when a prior
// webhook successfully posted the invoice but the JubelioOrderMap write
// after it never landed (Lambda timeout mid-handler, transient Mongo
// failure, etc). On the next Jubelio retry our code thinks no mapping
// exists and tries to create again, hitting this error.
const isDuplicateDocNumberError = (err) => {
    const msg = String(err?.message || err || '');
    return /Duplicate Document Number|specify a different number|\b6140\b/i.test(msg);
};

// Recover an existing QBO Invoice by its DocNumber. Used by the create-path
// self-heal: salesorder_no is globally unique in Jubelio so DocNumber → at
// most one Invoice in QBO. Returns null if QBO has no match (caller must
// surface the original create error).
const qboFindInvoiceByDocNumber = async (qbo, docNumber) => {
    if (!docNumber) return null;
    const escaped = String(docNumber).replace(/'/g, "\\'").substring(0, 21);
    const q = `SELECT * FROM Invoice WHERE DocNumber = '${escaped}'`;
    const body = await qboFetch(qbo, `/query?query=${encodeURIComponent(q)}`);
    return body?.QueryResponse?.Invoice?.[0] || null;
};

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

// Sync gate: SO syncs to QBO as soon as we have evidence the buyer has paid.
// Two signals (per-channel):
//   1. so.payment_date set                    — Tokopedia/Shopee/TikTok (escrow funded)
//   2. status ∈ PAID_STATUSES (PAID|COMPLETED) — Shopify/INTERNAL (these channels
//                                                 don't populate payment_date in
//                                                 the webhook payload — verified
//                                                 against JubelioPayloadLog 2026-04-29)
// Either signal means grand_total is finalized (incl. service_fee/marketplace
// deductions for marketplace, or final cart total for Shopify) so we can safely
// post the invoice + Payment.
//
// Shipping fields (courier, tracking_no, shipped_date) may still be empty here;
// the subsequent SHIPPED/COMPLETED webhook sparse-updates them onto the same
// invoice (qboUpdateInvoiceSafe uses sparse:true so unspecified fields persist).
//
// Earlier behavior: gated on status SHIPPED/COMPLETED only — invoices appeared
// in QBO 1-3 days after actual payment, not aligned with cash-receipt timing.
//
// Override the auto gate via env JUBELIO_SYNC_STATUSES (comma list) for testing
// or rollback to pre-2026-04-29 behavior.
const SYNC_STATUSES = new Set(
    (process.env.JUBELIO_SYNC_STATUSES || '')
        .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
);
const hasPaymentSignal = (so) => {
    if (so && so.payment_date && String(so.payment_date).trim()) return true;
    const st = String(so?.status || '').toUpperCase();
    return PAID_STATUSES.has(st);
};

// Treelogy ops convention (2026-05-05): when an order is shipped/recorded
// before the customer has actually paid, the operator types `#UNPAID`
// anywhere in the Jubelio "Keterangan" (note) field. Jubelio still requires
// the "Sudah Lunas" toggle ON to save the order, so this marker is the only
// reliable signal that the order is actually unpaid. When detected, the
// webhook creates the QBO Invoice as usual but skips Payment creation —
// finance records the Payment manually in QBO when the customer eventually
// pays. Volume is low (<10/month); no automatic clearing of the marker.
const hasUnpaidMarker = (so) => /#unpaid\b/i.test(String(so?.note || ''));

// Cancellation detection. Jubelio is inconsistent about which field carries
// the cancel signal — `is_canceled` is sometimes null even when the order
// is fully canceled (`internal_status: "CANCELED"`, `wms_status: "CANCELED"`,
// `channel_status: "CANCELLED"`, `internal_cancel_date` set). Pre-2026-05-07
// the webhook only checked `is_canceled`, which let canceled SOs slip
// through and create invoices in QBO (e.g. SP-260505KPNWRGF7). We OR-match
// across all known signals so any one of them flips the void path.
const CANCELED_STATUS_VALUES = new Set(['CANCELED', 'CANCELLED']);
const isCanceledSO = (so) => {
    if (!so) return false;
    if (so.is_canceled) return true;
    if (so.internal_cancel_date) return true;
    const fields = [so.status, so.internal_status, so.wms_status, so.channel_status];
    return fields.some((f) => f && CANCELED_STATUS_VALUES.has(String(f).toUpperCase()));
};

// Per-channel sync gate: ALL channels (marketplace + direct-sale) follow the
// same rule — wait for buyer-paid signal (payment_date set OR status
// PAID/COMPLETED) before syncing to QBO. Policy decision 2026-04-29: invoice
// TxnDate in QBO must equal the actual payment receipt date, so we never
// post an invoice before payment is confirmed.
//
// Direct-sale channels (LB/CS/DP/DW/WS) audited against last-30d payload log:
// every recorded order eventually reached PAID/COMPLETED, so removing the
// bypass doesn't strand any orders in PENDING.
//
// BYPASS_STATUS_PREFIXES retained as an env-only escape hatch in case finance
// needs to force-sync a channel that's stuck — set
// JUBELIO_BYPASS_STATUS_PREFIXES=LB,CS to re-enable per-channel bypass.
const BYPASS_STATUS_PREFIXES = new Set(
    (process.env.JUBELIO_BYPASS_STATUS_PREFIXES || '')
        .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
);

const markQboInvoicePaid = async (qbo, invoice, customerId, so) => {
    const invoiceId = String(invoice.Id);
    const balance = Number(invoice.Balance ?? invoice.TotalAmt ?? 0);
    if (balance <= 0) {
        console.log(`ℹ️ Invoice ${invoiceId} sudah 0 balance — skip payment.`);
        return null;
    }

    // Payment amount = so.grand_total (what actually hit the bank), capped at
    // invoice balance so we never overpay.
    //   • Shopee: invoice TotalAmt = gross customer-paid, grand_total = net
    //     payout. Payment = grand_total < balance → Shopee fee surfaces as
    //     balance-due gap for finance to reconcile at month-end.
    //   • Other channels: invoice TotalAmt = grand_total = customer-paid (no
    //     payout deduction). Payment = grand_total = balance → Balance = 0.
    // This keeps the QBO Payment ↔ bank deposit reconciliation 1:1 (policy
    // 2026-05-14, refined to Shopee-only after 2026-05-14 revert).
    const grandTotal = Number(so.grand_total);
    const customerPaid = Number.isFinite(grandTotal) && grandTotal > 0 ? grandTotal : balance;
    const payAmount = Math.min(Math.round(customerPaid * 100) / 100, balance);
    if (payAmount <= 0) {
        console.log(`ℹ️ Invoice ${invoiceId} payAmount ${payAmount} <= 0 — skip payment.`);
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
        TotalAmt: payAmount,
        TxnDate: toQboTxnDate(so.payment_date || so.transaction_date),
        DocNumber: paymentDocNumber,
        PrivateNote: `Auto-paid from Jubelio SO #${so.salesorder_no} status=${so.status} (grand_total=${grandTotal}, invoiceBal=${balance})`,
        Line: [{
            Amount: payAmount,
            LinkedTxn: [{ TxnId: invoiceId, TxnType: 'Invoice' }],
        }],
    };
    const created = await qboCreatePayment(qbo, payload);
    const gap = Math.round((balance - payAmount) * 100) / 100;
    console.log(`💰 Payment created: ${created.Id} for invoice ${invoiceId} amount=${payAmount} (balance=${balance}, mkt-fee gap=${gap})`);
    return created;
};

// ─── Payment reconcile pada jalur "skipped" ───
// Guard idempoten di upsertQboInvoice mengasumsikan webhook sebelumnya sudah
// menuntaskan sisi Payment. Asumsi itu jebol kalau run sebelumnya mati SETELAH
// invoice dibuat tapi SEBELUM Payment — persis yang terjadi ke
// SHF-10704-128887 saat outage Intuit 2026-09-02: invoice ada, Payment tidak
// pernah dibuat, dan sepuluh re-fire berikutnya semuanya mengambil jalur skip.
//
// Biayanya nol untuk order normal: mapping yang sudah punya qbo_payment_id
// atau payment_reconciled_at langsung keluar tanpa memanggil QBO. Satu mapping
// paling banyak sekali diperiksa.
const reconcileSkippedPayment = async (qbo, so, realmId, statusUpper, log = console.log) => {
    const mapping = await JubelioOrderMap.findOne({ salesorder_id: so.salesorder_id, qbo_realm_id: realmId });
    if (!mapping) return null;
    if (mapping.qbo_payment_id || mapping.payment_reconciled_at || mapping.manual_payment) return null;

    const stamp = (extra = {}) => JubelioOrderMap.updateOne(
        { _id: mapping._id }, { payment_reconciled_at: new Date(), ...extra });

    // Belum saatnya bayar (status belum PAID/COMPLETED) atau memang manual —
    // jangan di-stamp, biar diperiksa lagi saat statusnya berubah.
    if (!PAID_STATUSES.has(statusUpper) || hasUnpaidMarker(so)) return null;

    const invoice = await qboGetInvoice(qbo, mapping.qbo_invoice_id);
    if (!invoice || Number(invoice.Balance ?? 0) <= 0) {
        await stamp();
        return null;
    }

    log(`🩹 Skip-path reconcile: invoice ${mapping.qbo_invoice_id} masih bersaldo ${invoice.Balance} padahal ${statusUpper} — buat Payment yang tertinggal.`);
    const payment = await markQboInvoicePaid(qbo, invoice, invoice.CustomerRef?.value, so);
    await stamp(payment?.Id ? { qbo_payment_id: String(payment.Id) } : {});
    return payment;
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
        const incomingTxnRaw = so.transaction_date ? String(so.transaction_date) : null;
        const incomingPayRaw = so.payment_date ? String(so.payment_date) : null;
        const sameTxnDate = (existing.last_transaction_date_raw || null) === incomingTxnRaw;
        const samePayDate = (existing.last_payment_date_raw || null) === incomingPayRaw;
        if (sameStatus && sameTotal && sameTxnDate && samePayDate) {
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

    // QBO Invoice TxnDate uses Jubelio's payment_date as the canonical source —
    // it represents when the customer's funds were captured (the actual accrual
    // event). transaction_date / created_date are kept as fallbacks for edge
    // cases (unpaid orders, COD with no payment_date, missing field).
    const dateRaw = so.payment_date || so.transaction_date || so.created_date || null;
    const dateField = so.payment_date ? 'payment_date'
        : so.transaction_date ? 'transaction_date'
        : so.created_date ? 'created_date' : 'none';
    const txnDate = toQboTxnDate(dateRaw);
    if (dateRaw) {
        console.log(`📅 SO ${so.salesorder_no} ${dateField}="${dateRaw}" → TxnDate=${txnDate}`);
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
    let docNumber = rawSoNo.substring(0, 21) || undefined;
    // Shopify payment-route: remap the DocNumber prefix to match the customer's
    // WA/WX channel code (same numeric core, e.g. SHF-8038-128887 → WA-8038-128887)
    // so the invoice number and the customer's channel agree. Uses the same
    // per-request-memoized resolver as the customer prefix, so the two never
    // diverge. Falls back to SHF on any detection failure; dailyReconcile folds
    // WA-/WX- back to SHF- when matching, so reconcile stays correct either way.
    if (docNumber && /^SHF-/.test(docNumber)) {
        const routeCode = await resolveShfChannelCode(so);
        if (routeCode !== 'SHF') docNumber = `${routeCode}-${docNumber.slice(4)}`;
    }
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
    const validShipDate = toQboTxnDate(dateCandidates[0]);
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
    // SHF (Shopify) doesn't populate payment_date — falls back to transaction_date
    // (Shopify checkout is pre-paid, so transaction time ≈ payment time).
    const paidAt = toQboTime(so.payment_date || so.transaction_date);
    if (paidAt) privateParts.push(`paid=${paidAt}`);

    const basePayload = {
        Line: lines,
        CustomerRef: { value: String(customerId) },
        DocNumber: docNumber,
        TxnDate: txnDate,
        DueDate: dueDate,
        // Tax=NO VAT. GlobalTaxCalculation=NotApplicable supaya QBO tidak kenakan tax apapun.
        GlobalTaxCalculation: 'NotApplicable',
        // Wipe any stale TxnTaxDetail so QBO recomputes from the new Line[]'s
        // TaxCodeRef. On UPDATE this prevents "Invalid tax rate id - <n>"
        // errors caused by the existing TxnTaxDetail still referencing a
        // tax rate that the QBO admin has since deleted/disabled. Verified
        // working: posting `TxnTaxDetail: {}` lets QBO auto-generate fresh
        // TaxLine entries from the current line-level codes.
        TxnTaxDetail: {},
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

    // Replace TaxCodeRef on every SalesItemLineDetail so we can re-attempt
    // the update/create with a different tax code candidate when QBO rejects
    // the first one.
    const swapTaxCode = (p, newCodeId) => ({
        ...p,
        Line: (p.Line || []).map(l => {
            if (!l.SalesItemLineDetail) return l;
            return {
                ...l,
                SalesItemLineDetail: {
                    ...l.SalesItemLineDetail,
                    TaxCodeRef: { value: String(newCodeId) },
                },
            };
        }),
    });

    // Attempts a write with the current tax code, then retries with the next
    // candidate from the ranked list whenever QBO returns a tax-validator
    // error. Bounded by either candidate-list length or maxAttempts.
    const writeWithTaxFallback = async (writeFn) => {
        const candidates = await getUsableTaxCodes(qbo);
        let lastErr;
        for (let i = 0; i < Math.min(candidates.length || 1, 4); i++) {
            const codeId = candidates[i] || taxCodeId;
            const payload = i === 0 ? basePayload : swapTaxCode(basePayload, codeId);
            try {
                return await writeFn(payload);
            } catch (err) {
                lastErr = err;
                if (basePayload.ShipMethodRef && isShipMethodErr(err.message)) {
                    return writeFn(stripShipMethod(payload));
                }
                if (!isTaxRateError(err)) throw err;
                console.warn(`⚠️ tax error with code=${codeId} (attempt ${i + 1}/${candidates.length}); retrying with next candidate. msg=${err.message?.slice(0, 160)}`);
                invalidateTaxCache();
            }
        }
        throw lastErr || new Error('writeInvoice failed: exhausted tax code candidates');
    };

    if (existing) {
        console.log(`♻️ Update QBO Invoice ${existing.qbo_invoice_id} untuk SO ${so.salesorder_no}`);
        // Respect finance manual edit on TxnDate. If the QBO invoice's current
        // TxnDate differs from what we last wrote (`existing.last_txn_date`),
        // finance touched it after our last sync — preserve their edit by
        // omitting TxnDate from the sparse-update payload. Recompute DueDate
        // from finance's edited TxnDate + termDays so the due date auto-syncs
        // (e.g. finance corrects TxnDate from May 5 → May 6 with Net 14 →
        // DueDate auto-updates from May 19 → May 20). Other fields (Line
        // items, tracking, courier, memo, etc.) still update normally so we
        // don't drift on operational data.
        //
        // The map's `last_txn_date` keeps tracking webhook's COMPUTED value
        // (not finance's), so future webhook fires can keep detecting the
        // divergence and keep respecting the manual edit indefinitely. To
        // override and let webhook re-control the TxnDate, finance edits
        // back to the value the webhook would compute (or a bug-fix script
        // updates the map directly).
        const updated = await writeWithTaxFallback((p) =>
            qboUpdateInvoiceSafe(qbo, existing.qbo_invoice_id, (current) => {
                if (
                    existing.last_txn_date &&
                    current?.TxnDate &&
                    current.TxnDate !== existing.last_txn_date
                ) {
                    const recomputedDueDate = addDays(current.TxnDate, termDays);
                    console.log(
                        `📌 Finance edit detected on inv ${existing.qbo_invoice_id}: ` +
                        `keeping TxnDate=${current.TxnDate} ` +
                        `(last wrote ${existing.last_txn_date}, would have written ${p.TxnDate}); ` +
                        `recomputing DueDate=${recomputedDueDate} (Net${termDays} from finance's TxnDate)`,
                    );
                    const next = { ...p };
                    delete next.TxnDate;
                    if (recomputedDueDate) next.DueDate = recomputedDueDate;
                    else delete next.DueDate;
                    return next;
                }
                return p;
            })
        );
        await JubelioOrderMap.updateOne(
            { salesorder_id: so.salesorder_id, qbo_realm_id: realmId },
            {
                qbo_doc_number: updated.DocNumber,
                last_status: so.status,
                last_grand_total: so.grand_total,
                last_synced_at: new Date(),
                last_transaction_date_raw: so.transaction_date ? String(so.transaction_date) : null,
                last_payment_date_raw: so.payment_date ? String(so.payment_date) : null,
                last_txn_date: txnDate || null,
                manual_payment: hasUnpaidMarker(so),
            }
        );
        return { action: 'updated', invoice: updated, customerId };
    }

    console.log(`🆕 Create QBO Invoice untuk SO ${so.salesorder_no}`);
    let created;
    let action = 'created';
    try {
        created = await writeWithTaxFallback((p) => qboCreateInvoice(qbo, p));
    } catch (createErr) {
        if (!isDuplicateDocNumberError(createErr)) throw createErr;
        // Self-heal lost mapping: a prior webhook succeeded posting the
        // Invoice to QBO but the JubelioOrderMap write after it never landed
        // (verified pattern: Lambda timeout / Mongo transient blip mid-handler).
        // Recover the existing invoice by DocNumber so this retry rebuilds
        // the missing mapping instead of double-creating.
        console.warn(`⚠️ Duplicate DocNumber on create for SO ${so.salesorder_no} (docNo=${docNumber}) — attempting self-heal lookup`);
        const recovered = await qboFindInvoiceByDocNumber(qbo, docNumber);
        if (!recovered) {
            throw new Error(`createInvoice duplicate DocNumber ${docNumber} but recovery query returned 0 (manual investigation needed): ${createErr.message}`);
        }
        console.log(`🩹 Self-heal recovered QBO Invoice ${recovered.Id} (docNo=${recovered.DocNumber}) for SO ${so.salesorder_no} — rebuilding mapping`);
        created = recovered;
        action = 'recovered';
    }
    // Upsert (not create) so a concurrent webhook that already inserted the
    // mapping doesn't trip the unique index — also makes the recovery path
    // safe under retries.
    await JubelioOrderMap.findOneAndUpdate(
        { salesorder_id: so.salesorder_id, qbo_realm_id: realmId },
        {
            salesorder_no: so.salesorder_no,
            qbo_invoice_id: String(created.Id),
            qbo_doc_number: created.DocNumber,
            last_status: so.status,
            last_grand_total: so.grand_total,
            last_synced_at: new Date(),
            last_transaction_date_raw: so.transaction_date ? String(so.transaction_date) : null,
            last_payment_date_raw: so.payment_date ? String(so.payment_date) : null,
            last_txn_date: txnDate || null,
            manual_payment: hasUnpaidMarker(so),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return { action, invoice: created, customerId };
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
    // Key that is STABLE across Jubelio retries (same payload) but DISTINCT
    // across status transitions, so the deferred-alert counter tracks one
    // logical delivery. Used by both the success (clear) and catch (count) paths.
    const failKey = `pesanan:${payload.salesorder_id || '?'}:${statusUpper || '-'}:${payload.action || '-'}`;
    log(`📦 [3/8] PAYLOAD action=${payload.action || '-'} SO=${payload.salesorder_no || '-'} id=${payload.salesorder_id || '-'} status=${statusUpper || '-'} canceled=${isCanceledSO(payload)} items=${Array.isArray(payload.items) ? payload.items.length : 0} grandTotal=${payload.grand_total ?? '-'}`);
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
        const shouldVoid = isCanceledSO(payload);
        const prefix = getSoPrefix(so);
        const bypassStatus = BYPASS_STATUS_PREFIXES.has(prefix);
        const buyerPaid = hasPaymentSignal(so);
        const statusOverride = SYNC_STATUSES.size > 0 && SYNC_STATUSES.has(statusUpper);
        const shouldSync = bypassStatus || buyerPaid || statusOverride;
        log(`🧭 [4/8] DECISION shouldVoid=${shouldVoid} shouldSync=${shouldSync} prefix=${prefix || '-'} bypassStatus=${bypassStatus} buyerPaid=${buyerPaid} statusOverride=${statusOverride}`);

        // Skip early (before QBO connect) when no payment signal yet. Saves
        // latency + QBO rate-limit budget for webhooks we'd drop anyway.
        if (!shouldVoid && !shouldSync) {
            log(`⏸️  [DONE-SKIP] SO ${so.salesorder_no} status=${statusUpper} payment_date="${so.payment_date || ''}" — skip (awaiting-payment-signal) ${Date.now() - t0}ms`);
            return res.status(200).json({ ok: true, skipped: true, reason: 'awaiting-payment-signal', status: statusUpper, reqId });
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
            clearFailureCounter(failKey);
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
        const unpaidMarker = hasUnpaidMarker(so);
        if (upserted.action === 'skipped') {
            // Bukan "lewati Payment" begitu saja: pastikan dulu Payment-nya
            // memang sudah pernah dibuat (lihat reconcileSkippedPayment).
            payment = await reconcileSkippedPayment(qbo, so, realmId, statusUpper, log);
            log(`💰 [7/8] Upsert skipped (idempotent) — payment ${payment ? `tertinggal, dibuat sekarang: ${payment.Id}` : 'sudah beres'}.`);
        } else if (unpaidMarker) {
            log(`💰 [7/8] #UNPAID marker present in note — skip auto-payment (finance will record Payment manually in QBO when customer pays).`);
        } else if (PAID_STATUSES.has(statusUpper)) {
            log(`💰 [7/8] Status ${statusUpper} — marking Invoice as PAID…`);
            payment = await markQboInvoicePaid(qbo, upserted.invoice, upserted.customerId, so);
            log(`    ✅ Payment created: id=${payment?.Id || '-'} amount=${payment?.TotalAmt ?? '-'}`);
            // Catat di mapping supaya re-fire berikutnya tahu sisi Payment
            // sudah beres tanpa perlu bertanya ke QBO lagi.
            await JubelioOrderMap.updateOne(
                { salesorder_id: so.salesorder_id, qbo_realm_id: realmId },
                { payment_reconciled_at: new Date(), ...(payment?.Id ? { qbo_payment_id: String(payment.Id) } : {}) },
            );
        } else {
            log(`💰 [7/8] Status ${statusUpper} — skip payment (not in ${[...PAID_STATUSES].join('/')})`);
        }

        log(`🎉 [8/8] DONE action=${upserted.action} invoiceId=${upserted.invoice.Id} paymentId=${payment?.Id || '-'} duration=${Date.now() - t0}ms`);
        clearFailureCounter(failKey);
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
        // Suppress Telegram alert when error is in the "Jubelio's 3x retry
        // will most likely fix this" category — race-cond DupName, throttle,
        // sync-token contention, transient network. Still return 500 so
        // Jubelio actually retries.
        if (isLikelyTransientError(error)) {
            log(`⏸  [ALERT-SUPPRESSED] transient pattern — relying on Jubelio retry. (${error.message.slice(0, 200)})`);
        } else {
            // Defer the alert until Jubelio's retries are exhausted: count this
            // failure and only alert once the count reaches the threshold. A
            // failure that self-heals on a later retry clears the counter and
            // never alerts.
            const { count, shouldAlert } = await recordFailureAndShouldAlert(
                failKey, 'POST /api/webhook/jubelio/pesanan', error.message);
            if (shouldAlert) {
                alertWebhookError({
                    endpoint: 'POST /api/webhook/jubelio/pesanan',
                    reqId,
                    payload: req.body,
                    error,
                    intuitTid: error.intuit_tid,
                    attempt: count,
                    maxAttempts: WEBHOOK_ALERT_AFTER_ATTEMPTS,
                });
            } else {
                log(`⏸  [ALERT-DEFERRED] failure ${count ?? '?'}/${WEBHOOK_ALERT_AFTER_ATTEMPTS} for ${failKey} — waiting for Jubelio retry before alerting. (${error.message.slice(0, 160)})`);
            }
        }
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
        clearFailureCounter(`faktur:${ref_no}:${action || '-'}`);
        res.status(200).json({ ok: true, ...result });
    } catch (error) {
        console.error('❌ /faktur delete error:', error.message);
        if (isLikelyTransientError(error)) {
            console.log(`⏸  /faktur ALERT-SUPPRESSED (transient — Jubelio will retry): ${error.message.slice(0, 200)}`);
        } else {
            const fakturKey = `faktur:${ref_no}:${action || '-'}`;
            const { count, shouldAlert } = await recordFailureAndShouldAlert(
                fakturKey, 'POST /api/webhook/jubelio/faktur', error.message);
            if (shouldAlert) {
                alertWebhookError({
                    endpoint: 'POST /api/webhook/jubelio/faktur',
                    reqId: `faktur_${Date.now().toString(36)}`,
                    payload: { salesorder_no: ref_no, action, invoice_no },
                    error,
                    intuitTid: error.intuit_tid,
                    attempt: count,
                    maxAttempts: WEBHOOK_ALERT_AFTER_ATTEMPTS,
                });
            } else {
                console.log(`⏸  /faktur ALERT-DEFERRED (failure ${count ?? '?'}/${WEBHOOK_ALERT_AFTER_ATTEMPTS} for ${fakturKey}) — waiting for Jubelio retry`);
            }
        }
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
// Named exports for reuse in backfill scripts (e.g. force-sync stuck orders).
// Express router is an object so attaching properties is safe.
module.exports.upsertQboInvoice = upsertQboInvoice;
module.exports.markQboInvoicePaid = markQboInvoicePaid;
module.exports.voidMappedInvoice = voidMappedInvoice;
module.exports.hasPaymentSignal = hasPaymentSignal;
module.exports.hasUnpaidMarker = hasUnpaidMarker;
// Exported for scripts/_test-qbo-timeout-classifier.js — keeping the assertions
// against the real predicates means the test can't drift from the code.
module.exports.isRetryableQboError = isRetryableQboError;
module.exports.isLikelyTransientError = isLikelyTransientError;
module.exports.getUsableTaxCodes = getUsableTaxCodes;
module.exports.reconcileSkippedPayment = reconcileSkippedPayment;
