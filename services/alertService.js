// Realtime alerts via Telegram Bot API.
// No-op if TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are not configured.
// All send calls are fire-and-forget so they never block or break the caller.

const TG_API = 'https://api.telegram.org/bot';

const isConfigured = () =>
    !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

const escapeHtml = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const fmtWib = () => new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
});

const sendRaw = async (text) => {
    if (!isConfigured()) return { skipped: true, reason: 'not-configured' };
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    const res = await fetch(`${TG_API}${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Telegram ${res.status}: ${body.slice(0, 200)}`);
    }
    return { ok: true };
};

// Fire-and-forget helper — errors go to console only, never thrown.
const fireAndForget = (promise) => {
    Promise.resolve(promise).catch(e =>
        console.error(`[alert] send failed: ${e.message}`)
    );
};

// Public API ────────────────────────────────────────────────────────────────

const getSoPrefix = (soNo) => {
    const m = String(soNo || '').match(/^([A-Z]{2,5})-/);
    return m ? m[1] : null;
};

// Extracts structured detail from QBO's Fault object (node-quickbooks passes
// it through on error.Fault).
const extractQboFault = (error) => {
    const fault = error?.Fault || error?.fault;
    if (!fault) return null;
    const firstErr = (fault.Error || fault.error || [])[0] || {};
    return {
        type: fault.type || fault.Type || null,
        code: firstErr.code || firstErr.Code || null,
        element: firstErr.element || firstErr.Element || null,
        message: firstErr.Message || firstErr.message || null,
        detail: firstErr.Detail || firstErr.detail || null,
    };
};

// First N non-node_modules stack frames — enough to locate the failure.
const shortStack = (error, maxFrames = 4) => {
    if (!error?.stack) return null;
    return error.stack.split('\n').slice(1)
        .map(l => l.trim())
        .filter(l => l.startsWith('at '))
        .slice(0, maxFrames)
        .join('\n');
};

const alertWebhookError = ({ endpoint, reqId, payload, error, intuitTid }) => {
    const so = payload || {};
    const errMsg = error instanceof Error ? error.message : String(error);
    const prefix = getSoPrefix(so.salesorder_no);
    const fault = extractQboFault(error);
    const stack = shortStack(error);
    const itemCount = Array.isArray(so.items) ? so.items.length : null;
    const customerName = so.customer_name || so.billing_name || so.shipping_name || null;

    const lines = [
        '❌ <b>QBO Sync FAILED</b>',
        '',
        '<b>━━━ Context ━━━</b>',
        `📍 <b>Endpoint:</b> <code>${escapeHtml(endpoint)}</code>`,
        so.salesorder_no ? `📦 <b>SO:</b> <code>${escapeHtml(so.salesorder_no)}</code>${prefix ? ` <i>(${escapeHtml(prefix)})</i>` : ''}` : null,
        so.salesorder_id ? `🆔 <b>SO ID:</b> <code>${escapeHtml(so.salesorder_id)}</code>` : null,
        so.action ? `🔄 <b>Action:</b> ${escapeHtml(so.action)}` : null,
        so.status ? `📊 <b>Status:</b> ${escapeHtml(so.status)}` : null,
        so.is_canceled ? `🚫 <b>Canceled:</b> true` : null,
        so.grand_total !== undefined ? `💰 <b>Total:</b> ${escapeHtml(so.grand_total)}` : null,
        itemCount !== null ? `📋 <b>Items:</b> ${itemCount}` : null,
        customerName ? `👤 <b>Customer:</b> ${escapeHtml(customerName)}` : null,
        '',
        '<b>━━━ Error ━━━</b>',
        `<pre>${escapeHtml(errMsg.slice(0, 900))}</pre>`,
        fault ? '' : null,
        fault ? '<b>━━━ QBO Fault ━━━</b>' : null,
        fault?.type ? `🔖 <b>Type:</b> ${escapeHtml(fault.type)}` : null,
        fault?.code ? `🔢 <b>Code:</b> <code>${escapeHtml(fault.code)}</code>` : null,
        fault?.element ? `🎯 <b>Element:</b> <code>${escapeHtml(fault.element)}</code>` : null,
        fault?.message ? `💬 <b>Message:</b> ${escapeHtml(String(fault.message).slice(0, 400))}` : null,
        fault?.detail ? `📝 <b>Detail:</b> <code>${escapeHtml(String(fault.detail).slice(0, 300))}</code>` : null,
        stack ? '' : null,
        stack ? '<b>━━━ Stack ━━━</b>' : null,
        stack ? `<pre>${escapeHtml(stack)}</pre>` : null,
        '',
        '<b>━━━ Trace ━━━</b>',
        intuitTid ? `🧾 <b>intuit_tid:</b> <code>${escapeHtml(intuitTid)}</code>` : null,
        `🔍 <b>reqId:</b> <code>${escapeHtml(reqId || '-')}</code>`,
        `🕐 <b>Time:</b> ${escapeHtml(fmtWib())} WIB`,
        '',
        '<i>⚠️ Jubelio akan retry up to 3x</i>',
    ].filter(l => l !== null);

    // Telegram hard-limit: 4096 chars per message.
    const text = lines.join('\n').slice(0, 4000);
    fireAndForget(sendRaw(text));
};

