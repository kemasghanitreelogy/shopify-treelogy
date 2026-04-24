const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const JubelioOrderMap = require('../models/JubelioOrderMap');

// Unambiguous alphabet: no 0/O/1/I/L. 31 chars → 31^18 ≈ 6×10^26 combinations.
// Format PREFIX-XXXXXXXXXXXXXXXXXX is 21 chars, matching QBO DocNumber max.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const BODY_LENGTH = 18;
const MAX_ATTEMPTS = 10;

const CHANNELS = {
    LB: { name: 'La Brisa', terms: 'Net 14' },
    CS: { name: 'Consignment', terms: 'Net 7' },
    DP: { name: 'WhatsApp', terms: 'Net 14' },
    DW: { name: 'Walk-in', terms: 'Net 14' },
};

const randomBody = (length = BODY_LENGTH) => {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) {
        out += ALPHABET[bytes[i] % ALPHABET.length];
    }
    return out;
};

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

router.get('/generator', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(HTML);
});

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SO Code Generator</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body { font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; }
  .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }

  .channel {
    transition: all 0.15s ease;
  }
  .channel:hover { border-color: rgb(63 63 70); background: rgb(24 24 27); }
  .channel[data-selected="true"] {
    border-color: rgb(139 92 246);
    background: rgb(24 24 27);
    box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.15);
  }

  .btn {
    transition: all 0.15s ease;
  }
  .btn-primary { background: rgb(139 92 246); color: white; }
  .btn-primary:hover:not(:disabled) { background: rgb(124 58 237); }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-secondary { background: rgb(39 39 42); color: rgb(228 228 231); border: 1px solid rgb(63 63 70); }
  .btn-secondary:hover { background: rgb(52 52 56); }

  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: none; }
  }
  .fade-up { animation: fadeUp 300ms ease; }

  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { animation: spin 0.7s linear infinite; }

  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgb(39 39 42); border-radius: 999px; }
  ::-webkit-scrollbar-thumb:hover { background: rgb(63 63 70); }

  .shell {
    display: grid;
    grid-template-rows: auto 1fr;
    height: 100svh;
    max-height: 100vh;
  }
</style>
</head>
<body class="bg-zinc-950 text-zinc-100">

  <div class="shell">
    <!-- Header -->
    <header class="border-b border-zinc-900 px-6 py-3.5 flex items-center justify-between">
      <div class="text-sm font-semibold">SO Code Generator</div>
      <div id="status" class="text-xs text-zinc-500">Ready</div>
    </header>

    <!-- Body -->
    <div class="overflow-hidden px-6 py-6 mx-auto w-full max-w-2xl flex flex-col gap-6 min-h-0">

      <!-- Channel picker -->
      <div>
        <div class="text-xs text-zinc-500 mb-2">Channel</div>
        <div id="channelGrid" class="grid grid-cols-4 gap-2"></div>
      </div>

      <!-- Code display -->
      <div class="flex-1 flex flex-col min-h-0">
        <div id="emptyState" class="flex-1 flex items-center justify-center rounded-xl border border-dashed border-zinc-800 text-sm text-zinc-600">
          Pilih channel untuk mulai
        </div>

        <div id="result" class="hidden flex-1 flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 min-h-0">
          <div class="flex items-center justify-between text-xs text-zinc-500 mb-4">
            <div><span id="resChannel" class="text-zinc-300 font-medium"></span></div>
            <div id="resTime"></div>
          </div>
          <div class="flex-1 flex items-center justify-center">
            <div id="resCode" class="mono text-2xl sm:text-3xl md:text-[32px] font-semibold tracking-wide break-all select-all text-center"></div>
          </div>
          <div class="flex items-center justify-center gap-2 mt-4">
            <button id="copyBtn" class="btn btn-secondary rounded-lg px-4 py-2 text-sm font-medium">Copy</button>
            <button id="regenBtn" class="btn btn-secondary rounded-lg px-4 py-2 text-sm font-medium">New</button>
          </div>
        </div>

        <div id="errorBox" class="hidden mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200"></div>
      </div>

      <!-- Generate button -->
      <button id="generateBtn" class="btn btn-primary rounded-lg px-4 py-2.5 text-sm font-semibold" disabled>
        Generate
      </button>

      <!-- History -->
      <div class="min-h-0">
        <div class="flex items-center justify-between mb-2">
          <div class="text-xs text-zinc-500">Recent</div>
          <button id="clearHistoryBtn" class="text-xs text-zinc-600 hover:text-zinc-400 transition">Clear</button>
        </div>
        <div id="historyEmpty" class="text-xs text-zinc-600 py-2">—</div>
        <div id="history" class="space-y-1 max-h-[120px] overflow-y-auto hidden"></div>
      </div>

    </div>
  </div>

  <div id="toastRoot" class="pointer-events-none fixed inset-x-0 bottom-6 flex justify-center z-50"></div>

