const JUBELIO_BASE_URL = process.env.JUBELIO_BASE_URL || 'https://api2.jubelio.com';

let cachedToken = null;
let cachedTokenExpiresAt = 0;
let loginInProgress = null;

async function doLogin() {
    const email = process.env.JUBELIO_EMAIL;
    const password = process.env.JUBELIO_PASSWORD;

    if (!email || !password) {
        throw new Error('JUBELIO_EMAIL / JUBELIO_PASSWORD belum di-set di env.');
    }

    const res = await fetch(`${JUBELIO_BASE_URL}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Jubelio login gagal (${res.status}): ${txt}`);
    }

    const data = await res.json();
    if (!data.token) throw new Error('Jubelio login: token kosong');

    cachedToken = data.token;
    // Docs: token expires in 12 hours. Refresh 10 min early.
    cachedTokenExpiresAt = Date.now() + (12 * 60 - 10) * 60 * 1000;
    console.log('🔑 Jubelio login berhasil, token di-cache.');
    return cachedToken;
}

async function getJubelioToken() {
    if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;
    if (!loginInProgress) {
        loginInProgress = doLogin().finally(() => { loginInProgress = null; });
    }
    return loginInProgress;
}

async function jubelioRequest(path, { method = 'GET', body } = {}) {
    let token = await getJubelioToken();

    const doFetch = async (tkn) => fetch(`${JUBELIO_BASE_URL}${path}`, {
        method,
        headers: {
            'Authorization': tkn,
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    let res = await doFetch(token);

    // If token rejected mid-session, force re-login once and retry.
    if (res.status === 401 || res.status === 403) {
        cachedToken = null;
        cachedTokenExpiresAt = 0;
        token = await getJubelioToken();
        res = await doFetch(token);
    }

    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Jubelio ${method} ${path} gagal (${res.status}): ${txt}`);
    }
    return res.json();
}

async function getSalesOrder(salesorderId) {
    return jubelioRequest(`/sales/orders/${salesorderId}`);
}

module.exports = { getJubelioToken, jubelioRequest, getSalesOrder };
