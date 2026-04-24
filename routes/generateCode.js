const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const JubelioOrderMap = require('../models/JubelioOrderMap');

// Unambiguous alphabet: no 0/O/1/I/L. 31 chars → 31^18 ≈ 6×10^26 combinations
// (≈89 bits of entropy per body). Format LB-XXXXXXXXXXXXXXXXXX is 21 chars
// total, matching the QBO DocNumber max length.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const BODY_LENGTH = 18;
const MAX_ATTEMPTS = 10;

const CHANNELS = {
    LB: { name: 'La Brisa', terms: 'Net 14', accent: '#F59E0B' },
    CS: { name: 'Consignment', terms: 'Net 7', accent: '#10B981' },
    DP: { name: 'WhatsApp', terms: 'Net 14', accent: '#25D366' },
    DW: { name: 'Walk-in', terms: 'Net 14', accent: '#6366F1' },
};

const randomBody = (length = BODY_LENGTH) => {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) {
        out += ALPHABET[bytes[i] % ALPHABET.length];
    }
    return out;
};

// POST /api/codes/generate   body: { prefix: "LB" | "CS" | "DP" | "DW" }
router.post('/generate', async (req, res) => {
    const raw = (req.body && req.body.prefix) || req.query.prefix || '';
    const prefix = String(raw).trim().toUpperCase();
    const channel = CHANNELS[prefix];

    if (!channel) {
        return res.status(400).json({
            ok: false,
            error: 'invalid_prefix',
            message: `Prefix must be one of: ${Object.keys(CHANNELS).join(', ')}`,
            allowed: Object.keys(CHANNELS),
        });
    }

    let code = '';
    let body = '';
    let attempts = 0;

    for (attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
        body = randomBody(BODY_LENGTH);
        code = `${prefix}-${body}`;
        const exists = await JubelioOrderMap.findOne({ salesorder_no: code }).lean();
        if (!exists) break;
        if (attempts === MAX_ATTEMPTS) {
            return res.status(500).json({
                ok: false,
                error: 'collision_exhausted',
                message: `Unable to generate unique code after ${MAX_ATTEMPTS} attempts`,
                attempts,
            });
        }
    }

    return res.status(200).json({
        ok: true,
        code,
        prefix,
        body,
        length: { full: code.length, body: body.length },
        channel: { prefix, name: channel.name, terms: channel.terms },
        uniqueness: {
            checked: true,
            source: 'JubelioOrderMap.salesorder_no',
            collisionAttempts: attempts,
            existsInDatabase: false,
        },
        alphabet: {
            set: ALPHABET,
            size: ALPHABET.length,
            excludes: '0, 1, I, O, L (unambiguous)',
        },
        generatedAt: new Date().toISOString(),
    });
});

// GET /api/codes/generator — HTML UI (single-screen, no scroll)
router.get('/generator', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(HTML);
});

