// Scripts evaluated inside the AI Studio tab.

export const PAGE_STATE_JS = `(() => ({
  href: location.href,
  dms: !!window.default_MakerSuite,
  textarea: !!document.querySelector('textarea'),
  hooked: !!(window.__ais && window.__ais.snapKey),
  service: !!(window.__ais && window.__ais.service),
}))()`;

// Locates the BotGuard snapshot function on default_MakerSuite and wraps it so the
// first real call from the UI hands us the BotGuardService instance.
export const INSTALL_HOOKS_JS = `(() => {
  const ais = window.__ais = window.__ais || {};
  const dms = window.default_MakerSuite;
  if (!dms) return 'no_dms';
  if (ais.snapKey && dms[ais.snapKey] && dms[ais.snapKey].__aisHooked) return 'hooked:' + ais.snapKey;
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
  if (!key) return 'no_snapshot_fn';
  const orig = dms[key];
  const wrapped = function (...args) {
    if (args[0] && typeof args[0] === 'object') ais.service = args[0];
    return orig.apply(this, args);
  };
  wrapped.__aisHooked = true;
  wrapped.__aisOrig = orig;
  dms[key] = wrapped;
  ais.snapKey = key;
  ais.snapQueue = Promise.resolve();
  ais.streams = {};
  return 'hooked:' + key;
})()`;

export const SNAPSHOT_JS = `(async (hash) => {
  const ais = window.__ais || {};
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
})`;

// Streams the GenerateContent response back through the CDP binding.
export const STREAM_JS = `((a) => {
  const ais = window.__ais = window.__ais || {};
  ais.streams = ais.streams || {};
  const push = (ev) => { ev.rid = a.rid; try { window[a.binding](JSON.stringify(ev)); } catch (e) {} };
  const ctrl = new AbortController();
  let idle = null;
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => { push({ t: 'error', message: 'timeout' }); ctrl.abort(); }, a.timeoutMs); };
  const done = () => { clearTimeout(idle); delete ais.streams[a.rid]; };
  ais.streams[a.rid] = () => { done(); ctrl.abort(); };
  arm();
  fetch(a.url, { method: 'POST', headers: a.headers, body: a.body, credentials: 'include', signal: ctrl.signal })
    .then(async (res) => {
      arm();
      push({ t: 'status', status: res.status });
      if (!res.body) { push({ t: 'done' }); done(); return; }
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
      done();
    })
    .catch((err) => {
      push(err && err.name === 'AbortError' ? { t: 'aborted' } : { t: 'error', message: String((err && err.message) || err) });
      done();
    });
  return true;
})`;

export const ABORT_JS = `((rid) => { const f = window.__ais && window.__ais.streams && window.__ais.streams[rid]; if (f) f(); return !!f; })`;

export const SIMPLE_POST_JS = `(async (a) => {
  const res = await fetch(a.url, { method: 'POST', headers: a.headers, body: a.body, credentials: 'include' });
  return { status: res.status, text: await res.text() };
})`;

export const DIALOG_CLEANUP_JS = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cookieBtn = document.querySelector('.glue-cookie-notification-bar__accept, button[data-glue-cookie-notification-bar-accept]');
  if (cookieBtn) { try { cookieBtn.click(); } catch (e) {} }
  const dialogs = Array.from(document.querySelectorAll('mat-dialog-container, cdk-dialog-container, ms-g1-welcome-dialog, [role="dialog"]'));
  if (!dialogs.length) return 0;
  const words = ['同意', '我同意', '继续', '确认', '开始', '接受', '知道了', '关闭', 'agree', 'accept', 'i agree', 'continue', 'confirm', 'get started', 'start building', 'got it', 'ok', 'dismiss', 'close', 'no thanks'];
  let clicked = 0;
  for (const d of dialogs) {
    d.querySelectorAll('mat-checkbox:not(.mat-mdc-checkbox-checked) input, input[type="checkbox"]:not(:checked)').forEach((cb) => { try { cb.click(); } catch (e) {} });
    await sleep(80);
    for (const b of d.querySelectorAll('button')) {
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
      const t = (b.textContent || '').trim().toLowerCase();
      if (words.some((w) => t === w || t.includes(w))) { try { b.click(); clicked++; } catch (e) {} break; }
    }
  }
  return clicked;
})()`;

export const FILL_PROMPT_JS = `((text) => {
  const ta = document.querySelector('textarea');
  if (!ta) return false;
  ta.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, text);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})`;

export const CLICK_RUN_JS = `(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const run = btns.find((b) => {
    if (b.disabled) return false;
    const t = (b.innerText || b.textContent || '').trim();
    const label = (b.getAttribute('aria-label') || '').trim();
    return t === 'Run' || t.startsWith('Run') || label === 'Run' || b.classList.contains('run-button') ||
      b.classList.contains('ctrl-enter-submits') || t === '运行' || label === '运行';
  });
  if (run) { run.click(); return true; }
  return false;
})()`;

export const EXTRACT_EMAIL_JS = `(() => {
  const RE = /[\\w.+-]+@[\\w-]+\\.[\\w.-]+/;
  for (const el of document.querySelectorAll('[aria-label*="@"], [data-email], img[alt*="@"], [title*="@"]')) {
    const s = [el.getAttribute('data-email'), el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('alt')].join(' ');
    const m = s.match(RE);
    if (m) return m[0].toLowerCase();
  }
  try { const m = JSON.stringify(window.WIZ_global_data || {}).match(RE); if (m) return m[0].toLowerCase(); } catch (e) {}
  return '';
})()`;
