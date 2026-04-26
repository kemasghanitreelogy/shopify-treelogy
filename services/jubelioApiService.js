// Jubelio API client for outbound calls (read-only).
// Auth: POST /login with email + password → token (12h TTL).
// Rate limit: 600 req/min — backoff on 429.
//
// Env required:
//   JUBELIO_API_USERNAME — email used at app2.jubelio.com
//   JUBELIO_API_PASSWORD
//
// Token is cached in module scope (Vercel function instance lifetime, ~5–15min
// for warm instances). Re-login happens automatically on first call or 401.

const BASE_URL = process.env.JUBELIO_API_URL || 'https://api2.jubelio.com';
const TOKEN_TTL_MS = 11 * 60 * 60 * 1000; // refresh at 11h to leave buffer before 12h expiry

let _tokenCache = null; // { token, expiresAt }

const isConfigured = () =>
    !!(process.env.JUBELIO_API_USERNAME && process.env.JUBELIO_API_PASSWORD);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Fetch with automatic retry on 429 (rate limit) and 5xx (transient).
// Up to 3 attempts, exponential backoff.
const _fetchWithRetry = async (url, opts, label) => {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, opts);
            if (res.status === 429) {
                const wait = 1000 * 2 ** attempt;
                console.warn(`⏳ Jubelio ${label} 429 rate-limited — wait ${wait}ms (attempt ${attempt}/3)`);
                await sleep(wait);
                continue;
            }
            if (res.status >= 500 && attempt < 3) {
                const wait = 500 * 2 ** attempt;
                console.warn(`⏳ Jubelio ${label} ${res.status} — retry in ${wait}ms (attempt ${attempt}/3)`);
                await sleep(wait);
                continue;
            }
            return res;
        } catch (e) {
            lastErr = e;
            if (attempt < 3) {
                const wait = 500 * 2 ** attempt;
                console.warn(`⏳ Jubelio ${label} network error — retry in ${wait}ms: ${e.message}`);
                await sleep(wait);
                continue;
            }
        }
    }
    throw lastErr || new Error(`Jubelio ${label}: all 3 attempts failed`);
};

const login = async () => {
    if (!isConfigured()) {
        throw new Error('Jubelio API not configured: set JUBELIO_API_USERNAME and JUBELIO_API_PASSWORD');
    }
    const res = await _fetchWithRetry(`${BASE_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: process.env.JUBELIO_API_USERNAME,
            password: process.env.JUBELIO_API_PASSWORD,
        }),
    }, 'login');
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Jubelio login failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const body = await res.json();
    if (!body.token) {
        throw new Error(`Jubelio login: no token in response (got ${Object.keys(body).join(',')})`);
    }
    _tokenCache = {
        token: body.token,
        expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    console.log(`🔐 Jubelio login OK · token cached until ${new Date(_tokenCache.expiresAt).toISOString()}`);
    return _tokenCache.token;
};

const getToken = async () => {
    if (_tokenCache && _tokenCache.expiresAt > Date.now()) {
        return _tokenCache.token;
    }
    return login();
};

// GET helper. Auto-attaches Authorization header. Re-logs on 401 once.
const apiGet = async (path, params = {}, { _retried = false } = {}) => {
    const token = await getToken();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const url = `${BASE_URL}${path}${qs.toString() ? `?${qs}` : ''}`;
    const res = await _fetchWithRetry(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, `GET ${path}`);

    if (res.status === 401 && !_retried) {
        console.warn('⚠️ Jubelio 401 — token stale, re-login and retry');
        _tokenCache = null;
        return apiGet(path, params, { _retried: true });
    }

    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) {
        throw new Error(`Jubelio GET ${path} (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
    }
    return body;
};

// Page through a list endpoint until totalCount or empty page reached.
// Jubelio query params (probed live 2026-04-26):
//   page (1-based), pageSize, sortBy, sortDirection (asc|desc), q
// NOT accepted: pageNo, startDate, endDate, start_date, end_date, dateFrom, sortType, order
// Date filtering is therefore done client-side after fetch.
//
// Optional `until(item, page)` predicate: return true to stop early. Useful
// when results are sorted by date desc and we only want recent orders.
const apiGetPaged = async (path, params = {}, { pageSize = 100, maxPages = 50, until = null } = {}) => {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
        const body = await apiGet(path, { ...params, page, pageSize });
        const data = body?.data || body?.items || [];
        if (!Array.isArray(data) || data.length === 0) break;
        out.push(...data);
        const total = Number(body?.totalCount ?? body?.total ?? 0);
        if (total > 0 && out.length >= total) break;
        if (data.length < pageSize) break;
        if (until && data.some(item => until(item, page))) break;
    }
    return out;
};

// ─── Domain-specific list helpers ──────────────────────────────────────────
// `dateFrom` is the WIB date string YYYY-MM-DD used purely for client-side
// short-circuit. The endpoint itself returns all orders sorted by date desc;
// we stop fetching once we encounter an item older than `dateFrom`.

const JKT_OFFSET_MS_LOCAL = 7 * 60 * 60 * 1000;
const itemDateJkt = (item, key) => {
    const raw = item?.[key];
    if (!raw) return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() + JKT_OFFSET_MS_LOCAL).toISOString().substring(0, 10);
};

const listShippedOrders = ({ dateFrom } = {}) => {
    // shipment_date is often null in /wms/sales/shipped responses, which makes
    // sort-by-shipment_date return undefined order. transaction_date is always
    // populated and sorting by it works reliably.
    const until = dateFrom
        ? (item) => {
            const d = itemDateJkt(item, 'transaction_date');
            return d && d < dateFrom;
        }
        : null;
    return apiGetPaged('/wms/sales/shipped/', { sortBy: 'transaction_date', sortDirection: 'desc' }, { until });
};

const listCompletedOrders = ({ dateFrom } = {}) => {
    const until = dateFrom
        ? (item) => {
            const d = itemDateJkt(item, 'transaction_date');
            return d && d < dateFrom;
        }
        : null;
    return apiGetPaged('/sales/orders/completed/', { sortBy: 'transaction_date', sortDirection: 'desc' }, { until });
};

const listCanceledOrders = ({ dateFrom } = {}) => {
    const until = dateFrom
        ? (item) => {
            const d = itemDateJkt(item, 'transaction_date');
            return d && d < dateFrom;
        }
        : null;
    return apiGetPaged('/sales/orders/cancel/', { sortBy: 'transaction_date', sortDirection: 'desc' }, { until });
};

// Single SO detail — fallback when list items don't include enough fields.
const getOrderDetail = (id) => apiGet(`/sales/orders/${id}`);

module.exports = {
    isConfigured,
    login,
    apiGet,
    apiGetPaged,
    listShippedOrders,
    listCompletedOrders,
    listCanceledOrders,
    getOrderDetail,
};