const alertAuthRejected = ({ endpoint, ip, reason }) => {
    const lines = [
        '🚫 <b>Webhook REJECTED</b>',
        '',
        `<b>Endpoint:</b> <code>${escapeHtml(endpoint)}</code>`,
        `<b>IP:</b> <code>${escapeHtml(ip || '?')}</code>`,
        `<b>Reason:</b> ${escapeHtml(reason || 'unknown')}`,
        `<b>Time:</b> ${escapeHtml(fmtWib())} WIB`,
    ];
    fireAndForget(sendRaw(lines.join('\n')));
};

// Awaited version — used by a debug endpoint that wants to report back success.
const sendTestAlert = async () => {
    if (!isConfigured()) {
        return { ok: false, reason: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing' };
    }
    const text = [
        '✅ <b>Telegram alert — test</b>',
        '',
        'If you see this, Vercel → Telegram is wired correctly.',
        `<b>Time:</b> ${escapeHtml(fmtWib())} WIB`,
    ].join('\n');
    try {
        await sendRaw(text);
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
};

// Audit summary alert — sent by scheduled date-correctness reconciliation.
const alertAuditReport = ({ scope, scanned, mismatches, fixed, errors }) => {
    if (!isConfigured()) return;
    const ok = mismatches === 0 && errors === 0;
    const title = ok ? '✅ TxnDate Audit OK' : '⚠️ TxnDate Audit FOUND DRIFT';
    const lines = [
        `<b>${title}</b>`,
        '',
        `🔍 Scope: ${escapeHtml(scope)}`,
        `📊 Scanned: ${scanned}`,
        `❌ Mismatches: ${mismatches}`,
        `🔧 Auto-fixed: ${fixed}`,
        `⚠️ Errors: ${errors}`,
        '',
        `🕐 ${fmtWib()} WIB`,
    ];
    fireAndForget(sendRaw(lines.join('\n')));
};

// Per-invoice resync result — fired during audit auto-fix so the operator
// gets a granular trail of exactly which invoices were touched.
const alertResyncResult = ({ ok, so, invoiceId, layer, fromDate, toDate, error }) => {
    if (!isConfigured()) return;
    const title = ok ? '🔧 TxnDate Resync OK' : '❌ TxnDate Resync FAILED';
    const lines = [
        `<b>${title}</b>`,
        '',
        `📦 SO: ${escapeHtml(so)}`,
        `🆔 QBO Invoice: ${escapeHtml(invoiceId)}`,
        `🏷️  Layer: ${escapeHtml(layer)}`,
    ];
    if (ok) {
        lines.push(`📅 ${escapeHtml(fromDate || '?')} → <b>${escapeHtml(toDate || '?')}</b>`);
    } else {
        lines.push(`📅 Current: ${escapeHtml(fromDate || '?')}  Target: ${escapeHtml(toDate || '?')}`);
        if (error) lines.push(`💥 ${escapeHtml(String(error).slice(0, 250))}`);
    }
    lines.push('', `🕐 ${fmtWib()} WIB`);
    fireAndForget(sendRaw(lines.join('\n')));
};

module.exports = {
    isConfigured,
    alertWebhookError,
    alertAuthRejected,
    alertAuditReport,
    alertResyncResult,
    sendTestAlert,
};