<script>
const CHANNELS = {
  LB: { name: 'La Brisa',    terms: 'Net 14' },
  CS: { name: 'Consignment', terms: 'Net 7'  },
  DP: { name: 'WhatsApp',    terms: 'Net 14' },
  DW: { name: 'Walk-in',     terms: 'Net 14' },
};
const HISTORY_KEY = 'soCodeHistory_v1';
let selected = null;
let lastResult = null;
let busy = false;

// Channels
const grid = document.getElementById('channelGrid');
Object.entries(CHANNELS).forEach(([prefix, ch]) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.prefix = prefix;
  btn.dataset.selected = 'false';
  btn.className = 'channel rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3 text-left';
  btn.innerHTML = \`
    <div class="mono text-sm font-semibold text-zinc-200">\${prefix}</div>
    <div class="text-xs text-zinc-500 mt-0.5">\${ch.name}</div>\`;
  btn.addEventListener('click', () => select(prefix));
  grid.appendChild(btn);
});

function select(prefix) {
  selected = prefix;
  document.querySelectorAll('[data-prefix]').forEach(el => {
    el.dataset.selected = String(el.dataset.prefix === prefix);
  });
  document.getElementById('generateBtn').disabled = false;
}

// Generate
const generateBtn = document.getElementById('generateBtn');
generateBtn.addEventListener('click', generate);

async function generate() {
  if (!selected || busy) return;
  busy = true;
  setStatus('Generating…');
  generateBtn.disabled = true;
  generateBtn.innerHTML = '<span class="inline-block h-3 w-3 rounded-full border-2 border-white/30 border-t-white spin"></span>';
  hideError();

  try {
    const res = await fetch('/api/codes/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: selected }),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.message || json.error || 'Failed');
    lastResult = json;
    renderResult(json);
    pushHistory(json);
    setStatus('Ready');
  } catch (err) {
    showError(err.message || String(err));
    setStatus('Error');
  } finally {
    generateBtn.textContent = 'Generate';
    generateBtn.disabled = false;
    busy = false;
  }
}

function renderResult(j) {
  document.getElementById('emptyState').classList.add('hidden');
  const wrap = document.getElementById('result');
  wrap.classList.remove('hidden');
  wrap.classList.remove('fade-up');
  void wrap.offsetWidth;
  wrap.classList.add('fade-up');

  document.getElementById('resChannel').textContent = \`\${j.prefix} · \${j.channel.name} · \${j.channel.terms}\`;
  document.getElementById('resTime').textContent = new Date(j.generatedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('resCode').textContent = j.code;
}

async function copyCode() {
  if (!lastResult) return;
  try {
    await navigator.clipboard.writeText(lastResult.code);
    toast('Copied');
  } catch {
    toast('Copy failed', true);
  }
}
document.getElementById('copyBtn').addEventListener('click', copyCode);
document.getElementById('regenBtn').addEventListener('click', generate);

// History
function loadHistory() {
  try { return JSON.parse(sessionStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}
function saveHistory(items) { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 15))); }
function pushHistory(j) {
  const items = loadHistory();
  items.unshift({ code: j.code, prefix: j.prefix, time: j.generatedAt });
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
    const t = new Date(it.time).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    return \`
      <button data-copy="\${it.code}" class="w-full flex items-center justify-between rounded px-2 py-1.5 text-left hover:bg-zinc-900 transition">
        <span class="mono text-xs text-zinc-300 truncate">\${it.code}</span>
        <span class="text-[10px] text-zinc-600 ml-2 shrink-0">\${t}</span>
      </button>\`;
  }).join('');
  wrap.querySelectorAll('[data-copy]').forEach(b => {
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast('Copied');
      } catch { toast('Copy failed', true); }
    });
  });
}
document.getElementById('clearHistoryBtn').addEventListener('click', () => {
  sessionStorage.removeItem(HISTORY_KEY);
  renderHistory();
});
renderHistory();

// Helpers
function setStatus(text) { document.getElementById('status').textContent = text; }
function showError(msg) {
  const b = document.getElementById('errorBox');
  b.textContent = msg;
  b.classList.remove('hidden');
}
function hideError() { document.getElementById('errorBox').classList.add('hidden'); }

function toast(text, isError = false) {
  const root = document.getElementById('toastRoot');
  const n = document.createElement('div');
  n.className = 'fade-up pointer-events-auto rounded-full px-4 py-1.5 text-xs font-medium ' +
                (isError ? 'bg-red-500 text-white' : 'bg-zinc-100 text-zinc-900');
  n.textContent = text;
  root.appendChild(n);
  setTimeout(() => { n.style.opacity = '0'; n.style.transition = 'opacity .2s'; }, 1400);
  setTimeout(() => n.remove(), 1700);
}

// Shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Enter' && selected) { e.preventDefault(); generate(); return; }
  if (e.key === 'c' || e.key === 'C') { if (lastResult) copyCode(); return; }
  const keyMap = { '1': 'LB', '2': 'CS', '3': 'DP', '4': 'DW' };
  if (keyMap[e.key]) select(keyMap[e.key]);
});
</script>
</body>
</html>`;

module.exports = router;
