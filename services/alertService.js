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

// Daily reconcile report — fired by the morning cron. Always sends a message
// (even on a clean run) so operators know the cron itself is alive. When there
// are mismatches, follow-up messages with per-SO debug context are sent.
//
// Telegram has a 4096-char limit per message; we split mismatches across
// multiple messages, sequentially, so the operator sees ordered context.
const alertDailyReconcile = (report) => {
    if (!isConfigured()) return;
    fireAndForget(_sendDailyReconcile(report));
};

const _sendDailyReconcile = async (report) => {
    const { date, runMs, summary, perChannel, mismatches, fetchErrors } = report;

    // ─── Message 1: Header + summary + per-channel ──────────────────────────
    const hasIssues = summary.missing + summary.voided + summary.stale > 0;
    const title = hasIssues
        ? '⚠️ DAILY RECONCILE — drift detected'
        : '✅ DAILY RECONCILE — all clean';

    const head = [
        `<b>${title}</b>`,
        `📅 Date: <b>${escapeHtml(date)}</b> (WIB)`,
        '',
        `<b>📊 Summary</b>`,
        `Jubelio orders:    ${summary.jubelioOrders}`,
        `├─ expected sync:  ${summary.jubelioExpected}`,
        `└─ skipped by rule: ${summary.jubelioNotExpected}`,
        `Mongo map:         ${summary.mongoMap}`,
        `QBO actual:        ${summary.qboActual}`,
        '',
        `✅ Matched:         ${summary.matched}`,
        `❌ Missing in QBO:  ${summary.missing}`,
        `⚠️ Voided in QBO:   ${summary.voided}`,
        `🚫 Stale (canceled): ${summary.stale}`,
        `ℹ️ Orphan QBO:      ${summary.orphan}`,
    ];

    if (perChannel.length > 0) {
        head.push('', '<b>📡 Per Channel</b>');
        for (const c of perChannel) {
            const status = c.missing > 0 ? `❌ -${c.missing}`
                : c.voided > 0 ? `⚠️ -${c.voided}`
                : '✓';
            const label = `${c.channel} (${c.prefix})`.padEnd(20);
            head.push(`<code>${escapeHtml(label)} ${String(c.expected).padStart(3)} → ${String(c.matched).padStart(3)}</code> ${status}`);
        }
    }

    if (fetchErrors && fetchErrors.length > 0) {
        head.push('', '<b>⚠️ Fetch errors (partial data)</b>');
        for (const e of fetchErrors.slice(0, 5)) {
            head.push(`• ${escapeHtml(e.source)}: ${escapeHtml(String(e.error).slice(0, 200))}`);
        }
    }

    head.push('', `🕐 ${fmtWib()} WIB · ${runMs}ms`);

    await sendRaw(head.join('\n'));

    // ─── Mismatch detail messages ──────────────────────────────────────────
    const sections = [
        { key: 'missingInQbo', list: mismatches.missingInQbo, title: '❌ MISSING IN QBO', formatter: _fmtMissing },
        { key: 'voidedInQbo', list: mismatches.voidedInQbo, title: '⚠️ VOIDED IN QBO', formatter: _fmtMissing },
        { key: 'stale', list: mismatches.stale, title: '🚫 STALE (canceled in Jubelio, active in QBO)', formatter: _fmtStale },
        { key: 'mapMissingQbo', list: mismatches.mapMissingQbo, title: 'ℹ️ QBO HAS · MAP MISSING', formatter: _fmtMissing },
        { key: 'orphan', list: mismatches.orphan, title: 'ℹ️ ORPHAN QBO INVOICES', formatter: _fmtOrphan },
    ];

    for (const sec of sections) {
        if (!sec.list || sec.list.length === 0) continue;
        const chunks = _chunkMismatchSection(sec.title, sec.list, sec.formatter);
        for (const chunk of chunks) {
            await sendRaw(chunk);
        }
    }
};