const HTML = `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SO Code Generator · Treelogy</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body { font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; }
  .font-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-feature-settings: 'ss02'; }

  .bg-aurora {
    background:
      radial-gradient(ellipse 60% 50% at 15% 10%, rgba(139, 92, 246, 0.20), transparent 60%),
      radial-gradient(ellipse 50% 40% at 85% 30%, rgba(99, 102, 241, 0.14), transparent 60%),
      radial-gradient(ellipse 40% 30% at 50% 110%, rgba(16, 185, 129, 0.10), transparent 60%);
  }
  .bg-grid {
    background-image: radial-gradient(circle at 1px 1px, rgba(255,255,255,0.06) 1px, transparent 0);
    background-size: 24px 24px;
  }
  .glass {
    background: rgba(255,255,255,0.03);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid rgba(255,255,255,0.08);
  }
  .btn-primary {
    background-image: linear-gradient(135deg, #8b5cf6 0%, #6366f1 50%, #3b82f6 100%);
    box-shadow: 0 10px 30px -10px rgba(99,102,241,0.55), inset 0 1px 0 rgba(255,255,255,0.15);
  }
  .btn-primary:hover { filter: brightness(1.08); }
  .btn-primary:active { transform: translateY(1px); }

  @keyframes popIn {
    from { opacity: 0; transform: translateY(8px) scale(0.99); }
    to   { opacity: 1; transform: none; }
  }
  .pop-in { animation: popIn 360ms cubic-bezier(0.22, 1, 0.36, 1); }

  @keyframes shimmerChar {
    0%   { opacity: 0; transform: translateY(-4px); filter: blur(4px); }
    100% { opacity: 1; transform: translateY(0); filter: blur(0); }
  }
  .char-reveal > span { display: inline-block; animation: shimmerChar 420ms ease forwards; opacity: 0; }

  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner { animation: spin 0.8s linear infinite; }

  @keyframes fadeSlide {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .toast { animation: fadeSlide 220ms ease; }

  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 999px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.14); }

  kbd {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10.5px;
    padding: 1px 5px;
    border-radius: 5px;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    border-bottom-width: 2px;
    color: rgb(212 212 216);
  }

  .channel-btn {
    position: relative;
    transition: transform 0.15s ease, border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
  }
  .channel-btn:hover { transform: translateY(-1px); }
  .channel-btn[data-selected="true"] {
    border-color: rgba(139, 92, 246, 0.55);
    background: linear-gradient(135deg, rgba(139, 92, 246, 0.14), rgba(99, 102, 241, 0.08));
    box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.14), 0 12px 32px -10px rgba(139, 92, 246, 0.4);
  }
  .channel-btn[data-selected="true"] .channel-check { opacity: 1; transform: scale(1); }
  .channel-check { opacity: 0; transform: scale(0.6); transition: all 0.2s ease; position: absolute; top: 10px; right: 10px; }

  /* Fit-to-viewport container: no page scroll, inner panes scroll independently if needed */
  .app-shell {
    display: grid;
    grid-template-rows: auto 1fr auto;
    height: 100svh;
    min-height: 100vh;
    max-height: 100vh;
  }
  .main-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    gap: 14px;
    min-height: 0;
  }
  @media (max-width: 880px) {
    .main-grid { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, auto); }
    .history-panel { max-height: 190px; }
  }

  .code-display {
    font-size: clamp(20px, 3.6vw, 38px);
    letter-spacing: 0.03em;
  }
</style>
</head>
<body class="relative bg-zinc-950 text-zinc-100">
  <div class="pointer-events-none absolute inset-0 bg-aurora"></div>
  <div class="pointer-events-none absolute inset-0 bg-grid opacity-40"></div>

  <div class="relative app-shell px-4 sm:px-6 py-3 sm:py-4 gap-3">

    <!-- ░░ Header ░░ -->
    <header class="flex items-center justify-between">
      <div class="flex items-center gap-2.5">
        <div class="flex h-9 w-9 items-center justify-center rounded-lg"
             style="background: linear-gradient(135deg, #8b5cf6, #3b82f6); box-shadow: 0 8px 20px -6px rgba(139,92,246,0.5);">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
        </div>
        <div class="leading-tight">
          <div class="text-[13px] font-semibold text-white">SO Code Generator</div>
          <div class="text-[11px] text-zinc-500">Jubelio ↔ QBO · Treelogy</div>
        </div>
      </div>
      <div class="flex items-center gap-2 rounded-full glass px-2.5 py-1">
        <div id="statusDot" class="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"></div>
        <span id="statusText" class="text-[11px] font-medium text-zinc-300">Ready</span>
      </div>
    </header>

    <!-- ░░ Main grid ░░ -->
    <main class="main-grid">
      <!-- Left column: channel picker + result -->
      <section class="glass rounded-2xl p-4 sm:p-5 flex flex-col min-h-0 overflow-hidden">
        <!-- Channel picker -->
        <div>
          <div class="flex items-center justify-between mb-2">
            <div class="text-[10px] uppercase tracking-[0.14em] text-zinc-500 font-bold">Channel</div>
            <div class="text-[10px] text-zinc-500 hidden sm:flex gap-1 items-center">
              <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><kbd>4</kbd>
            </div>
          </div>
          <div id="channelGrid" class="grid grid-cols-4 gap-2"></div>
        </div>

        <!-- Result area (flex-1) -->
        <div class="mt-4 flex-1 flex flex-col min-h-0">
          <!-- Empty -->
          <div id="emptyState" class="flex-1 flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 text-center p-4">
            <div class="flex h-10 w-10 items-center justify-center rounded-full bg-white/5">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-zinc-400">
                <rect x="3" y="8" width="18" height="13" rx="2"/><path d="M8 8V6a4 4 0 1 1 8 0v2"/>
              </svg>
            </div>
            <div class="mt-2 text-[13px] font-medium text-zinc-300">Pilih channel untuk mulai</div>
            <div class="text-[11px] text-zinc-500">Lalu tekan <kbd>Enter</kbd> atau klik Generate</div>
          </div>

          <!-- Result -->
          <div id="result" class="hidden flex-1 flex flex-col min-h-0">
            <!-- Meta pills -->
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-2">
                <span id="resChannelPill" class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold"></span>
                <span id="resTerms" class="text-[11px] text-zinc-400"></span>
                <span class="text-[11px] text-zinc-600">·</span>
                <span class="text-[11px] text-zinc-400">
                  <span id="resLength" class="font-mono">—</span> chars
                </span>
              </div>
              <div class="text-[11px] text-zinc-500">
                <span id="resTime">—</span>
              </div>
            </div>

            <!-- Big code display -->
            <div class="relative flex-1 rounded-xl border border-white/10 bg-gradient-to-br from-white/[0.04] to-transparent p-4 sm:p-5 flex items-center justify-center min-h-0">
              <div id="resCode" class="char-reveal font-mono font-semibold code-display break-all select-all text-center leading-tight"></div>
            </div>

            <!-- Actions + meta -->
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <button id="copyBtn" type="button"
                      class="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-medium text-zinc-200 hover:bg-white/10 transition">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                <span id="copyBtnLabel">Copy</span>
                <kbd class="!py-0 !px-1 text-[10px]">C</kbd>
              </button>
              <button id="regenBtn" type="button"
                      class="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-medium text-zinc-200 hover:bg-white/10 transition">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
                </svg>
                Regenerate
                <kbd class="!py-0 !px-1 text-[10px]">R</kbd>
              </button>

              <!-- Inline meta -->
              <div class="ml-auto flex items-center gap-3 text-[10.5px] text-zinc-500">
                <span title="Collision checks before unique">↻ <span id="resAttempts" class="font-mono text-zinc-300">—</span></span>
                <span title="Alphabet size">Σ <span id="resAlphabet" class="font-mono text-zinc-300">—</span></span>
                <span title="Entropy (bits)">⚡ <span id="resEntropy" class="font-mono text-zinc-300">—</span></span>
              </div>
            </div>
          </div>

          <div id="errorBox" class="hidden mt-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-[11.5px] text-red-200"></div>
        </div>

        <!-- Generate bar -->
        <div class="mt-4 flex items-center justify-between gap-3 border-t border-white/5 pt-4">
          <div id="summaryLine" class="text-[11.5px] text-zinc-400 truncate">Pilih channel dulu untuk mulai generate.</div>
          <button id="generateBtn" type="button"
                  class="btn-primary shrink-0 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
                  disabled>
            <svg id="genIcon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
            </svg>
            <span id="genLabel">Generate</span>
            <kbd class="ml-1 !bg-white/10 !border-white/20 !text-white">⏎</kbd>
          </button>
        </div>
      </section>

      <!-- Right column: history panel -->
      <aside class="glass rounded-2xl p-4 flex flex-col min-h-0 history-panel">
        <div class="flex items-center justify-between mb-2">
          <div class="text-[10px] uppercase tracking-[0.14em] text-zinc-500 font-bold">Recent</div>
          <button id="clearHistoryBtn" class="text-[10px] text-zinc-500 hover:text-zinc-300 transition">Clear</button>
        </div>
        <div id="historyEmpty" class="flex-1 flex items-center justify-center text-[11px] text-zinc-500 text-center px-2">
          Belum ada code di sesi ini.<br>Generate untuk mulai.
        </div>
        <div id="history" class="flex-1 overflow-y-auto pr-1 space-y-1.5 hidden"></div>
      </aside>
    </main>

    <!-- ░░ Footer ░░ -->
    <footer class="flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-zinc-500">
      <div class="flex items-center gap-3">
        <span>Endpoint <code class="font-mono text-zinc-400">POST /api/codes/generate</code></span>
        <span class="text-zinc-700 hidden sm:inline">|</span>
        <span class="hidden sm:inline">Unique vs <code class="font-mono text-zinc-400">JubelioOrderMap.salesorder_no</code></span>
      </div>
      <div class="flex items-center gap-1.5 hidden md:flex">
        <kbd>1-4</kbd>pick <kbd>⏎</kbd>gen <kbd>C</kbd>copy <kbd>R</kbd>regen
      </div>
    </footer>
  </div>

  <!-- Toast root -->
  <div id="toastRoot" class="pointer-events-none fixed inset-x-0 bottom-4 flex justify-center z-50"></div>

<script>
const CHANNELS = {
  LB: { name: 'La Brisa',    terms: 'Net 14', accent: '#F59E0B', emoji: '🌞', keyNum: '1' },
  CS: { name: 'Consignment', terms: 'Net 7',  accent: '#10B981', emoji: '🤝', keyNum: '2' },
  DP: { name: 'WhatsApp',    terms: 'Net 14', accent: '#25D366', emoji: '💬', keyNum: '3' },
  DW: { name: 'Walk-in',     terms: 'Net 14', accent: '#6366F1', emoji: '🚶', keyNum: '4' },
};
const HISTORY_KEY = 'soCodeHistory_v1';
let selected = null;
let lastResult = null;
let busy = false;

// ── Channel grid ───────────────────────────────────────
const channelGrid = document.getElementById('channelGrid');
Object.entries(CHANNELS).forEach(([prefix, ch]) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.prefix = prefix;
  btn.dataset.selected = 'false';
  btn.className = 'channel-btn rounded-xl border border-white/10 bg-white/[0.02] p-2.5 text-left';
  btn.innerHTML = \`
    <div class="channel-check">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/>
      </svg>
    </div>
    <div class="flex h-7 w-7 items-center justify-center rounded-md text-[14px]"
         style="background: \${ch.accent}22; color: \${ch.accent};">\${ch.emoji}</div>
    <div class="mt-2">
      <div class="flex items-baseline gap-1.5">
        <div class="font-mono text-[11px] font-bold" style="color: \${ch.accent};">\${prefix}</div>
        <div class="text-[9px] text-zinc-600">\${ch.keyNum}</div>
      </div>
      <div class="mt-0.5 text-[11.5px] font-semibold text-white leading-tight truncate">\${ch.name}</div>
      <div class="text-[10px] text-zinc-500">\${ch.terms}</div>
    </div>\`;
  btn.addEventListener('click', () => select(prefix));
  channelGrid.appendChild(btn);
});

function select(prefix) {
  selected = prefix;
  document.querySelectorAll('[data-prefix]').forEach(el => {
    el.dataset.selected = String(el.dataset.prefix === prefix);
  });
  const ch = CHANNELS[prefix];
  document.getElementById('summaryLine').innerHTML =
    \`<b style="color:\${ch.accent}">\${prefix}</b> · \${ch.name} · \${ch.terms}\`;
  document.getElementById('generateBtn').disabled = false;
}

// ── Generate ───────────────────────────────────────────
const generateBtn = document.getElementById('generateBtn');
generateBtn.addEventListener('click', generate);

async function generate() {
  if (!selected || busy) return;
  busy = true;
  setStatus('Generating…', 'amber');
  const icon = document.getElementById('genIcon');
  const label = document.getElementById('genLabel');
  icon.classList.add('spinner');
  label.textContent = 'Generating…';
  generateBtn.disabled = true;
  hideError();

  try {
    const res = await fetch('/api/codes/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: selected }),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      throw new Error(json.message || json.error || 'Unknown error');
    }
    lastResult = json;
    renderResult(json);
    pushHistory(json);
    setStatus('Ready', 'emerald');
  } catch (err) {
    showError(err.message || String(err));
    setStatus('Error', 'red');
  } finally {
    icon.classList.remove('spinner');
    label.textContent = 'Generate';
    generateBtn.disabled = false;
    busy = false;
  }
}

// ── Render result ──────────────────────────────────────
function renderResult(j) {
  document.getElementById('emptyState').classList.add('hidden');
  const wrap = document.getElementById('result');
  wrap.classList.remove('hidden');
  wrap.classList.remove('pop-in');
  void wrap.offsetWidth;
  wrap.classList.add('pop-in');

  const ch = CHANNELS[j.prefix];
  const pill = document.getElementById('resChannelPill');
  pill.textContent = \`\${j.prefix} · \${j.channel.name}\`;
  pill.style.backgroundColor = ch.accent + '22';
  pill.style.color = ch.accent;
  pill.style.border = '1px solid ' + ch.accent + '33';

  document.getElementById('resTerms').textContent = j.channel.terms;
  document.getElementById('resLength').textContent = j.length.full;

  const codeEl = document.getElementById('resCode');
  codeEl.innerHTML = '';
  j.code.split('').forEach((ch, i) => {
    const s = document.createElement('span');
    s.textContent = ch;
    s.style.animationDelay = (i * 20) + 'ms';
    codeEl.appendChild(s);
  });

  document.getElementById('resAttempts').textContent = j.uniqueness.collisionAttempts;
  document.getElementById('resAlphabet').textContent = j.alphabet.size;
  const entropyBits = Math.log2(j.alphabet.size) * j.length.body;
  document.getElementById('resEntropy').textContent = entropyBits.toFixed(0) + 'b';
  document.getElementById('resTime').textContent = new Date(j.generatedAt).toLocaleTimeString('id-ID');
}

// ── Copy ────────────────────────────────────────────────
async function copyCode() {
  if (!lastResult) return;
  try {
    await navigator.clipboard.writeText(lastResult.code);
    toast('Copied: ' + lastResult.code, 'emerald');
    const lbl = document.getElementById('copyBtnLabel');
    lbl.textContent = 'Copied';
    setTimeout(() => lbl.textContent = 'Copy', 1200);
  } catch {
    toast('Copy failed', 'red');
  }
}
document.getElementById('copyBtn').addEventListener('click', copyCode);
document.getElementById('regenBtn').addEventListener('click', generate);

// ── History ─────────────────────────────────────────────
function loadHistory() {
  try {
    const s = sessionStorage.getItem(HISTORY_KEY);
    return s ? JSON.parse(s) : [];
  } catch { return []; }
}
function saveHistory(items) { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 20))); }
function pushHistory(j) {
  const items = loadHistory();
  items.unshift({ code: j.code, prefix: j.prefix, channel: j.channel.name, time: j.generatedAt });
  saveHistory(items);
  renderHistory();
}
function renderHistory() {
  const items = loadHistory();
  const wrap = document.getElementById('history');
  const empty = document.getElementById('historyEmpty');
  if (items.length === 0) {
    wrap.classList.add('hidden');
    empty.classList.remove('hidden');
    wrap.innerHTML = '';
    return;
  }
  empty.classList.add('hidden');
  wrap.classList.remove('hidden');
  wrap.innerHTML = items.map((it) => {
    const ch = CHANNELS[it.prefix] || { accent: '#a3a3a3' };
    const t = new Date(it.time).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return \`
      <div class="group flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2 hover:border-white/10 hover:bg-white/[0.04] transition">
        <div class="flex items-center gap-2 min-w-0">
          <span class="inline-flex h-5 min-w-[2.2rem] items-center justify-center rounded text-[9px] font-bold"
                style="background:\${ch.accent}22;color:\${ch.accent};">\${it.prefix}</span>
          <div class="min-w-0">
            <div class="font-mono text-[10.5px] text-zinc-200 truncate">\${it.code}</div>
            <div class="text-[9px] text-zinc-600">\${t}</div>
          </div>
        </div>
        <button data-copy="\${it.code}" title="Copy" class="opacity-0 group-hover:opacity-100 transition rounded border border-white/10 bg-white/5 p-1 text-zinc-300 hover:bg-white/10">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
      </div>\`;
  }).join('');
  wrap.querySelectorAll('[data-copy]').forEach(b => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast('Copied', 'emerald');
      } catch { toast('Copy failed', 'red'); }
    });
  });
}
document.getElementById('clearHistoryBtn').addEventListener('click', () => {
  sessionStorage.removeItem(HISTORY_KEY);
  renderHistory();
  toast('History cleared', 'zinc');
});
renderHistory();

// ── UI helpers ───────────────────────────────────────────
function setStatus(text, color) {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  txt.textContent = text;
  const map = {
    emerald: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]',
    amber:   'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.8)]',
    red:     'bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.8)]',
    zinc:    'bg-zinc-400',
  };
  dot.className = 'h-1.5 w-1.5 rounded-full ' + (map[color] || map.emerald);
}
function showError(msg) {
  const b = document.getElementById('errorBox');
  b.textContent = '⚠ ' + msg;
  b.classList.remove('hidden');
}
function hideError() { document.getElementById('errorBox').classList.add('hidden'); }

function toast(text, color = 'emerald') {
  const root = document.getElementById('toastRoot');
  const n = document.createElement('div');
  const bg = { emerald: 'bg-emerald-500/95', red: 'bg-red-500/95', zinc: 'bg-zinc-700/95' }[color] || 'bg-zinc-700/95';
  n.className = 'toast pointer-events-auto rounded-full ' + bg + ' px-3.5 py-1.5 text-[12px] font-medium text-white shadow-lg';
  n.textContent = text;
  root.appendChild(n);
  setTimeout(() => { n.style.opacity = '0'; n.style.transform = 'translateY(6px)'; n.style.transition = 'all .2s'; }, 1500);
  setTimeout(() => n.remove(), 1800);
}

// ── Keyboard shortcuts ───────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Enter' && selected) { e.preventDefault(); generate(); return; }
  if (e.key === 'c' || e.key === 'C') { if (lastResult) copyCode(); return; }
  if (e.key === 'r' || e.key === 'R') { if (lastResult) generate(); return; }
  const keyMap = { '1': 'LB', '2': 'CS', '3': 'DP', '4': 'DW' };
  if (keyMap[e.key]) { select(keyMap[e.key]); }
});
</script>
</body>
</html>`;

module.exports = router;
