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
        length: {
            full: code.length,
            body: body.length,
        },
        channel: {
            prefix,
            name: channel.name,
            terms: channel.terms,
        },
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

// GET /api/codes/generator — HTML UI
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
  * { -webkit-font-smoothing: antialiased; }
  body { font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; }
  .font-mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-feature-settings: 'ss02'; }

  .bg-grid {
    background-image:
      radial-gradient(circle at 1px 1px, rgba(255,255,255,0.06) 1px, transparent 0);
    background-size: 24px 24px;
  }
  .bg-aurora {
    background:
      radial-gradient(ellipse 80% 50% at 20% 0%, rgba(139, 92, 246, 0.18), transparent 60%),
      radial-gradient(ellipse 60% 50% at 80% 30%, rgba(99, 102, 241, 0.12), transparent 60%),
      radial-gradient(ellipse 50% 30% at 50% 100%, rgba(16, 185, 129, 0.10), transparent 60%);
  }
  .glass {
    background: rgba(255,255,255,0.03);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid rgba(255,255,255,0.08);
  }
  .chip-glow { box-shadow: 0 0 0 1px rgba(255,255,255,0.08), 0 4px 16px rgba(0,0,0,0.25); }
  .btn-primary {
    background-image: linear-gradient(135deg, #8b5cf6 0%, #6366f1 50%, #3b82f6 100%);
    box-shadow: 0 10px 30px -10px rgba(99,102,241,0.55), inset 0 1px 0 rgba(255,255,255,0.15);
  }
  .btn-primary:hover { filter: brightness(1.08); }
  .btn-primary:active { transform: translateY(1px); }

  @keyframes popIn {
    from { opacity: 0; transform: translateY(12px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  .pop-in { animation: popIn 420ms cubic-bezier(0.22, 1, 0.36, 1); }

  @keyframes shimmerChar {
    0%   { opacity: 0; transform: translateY(-4px); }
    30%  { opacity: 1; transform: translateY(0); }
    100% { opacity: 1; transform: translateY(0); }
  }
  .char-reveal > span { display: inline-block; animation: shimmerChar 500ms ease forwards; opacity: 0; }

  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner { animation: spin 0.8s linear infinite; }

  @keyframes fadeSlide {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .toast { animation: fadeSlide 220ms ease; }

  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 999px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.14); }

  kbd {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 6px;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    border-bottom-width: 2px;
    color: rgb(212 212 216);
  }

  .channel-btn {
    position: relative;
    transition: transform 0.15s ease, border-color 0.2s ease, background 0.2s ease;
  }
  .channel-btn:hover { transform: translateY(-2px); }
  .channel-btn[data-selected="true"] {
    border-color: rgba(139, 92, 246, 0.6);
    background: linear-gradient(135deg, rgba(139, 92, 246, 0.14), rgba(99, 102, 241, 0.08));
    box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.12), 0 12px 32px -10px rgba(139, 92, 246, 0.4);
  }
  .channel-btn[data-selected="true"] .channel-check { opacity: 1; transform: scale(1); }
  .channel-check { opacity: 0; transform: scale(0.6); transition: all 0.2s ease; }
</style>
</head>
<body class="relative min-h-screen bg-zinc-950 text-zinc-100">
  <div class="pointer-events-none absolute inset-0 bg-aurora"></div>
  <div class="pointer-events-none absolute inset-0 bg-grid opacity-40"></div>

  <div class="relative mx-auto max-w-4xl px-5 py-10 sm:py-14">
    <!-- Header -->
    <header class="flex items-center justify-between">
      <div class="flex items-center gap-3">
        <div class="flex h-10 w-10 items-center justify-center rounded-xl chip-glow"
             style="background: linear-gradient(135deg, #8b5cf6, #3b82f6);">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
        </div>
        <div>
          <div class="text-sm font-semibold text-white">SO Code Generator</div>
          <div class="text-xs text-zinc-400">Jubelio ↔ QuickBooks · Treelogy</div>
        </div>
      </div>
      <div class="hidden sm:flex items-center gap-2 rounded-full glass px-3 py-1.5">
        <div id="statusDot" class="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"></div>
        <span id="statusText" class="text-xs font-medium text-zinc-300">Ready</span>
      </div>
    </header>

    <!-- Hero -->
    <section class="mt-10 sm:mt-14">
      <h1 class="text-3xl sm:text-5xl font-bold tracking-tight">
        <span class="bg-gradient-to-r from-white via-zinc-200 to-zinc-400 bg-clip-text text-transparent">
          Generate a unique
        </span>
        <br>
        <span class="bg-gradient-to-r from-violet-300 via-indigo-300 to-sky-300 bg-clip-text text-transparent">
          Sales Order code.
        </span>
      </h1>
      <p class="mt-4 max-w-xl text-sm sm:text-base text-zinc-400">
        Pilih channel, tekan Generate. Kode 18 karakter acak akan di-cek ke MongoDB agar tidak bentrok dengan <code class="font-mono text-zinc-300">salesorder_no</code> yang sudah ada.
      </p>
    </section>

    <!-- Channel picker -->
    <section class="mt-10">
      <div class="mb-3 flex items-center justify-between">
        <div class="text-xs uppercase tracking-[0.12em] text-zinc-500 font-semibold">Channel</div>
        <div class="text-xs text-zinc-500">Keyboard: <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></div>
      </div>
      <div id="channelGrid" class="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <!-- filled by JS -->
      </div>
    </section>

    <!-- Generate + Result -->
    <section class="mt-8">
      <div class="glass rounded-2xl p-6 sm:p-8">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <div class="text-xs uppercase tracking-[0.12em] text-zinc-500 font-semibold">Action</div>
            <div class="mt-1 text-sm text-zinc-300">
              <span id="summaryLine">Pilih channel dulu.</span>
            </div>
          </div>
          <button id="generateBtn" type="button"
                  class="btn-primary inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white disabled:opacity-40 disabled:cursor-not-allowed"
                  disabled>
            <svg id="genIcon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
            </svg>
            <span id="genLabel">Generate Code</span>
            <kbd class="ml-1 !bg-white/10 !border-white/20 !text-white">⏎</kbd>
          </button>
        </div>

        <!-- Empty / Result -->
        <div id="emptyState" class="mt-8 flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 py-14 text-center">
          <div class="flex h-12 w-12 items-center justify-center rounded-full bg-white/5">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-zinc-400">
              <rect x="3" y="8" width="18" height="13" rx="2"/><path d="M8 8V6a4 4 0 1 1 8 0v2"/>
            </svg>
          </div>
          <div class="mt-3 text-sm font-medium text-zinc-300">Belum ada kode</div>
          <div class="mt-1 text-xs text-zinc-500">Pilih channel, generate akan muncul di sini</div>
        </div>

        <div id="result" class="hidden mt-8">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <span id="resChannelPill" class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"></span>
              <span class="text-xs text-zinc-500">·</span>
              <span id="resTerms" class="text-xs text-zinc-400"></span>
            </div>
            <div class="text-xs text-zinc-500">
              Length <span id="resLength" class="font-mono text-zinc-300">—</span>
            </div>
          </div>
          <div class="group relative rounded-xl border border-white/10 bg-white/[0.03] p-5 sm:p-6">
            <div id="resCode" class="char-reveal font-mono text-xl sm:text-3xl md:text-4xl font-semibold tracking-[0.04em] break-all select-all"></div>
            <div class="mt-4 flex flex-wrap items-center gap-2">
              <button id="copyBtn" type="button"
                      class="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-white/10 transition">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
                <span id="copyBtnLabel">Copy</span>
                <kbd class="!py-0.5 !px-1.5">C</kbd>
              </button>
              <button id="regenBtn" type="button"
                      class="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-white/10 transition">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
                </svg>
                Regenerate
                <kbd class="!py-0.5 !px-1.5">R</kbd>
              </button>
              <button id="jsonBtn" type="button"
                      class="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-white/10 transition">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
                </svg>
                View JSON
              </button>
            </div>
          </div>

          <!-- Meta grid -->
          <div class="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div class="rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <div class="text-zinc-500">Collision checks</div>
              <div id="resAttempts" class="mt-1 font-mono font-semibold text-zinc-200">—</div>
            </div>
            <div class="rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <div class="text-zinc-500">Alphabet size</div>
              <div id="resAlphabet" class="mt-1 font-mono font-semibold text-zinc-200">—</div>
            </div>
            <div class="rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <div class="text-zinc-500">Entropy</div>
              <div id="resEntropy" class="mt-1 font-mono font-semibold text-zinc-200">—</div>
            </div>
            <div class="rounded-lg border border-white/5 bg-white/[0.02] p-3">
              <div class="text-zinc-500">Generated</div>
              <div id="resTime" class="mt-1 font-mono font-semibold text-zinc-200">—</div>
            </div>
          </div>

          <!-- JSON drawer -->
          <div id="jsonDrawer" class="hidden mt-4">
            <pre id="jsonPre" class="overflow-x-auto rounded-lg border border-white/10 bg-zinc-950/60 p-4 text-xs font-mono text-emerald-200/90"></pre>
          </div>
        </div>

        <div id="errorBox" class="hidden mt-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200"></div>
      </div>
    </section>

    <!-- History -->
    <section class="mt-10">
      <div class="flex items-center justify-between mb-3">
        <div class="text-xs uppercase tracking-[0.12em] text-zinc-500 font-semibold">Recent</div>
        <button id="clearHistoryBtn" class="text-xs text-zinc-500 hover:text-zinc-300">Clear</button>
      </div>
      <div id="history" class="space-y-2"></div>
      <div id="historyEmpty" class="text-sm text-zinc-500">Belum ada history di sesi ini.</div>
    </section>

    <footer class="mt-14 pb-6 text-center text-xs text-zinc-600">
      <div>
        Endpoint <code class="font-mono text-zinc-400">POST /api/codes/generate</code>
        · Unique against <code class="font-mono text-zinc-400">JubelioOrderMap.salesorder_no</code>
      </div>
      <div class="mt-2">
        Shortcuts: <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><kbd>4</kbd> pick · <kbd>Enter</kbd> generate · <kbd>C</kbd> copy · <kbd>R</kbd> regenerate
      </div>
    </footer>
  </div>

  <!-- Toast -->
  <div id="toastRoot" class="pointer-events-none fixed inset-x-0 bottom-6 flex justify-center"></div>

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
  btn.className = 'channel-btn group rounded-2xl border border-white/10 bg-white/[0.02] p-4 text-left';
  btn.innerHTML = \`
    <div class="flex items-start justify-between">
      <div class="flex h-9 w-9 items-center justify-center rounded-lg text-lg"
           style="background: \${ch.accent}22; color: \${ch.accent};">\${ch.emoji}</div>
      <div class="channel-check">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/>
        </svg>
      </div>
    </div>
    <div class="mt-3">
      <div class="flex items-baseline gap-2">
        <div class="font-mono text-sm font-semibold" style="color: \${ch.accent};">\${prefix}</div>
        <div class="text-xs text-zinc-500">\${ch.keyNum}</div>
      </div>
      <div class="mt-0.5 text-sm font-semibold text-white">\${ch.name}</div>
      <div class="mt-0.5 text-xs text-zinc-500">\${ch.terms}</div>
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
    \`Channel <b>\${ch.name}</b> · Prefix <span class="font-mono" style="color:\${ch.accent}">\${prefix}</span> · Terms \${ch.terms}\`;
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
    label.textContent = 'Generate Code';
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
  // Force reflow to restart animation
  void wrap.offsetWidth;
  wrap.classList.add('pop-in');

  const ch = CHANNELS[j.prefix];
  const pill = document.getElementById('resChannelPill');
  pill.textContent = \`\${j.prefix} · \${j.channel.name}\`;
  pill.style.backgroundColor = ch.accent + '22';
  pill.style.color = ch.accent;
  pill.style.border = '1px solid ' + ch.accent + '33';

  document.getElementById('resTerms').textContent = j.channel.terms;
  document.getElementById('resLength').textContent = j.length.full + ' chars';

  // Char-by-char reveal
  const codeEl = document.getElementById('resCode');
  codeEl.innerHTML = '';
  j.code.split('').forEach((ch, i) => {
    const s = document.createElement('span');
    s.textContent = ch;
    s.style.animationDelay = (i * 22) + 'ms';
    codeEl.appendChild(s);
  });

  document.getElementById('resAttempts').textContent = j.uniqueness.collisionAttempts;
  document.getElementById('resAlphabet').textContent = j.alphabet.size + ' chars';
  const entropyBits = Math.log2(j.alphabet.size) * j.length.body;
  document.getElementById('resEntropy').textContent = entropyBits.toFixed(0) + ' bits';
  const d = new Date(j.generatedAt);
  document.getElementById('resTime').textContent = d.toLocaleTimeString('id-ID');

  document.getElementById('jsonPre').textContent = JSON.stringify(j, null, 2);
  document.getElementById('jsonDrawer').classList.add('hidden');
  document.getElementById('jsonBtn').textContent = 'View JSON';
}

// ── Copy ────────────────────────────────────────────────
async function copyCode() {
  if (!lastResult) return;
  try {
    await navigator.clipboard.writeText(lastResult.code);
    toast('Copied to clipboard', 'emerald');
    const lbl = document.getElementById('copyBtnLabel');
    lbl.textContent = 'Copied';
    setTimeout(() => lbl.textContent = 'Copy', 1200);
  } catch (e) {
    toast('Copy failed', 'red');
  }
}
document.getElementById('copyBtn').addEventListener('click', copyCode);
document.getElementById('regenBtn').addEventListener('click', generate);
document.getElementById('jsonBtn').addEventListener('click', () => {
  const d = document.getElementById('jsonDrawer');
  const btn = document.getElementById('jsonBtn');
  d.classList.toggle('hidden');
  btn.querySelector('svg').nextSibling && (btn.childNodes[btn.childNodes.length - 1].textContent = '');
  const isHidden = d.classList.contains('hidden');
  const text = document.createTextNode(isHidden ? 'View JSON' : 'Hide JSON');
  // Simpler: just re-render the label
  btn.lastChild.textContent = isHidden ? 'View JSON' : 'Hide JSON';
});

// ── History ─────────────────────────────────────────────
function loadHistory() {
  try {
    const s = sessionStorage.getItem(HISTORY_KEY);
    return s ? JSON.parse(s) : [];
  } catch { return []; }
}
function saveHistory(items) {
  sessionStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 15)));
}
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
    wrap.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  wrap.innerHTML = items.map((it, i) => {
    const ch = CHANNELS[it.prefix] || { accent: '#a3a3a3' };
    const t = new Date(it.time).toLocaleTimeString('id-ID');
    return \`
      <div class="group flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.02] px-4 py-3 hover:border-white/10 transition">
        <div class="flex items-center gap-3 min-w-0">
          <span class="inline-flex h-6 min-w-[2.5rem] items-center justify-center rounded-md text-[10px] font-bold"
                style="background:\${ch.accent}22;color:\${ch.accent};">\${it.prefix}</span>
          <span class="font-mono text-sm text-zinc-200 truncate">\${it.code}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-zinc-500 hidden sm:inline">\${t}</span>
          <button data-copy="\${it.code}" class="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-zinc-300 hover:bg-white/10 transition">Copy</button>
        </div>
      </div>\`;
  }).join('');
  wrap.querySelectorAll('[data-copy]').forEach(b => {
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast('Copied ' + b.dataset.copy, 'emerald');
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
    emerald: ['bg-emerald-400', 'shadow-[0_0_8px_rgba(52,211,153,0.8)]'],
    amber:   ['bg-amber-400',   'shadow-[0_0_8px_rgba(251,191,36,0.8)]'],
    red:     ['bg-red-400',     'shadow-[0_0_8px_rgba(248,113,113,0.8)]'],
    zinc:    ['bg-zinc-400',    ''],
  };
  dot.className = 'h-2 w-2 rounded-full ' + (map[color] || map.emerald).join(' ');
}
function showError(msg) {
  const b = document.getElementById('errorBox');
  b.textContent = '❌ ' + msg;
  b.classList.remove('hidden');
}
function hideError() { document.getElementById('errorBox').classList.add('hidden'); }

function toast(text, color = 'emerald') {
  const root = document.getElementById('toastRoot');
  const n = document.createElement('div');
  const bg = { emerald: 'bg-emerald-500/90', red: 'bg-red-500/90', zinc: 'bg-zinc-700/95' }[color] || 'bg-zinc-700/95';
  n.className = 'toast pointer-events-auto rounded-full ' + bg + ' px-4 py-2 text-sm font-medium text-white shadow-lg';
  n.textContent = text;
  root.appendChild(n);
  setTimeout(() => { n.style.opacity = '0'; n.style.transform = 'translateY(6px)'; n.style.transition = 'all .2s'; }, 1600);
  setTimeout(() => n.remove(), 1900);
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