// Split a long mismatch list into <4000 char Telegram messages. Each message
// has the section header so context isn't lost on continuation.
const _chunkMismatchSection = (title, list, formatter) => {
    const HARD_LIMIT = 3900; // safe under Telegram 4096
    const out = [];
    let buf = [`<b>${title} (${list.length})</b>`, ''];
    let bufLen = buf.join('\n').length;

    for (let i = 0; i < list.length; i++) {
        const block = formatter(list[i], i);
        const blockLen = block.length + 1;
        if (bufLen + blockLen > HARD_LIMIT && buf.length > 2) {
            buf.push('', `<i>… ${list.length - i} more (continued)</i>`);
            out.push(buf.join('\n'));
            buf = [`<b>${title} — cont. (${list.length})</b>`, ''];
            bufLen = buf.join('\n').length;
        }
        buf.push(block);
        bufLen += blockLen;
    }
    if (buf.length > 2) out.push(buf.join('\n'));
    return out;
};

const _fmtIdr = (n) => {
    if (n == null || isNaN(Number(n))) return '?';
    return 'Rp ' + Math.round(Number(n)).toLocaleString('id-ID');
};

const _fmtMissing = (m) => {
    const lines = [
        `📦 <b>${escapeHtml(m.salesorder_no || '?')}</b>`,
        `   id=${m.salesorder_id || '?'} · ${escapeHtml(m.channel || m.prefix || '?')} (${escapeHtml(m.source_name || '-')})`,
    ];
    if (m.customer_name) lines.push(`   👤 ${escapeHtml(m.customer_name)}`);
    lines.push(`   📊 status=<b>${escapeHtml(String(m.status || '-'))}</b> · total=${escapeHtml(_fmtIdr(m.grand_total))}`);
    if (m.transaction_date_raw) {
        lines.push(`   📅 txn_raw=<code>${escapeHtml(m.transaction_date_raw)}</code> · jkt=${escapeHtml(m.transaction_date_jkt || '?')}`);
    }
    if (m.tracking_no) lines.push(`   🚚 ${escapeHtml(String(m.tracking_no).slice(0, 40))}`);
    if (m.invoice_no) lines.push(`   🧾 jubelio_inv=${escapeHtml(m.invoice_no)}`);
    if (m.map_qbo_invoice_id) {
        lines.push(`   🔗 map.qbo_id=${escapeHtml(String(m.map_qbo_invoice_id))} · last_status=${escapeHtml(String(m.map_last_status || '-'))}`);
    }
    if (m.qbo_invoice_id) {
        lines.push(`   🟢 qbo_id=${escapeHtml(String(m.qbo_invoice_id))} · qbo_total=${escapeHtml(_fmtIdr(m.qbo_total))} · balance=${escapeHtml(_fmtIdr(m.qbo_balance))}`);
    }
    lines.push(`   💡 <i>${escapeHtml(m.why || m.sync_rule_reason || '')}</i>`);
    return lines.join('\n') + '\n';
};

const _fmtStale = (m) => {
    const lines = [
        `📦 <b>${escapeHtml(m.salesorder_no || '?')}</b>`,
        `   id=${m.salesorder_id || '?'} · ${escapeHtml(m.channel || m.prefix || '?')}`,
    ];
    if (m.customer_name) lines.push(`   👤 ${escapeHtml(m.customer_name)}`);
    if (m.cancel_reason) lines.push(`   🚫 reason: ${escapeHtml(String(m.cancel_reason).slice(0, 200))}`);
    lines.push(`   🟢 qbo_id=${escapeHtml(String(m.qbo_invoice_id))} · total=${escapeHtml(_fmtIdr(m.qbo_total))} · balance=${escapeHtml(_fmtIdr(m.qbo_balance))}`);
    lines.push(`   💡 <i>${escapeHtml(m.why)}</i>`);
    return lines.join('\n') + '\n';
};

const _fmtOrphan = (m) => {
    const lines = [
        `🟢 qbo_id=<b>${escapeHtml(String(m.qbo_invoice_id))}</b> · doc=${escapeHtml(String(m.doc_number || '-'))}`,
        `   total=${escapeHtml(_fmtIdr(m.qbo_total))} · balance=${escapeHtml(_fmtIdr(m.qbo_balance))} · cust_id=${escapeHtml(String(m.customer_ref || '-'))}`,
        `   💡 <i>${escapeHtml(m.why)}</i>`,
    ];
    return lines.join('\n') + '\n';
};

module.exports = {
    isConfigured,
    alertWebhookError,
    alertAuthRejected,
    alertAuditReport,
    alertResyncResult,
    alertDailyReconcile,
    sendTestAlert,
};
