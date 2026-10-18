// Runs in the AI Studio page (MAIN world), only inside the proxy's own worker tab.
(() => {
  const FLAG = '__ais_worker';
  try {
    if (location.hash.includes('ais-worker')) sessionStorage.setItem(FLAG, '1');
    if (sessionStorage.getItem(FLAG) !== '1') return;
  } catch (e) { return; }

  const ais = (window.__ais = window.__ais || { streams: {} });
  // captured at document_start, before Angular's zone.js wraps fetch
  const nativeFetch = window.fetch.bind(window);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = (msg) => window.postMessage({ __aisOut: msg }, location.origin);
  const ORIGIN = 'https://aistudio.google.com';

  // Synchronous SHA-1: crypto.subtle completions get deferred in throttled background tabs.
  function sha1Hex(str) {
    const bytes = new TextEncoder().encode(str);
    const len = bytes.length;
    const words = new Uint32Array((((len + 8) >> 6) + 1) * 16);
    for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
    words[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
    words[words.length - 1] = len * 8;
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const w = new Uint32Array(80);
    for (let off = 0; off < words.length; off += 16) {
      for (let t = 0; t < 16; t++) w[t] = words[off + t];
      for (let t = 16; t < 80; t++) { const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]; w[t] = (x << 1) | (x >>> 31); }
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let t = 0; t < 80; t++) {
        const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
        const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
        const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0;
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    return [h0, h1, h2, h3, h4].map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
  }

  // Keep this background tab from being frozen / intensively throttled by Chrome:
  // pages holding a Web Lock or an active WebRTC connection are exempt.
  function keepAlive() {
    try { navigator.locks.request('ais-worker-keepalive', () => new Promise(() => {})); } catch (e) { /* ignore */ }
    try {
      const a = new RTCPeerConnection();
      const b = new RTCPeerConnection();
      a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
      b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
      const ch = a.createDataChannel('keepalive');
      ch.onopen = () => setInterval(() => { try { ch.send('1'); } catch (e) { /* ignore */ } }, 20000);
      a.createOffer().then((o) => a.setLocalDescription(o)).then(() => b.setRemoteDescription(a.localDescription))
        .then(() => b.createAnswer()).then((o) => b.setLocalDescription(o)).then(() => a.setRemoteDescription(b.localDescription))
        .catch(() => {});
      ais.keepAlive = { a, b, ch };
    } catch (e) { /* ignore */ }
  }
  keepAlive();

  function cookies() {
    const o = {};
    for (const kv of document.cookie.split('; ')) {
      const i = kv.indexOf('=');
      if (i > 0) o[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return o;
  }

  function authHeader() {
    const c = cookies();
    const base = c.SAPISID || c['__Secure-1PAPISID'];
    if (!base) throw new Error('no SAPISID cookie (not logged in?)');
    const ts = Math.floor(Date.now() / 1000);
    const h = (v) => sha1Hex(`${ts} ${v} ${ORIGIN}`);
    return `SAPISIDHASH ${ts}_${h(base)} SAPISID1PHASH ${ts}_${h(c['__Secure-1PAPISID'] || base)} SAPISID3PHASH ${ts}_${h(c['__Secure-3PAPISID'] || base)}`;
  }

  function headers() {
    return { ...ais.captured.headers, Authorization: authHeader() };
  }

  function authUser() {
    const m = location.pathname.match(/\/u\/(\d+)\//);
    return m ? Number(m[1]) : 0;
  }

  function email() {
    const RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
    for (const el of document.querySelectorAll('[aria-label*="@"], [data-email], img[alt*="@"], [title*="@"]')) {
      const s = [el.getAttribute('data-email'), el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('alt')].join(' ');
      const m = s.match(RE);
      if (m) return m[0].toLowerCase();
    }
    return '';
  }

  function installHooks() {
    const dms = window.default_MakerSuite;
    if (!dms) return null;
    if (ais.snapKey && dms[ais.snapKey] && dms[ais.snapKey].__aisHooked) return ais.snapKey;
    const isSnap = (fn) => {
      if (typeof fn !== 'function') return false;
      try {
        const s = fn.toString();
        return (s.includes('.snapshot(') || s.includes('snapshot({') || s.includes('.snapshot)')) &&
          (s.includes('content') || s.includes('yield') || s.includes('Promise'));
      } catch (e) { return false; }
    };
    let key = null;
    for (const k of Object.keys(dms)) { try { if (isSnap(dms[k])) { key = k; break; } } catch (e) {} }
    if (!key) return null;
    const orig = dms[key];
    const w = function (...a) {
      if (a[0] && typeof a[0] === 'object') ais.service = a[0];
      return orig.apply(this, a);
    };
    w.__aisHooked = true;
    w.__aisOrig = orig;
    dms[key] = w;
    ais.snapKey = key;
    return key;
  }

  // Capture (and swallow) the UI's own GenerateContent request; block prompt saving in this tab.
  function patchNetwork() {
    if (ais.patched) return;
    ais.patched = true;
    const oOpen = XMLHttpRequest.prototype.open;
    const oSend = XMLHttpRequest.prototype.send;
    const oSet = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = String(u); this.__h = {}; return oOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) { if (this.__h) this.__h[k] = v; return oSet.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (b) {
      const u = this.__u || '';
      if (ais.capturing && u.includes('/GenerateContent')) {
        ais.captured = { url: u, headers: { ...this.__h }, body: String(b) };
        this.abort();
        return;
      }
      if (/SavePrompt|CreatePrompt/.test(u)) { this.abort(); return; }
      return oSend.apply(this, arguments);
    };
    const oFetch = window.fetch;
    window.fetch = function (input, init) {
      const u = String(typeof input === 'string' ? input : input && input.url);
      if (ais.capturing && u.includes('/GenerateContent') && init && init.body) {
        const h = {};
        new Headers(init.headers || {}).forEach((v, k) => { h[k] = v; });
        ais.captured = { url: u, headers: h, body: String(init.body) };
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      }
      if (/SavePrompt|CreatePrompt/.test(u)) return Promise.resolve(new Response('[]', { status: 200 }));
      return oFetch.apply(this, arguments);
    };
    ais.fetch = oFetch;
  }

  async function dismissDialogs() {
    const words = ['同意', '我同意', '继续', '确认', '接受', '知道了', 'agree', 'accept', 'i agree', 'continue', 'confirm', 'get started', 'got it', 'ok', 'dismiss', 'close', 'no thanks'];
    for (const d of document.querySelectorAll('mat-dialog-container, cdk-dialog-container, [role="dialog"]')) {
      d.querySelectorAll('input[type="checkbox"]:not(:checked)').forEach((cb) => { try { cb.click(); } catch (e) {} });
      for (const b of d.querySelectorAll('button')) {
        if (b.disabled) continue;
        const t = (b.textContent || '').trim().toLowerCase();
        if (words.some((w) => t === w || t.includes(w))) { try { b.click(); } catch (e) {} break; }
      }
    }
  }

  function fill(text) {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    ta.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function clickRun() {
    const run = [...document.querySelectorAll('button')].find((b) => {
      if (b.disabled) return false;
      const t = (b.innerText || '').trim();
      const l = b.getAttribute('aria-label') || '';
      return t === 'Run' || t.startsWith('Run') || l === 'Run' || t === '运行' || b.classList.contains('ctrl-enter-submits') || b.classList.contains('run-button');
    });
    if (run) { run.click(); return true; }
    const ta = document.querySelector('textarea');
    if (ta) ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: true, bubbles: true }));
    return false;
  }

  async function bootstrap() {
    const t0 = Date.now();
    while (!(window.default_MakerSuite && document.querySelector('textarea'))) {
      if (Date.now() - t0 > 60000) throw new Error('AI Studio page did not load (no textarea)');
      await dismissDialogs();
      await sleep(500);
    }
    await dismissDialogs();
    let key = null;
    for (let i = 0; i < 10 && !key; i++) { key = installHooks(); if (!key) await sleep(800); }
    if (!key) throw new Error('BotGuard snapshot function not found');
    patchNetwork();
    ais.captured = null;
    ais.capturing = true;
    try {
      for (let attempt = 0; attempt < 3 && !ais.captured; attempt++) {
        fill('hi');
        await sleep(500);
        clickRun();
        for (let i = 0; i < 50 && !ais.captured; i++) await sleep(200);
        if (!ais.captured) await dismissDialogs();
      }
    } finally {
      ais.capturing = false;
      fill('');
    }
    if (!ais.captured) throw new Error('could not capture GenerateContent template (Run not clicked?)');
    for (let i = 0; i < 25 && !ais.service; i++) await sleep(200);
    if (!ais.service) throw new Error('BotGuardService not captured');
    const h = ais.captured.headers;
    for (const k of Object.keys(h)) if (/^(authorization|content-length)$/i.test(k)) delete h[k];
    return { url: ais.captured.url, body: ais.captured.body, email: email(), authUser: authUser(), ms: Date.now() - t0 };
  }

  async function snapshot(hash) {
    const dms = window.default_MakerSuite;
    if (!dms || !ais.service || !ais.snapKey) throw new Error('service_unavailable');
    const fn = dms[ais.snapKey].__aisOrig || dms[ais.snapKey];
    const run = async () => {
      const s = await Promise.resolve(fn(ais.service, hash));
      if (!s || typeof s !== 'string') throw new Error('empty_snapshot');
      return s;
    };
    const cur = (ais.snapQueue || Promise.resolve()).catch(() => {}).then(run);
    ais.snapQueue = cur;
    return await cur;
  }

  async function stream({ rid, body, timeoutMs }) {
    const push = (ev) => out({ ev: { ...ev, rid } });
    const ctrl = new AbortController();
    let idle = null;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => { push({ t: 'error', message: 'timeout' }); ctrl.abort(); }, timeoutMs); };
    const done = () => { clearTimeout(idle); delete ais.streams[rid]; };
    ais.streams[rid] = () => { done(); ctrl.abort(); };
    arm();
    (async () => {
      try {
        const res = await nativeFetch(ais.captured.url, { method: 'POST', headers: headers(), body, credentials: 'include', signal: ctrl.signal });
        arm();
        push({ t: 'status', status: res.status });
        const reader = res.body.getReader();
        const dec = new TextDecoder('utf-8');
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          arm();
          const text = dec.decode(value, { stream: true });
          if (text) push({ t: 'chunk', text });
        }
        const rest = dec.decode();
        if (rest) push({ t: 'chunk', text: rest });
        push({ t: 'done' });
      } catch (err) {
        push(err && err.name === 'AbortError' ? { t: 'aborted' } : { t: 'error', message: String((err && err.message) || err) });
      } finally {
        done();
      }
    })();
    return true;
  }

  async function listModels() {
    const url = ais.captured.url.replace(/\/GenerateContent.*$/, '/ListModels');
    const res = await nativeFetch(url, { method: 'POST', headers: headers(), body: '[]', credentials: 'include' });
    return { status: res.status, text: await res.text() };
  }

  // Bootstrap split into instant steps; the proxy does the waiting, because Chrome throttles
  // setTimeout in background tabs to about once a minute.
  const steps = {
    prep: async () => {
      const ready = !!(window.default_MakerSuite && document.querySelector('textarea'));
      if (!ready) { await dismissDialogs(); return { ready: false, href: location.href }; }
      await dismissDialogs();
      const key = installHooks();
      if (key) patchNetwork();
      return { ready: true, key };
    },
    // page already handshaken by an earlier proxy run: hand back the existing template
    reuse: async () => {
      if (!ais.captured || !ais.service || !ais.snapKey) return null;
      return { url: ais.captured.url, body: ais.captured.body, email: email(), authUser: authUser(), service: true };
    },
    fill: async () => { ais.captured = null; ais.capturing = true; return fill('hi'); },
    run: async () => clickRun(),
    poll: async () => ({ captured: !!ais.captured, service: !!ais.service }),
    finish: async () => {
      ais.capturing = false;
      fill('');
      if (!ais.captured) throw new Error('could not capture GenerateContent template');
      const h = ais.captured.headers;
      for (const k of Object.keys(h)) if (/^(authorization|content-length)$/i.test(k)) delete h[k];
      return { url: ais.captured.url, body: ais.captured.body, email: email(), authUser: authUser(), service: !!ais.service };
    },
    dismiss: async () => { await dismissDialogs(); return true; },
    // what the page looks like when the template capture fails
    diag: async () => {
      const ta = document.querySelector('textarea');
      const runs = [...document.querySelectorAll('button')].filter((b) => {
        const t = (b.innerText || '').trim();
        return t.startsWith('Run') || t === '运行' || b.classList.contains('ctrl-enter-submits') || b.classList.contains('run-button');
      }).map((b) => ({ text: (b.innerText || '').trim().slice(0, 30), disabled: b.disabled, cls: b.className.slice(0, 60) }));
      const dialogs = [...document.querySelectorAll('mat-dialog-container, cdk-dialog-container, [role="dialog"], [role="alertdialog"]')]
        .map((d) => (d.innerText || '').trim().slice(0, 160));
      const banners = [...document.querySelectorAll('[role="alert"], .mat-mdc-snack-bar-container, ms-callout, .error')]
        .map((d) => (d.innerText || '').trim().slice(0, 160)).filter(Boolean);
      return { href: location.href, title: document.title, textarea: ta ? ta.value.slice(0, 40) : null, runs, dialogs, banners, capturing: !!ais.capturing, patched: !!ais.patched, snapKey: ais.snapKey || null };
    },
  };

  const handlers = {
    step: async (name) => steps[name](),
    state: async () => ({ href: location.href, authUser: authUser(), dms: !!window.default_MakerSuite, ready: !!(ais.service && ais.captured), email: email() }),
    bootstrap,
    snapshot,
    stream,
    abort: async (rid) => { const f = ais.streams[rid]; if (f) f(); return !!f; },
    listModels,
  };

  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || !e.data.__aisIn) return;
    const { id, cmd, arg } = e.data.__aisIn;
    try {
      const h = handlers[cmd];
      if (!h) throw new Error('unknown command ' + cmd);
      out({ id, ok: true, result: await h(arg) });
    } catch (err) {
      out({ id, ok: false, error: String((err && err.message) || err) });
    }
  });
})();
