// One AI Studio tab bound to one Google sub-account (/u/N/).
// Owns BotGuard bootstrap, snapshot signing and in-page streaming fetch.
import { createHash } from 'node:crypto';
import { log, sleep, rid } from './util.js';
import { AccountBase, parseModelList } from './accountbase.js';
import {
  PAGE_STATE_JS, INSTALL_HOOKS_JS, SNAPSHOT_JS, STREAM_JS, ABORT_JS, SIMPLE_POST_JS,
  DIALOG_CLEANUP_JS, FILL_PROMPT_JS, CLICK_RUN_JS, EXTRACT_EMAIL_JS,
} from './pagejs.js';

const ORIGIN = 'https://aistudio.google.com';
const RPC_BASE = 'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/';
const BINDING = '__aisPush';
const FORBIDDEN_HEADERS = /^(host|cookie|origin|referer|user-agent|content-length|connection|accept-encoding|accept-language|priority|sec-.*|authorization|x-goog-authuser)$/i;

export class Account extends AccountBase {
  // opts.cookieRec: { id, name, cookies, enabled } → runs in its own isolated browser context
  // opts.onCookies(list): persist refreshed cookies (Google rotates some of them)
  constructor(browser, authUser, cfg, opts = {}) {
    super(authUser, cfg);
    this.browser = browser; // { cdp, minimize(), restore() }
    this.page = null;
    this.cookies = null;
    this.cookiesAt = 0;
    this.streams = new Map();
    this.bootPromise = null;
    this.cookieRec = opts.cookieRec || null;
    this.onCookies = opts.onCookies || null;
    this.contextId = null;
    this.contextCdp = null;
    if (this.cookieRec) {
      this.id = this.cookieRec.id;
      this.source = 'cookie';
      this.name = this.cookieRec.name || '';
      this.enabled = this.cookieRec.enabled !== false;
    } else {
      this.id = 'chrome:' + authUser;
      this.source = 'chrome';
    }
  }

  get label() {
    if (this.cookieRec) return this.email || this.name || `Cookie ${this.id}`;
    return super.label;
  }

  async dispose() {
    clearInterval(this.saveTimer);
    const { cdp } = this.browser;
    if (cdp && !cdp.closed) {
      if (this.contextId) await cdp.send('Target.disposeBrowserContext', { browserContextId: this.contextId }).catch(() => {});
      else if (this.page) await cdp.send('Target.closeTarget', { targetId: this.page.targetId }).catch(() => {});
    }
    this.page = null;
    this.state = 'idle';
  }

  async _persistCookies() {
    if (!this.contextId || !this.onCookies) return;
    const { cookies } = await this.browser.cdp.send('Storage.getCookies', { browserContextId: this.contextId });
    const google = cookies.filter((c) => /(^|\.)google\.com$/.test(c.domain.replace(/^\./, '')));
    if (google.some((c) => c.name === 'SAPISID' || c.name === '__Secure-1PAPISID')) this.onCookies(google);
  }

  onUnauthorized() {
    this._refreshCookies().catch(() => {});
  }

  isReady() {
    return this.state === 'ready' && this.page && !this.browser.cdp.closed;
  }

  // ---------- lifecycle ----------
  start(force = false) {
    if (this.bootPromise && !force) return this.bootPromise;
    this.bootPromise = this._boot().catch((e) => {
      if (this.state !== 'login') {
        this.state = 'error';
        this.message = e.message;
      }
      log.error(`[${this.label}] 初始化失败: ${e.message}`);
      throw e;
    }).finally(() => {
      setTimeout(() => { this.bootPromise = null; }, 0);
    });
    this.bootPromise.catch(() => {});
    return this.bootPromise;
  }

  async _attach() {
    const { cdp } = this.browser;
    if (this.page && !cdp.closed) {
      try {
        await this.page.evaluate('1', { timeoutMs: 3000 });
        return;
      } catch { this.page = null; }
    }
    let targetId;
    if (this.cookieRec) {
      // isolated context (like an incognito profile) holding only this account's cookies
      if (!this.contextId || this.contextCdp !== cdp) {
        const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: false });
        this.contextId = browserContextId;
        this.contextCdp = cdp;
        await cdp.send('Storage.setCookies', { cookies: this.cookieRec.cookies, browserContextId });
      }
      ({ targetId } = await cdp.send('Target.createTarget', {
        url: 'about:blank', browserContextId: this.contextId, newWindow: true, background: true, windowState: 'minimized',
      }));
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId }).catch(() => ({}));
      if (windowId) await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }).catch(() => {});
    } else {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const claimed = new Set(this.browser.claimedTargets?.() || []);
      // AI Studio drops the /u/0/ prefix for the default account, so any non-/u/N/ tab counts as u/0
      const isMine = (u) => u.includes(`aistudio.google.com/u/${this.authUser}/`) ||
        (this.authUser === 0 && u.includes('aistudio.google.com') && !/\/u\/[1-9]\d*\//.test(u));
      const cookieContexts = new Set(this.browser.cookieContexts?.() || []);
      const pages = targetInfos.filter((t) => t.type === 'page' && !claimed.has(t.targetId) && !cookieContexts.has(t.browserContextId));
      const mine = pages.find((t) => isMine(t.url));
      const blank = pages.find((t) => t.url === 'about:blank' || t.url.startsWith('chrome://newtab'));
      targetId = mine?.targetId || blank?.targetId;
      if (!targetId) ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    }
    this.page = await cdp.attachPage(targetId);
    const page = this.page;
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Runtime.addBinding', { name: BINDING });
    page.on('Runtime.bindingCalled', (p) => {
      if (p.name !== BINDING) return;
      let ev;
      try { ev = JSON.parse(p.payload); } catch { return; }
      const s = this.streams.get(ev.rid);
      if (s) s.push(ev);
    });
    page.on('Page.frameNavigated', (p) => {
      if (!p.frame.parentId && this.state === 'ready') {
        log.warn(`[${this.label}] 页面发生跳转，标记为需要重新握手`);
        this.state = 'idle';
        this.message = '页面已跳转';
      }
    });
    page.on('Inspector.detached', () => { this.page = null; this.state = 'idle'; });
  }

  async _pageState() {
    try {
      return await this.page.evaluate(PAGE_STATE_JS, { timeoutMs: 8000 });
    } catch {
      return { href: '', dms: false, textarea: false };
    }
  }

  async _boot() {
    const t0 = Date.now();
    this.state = 'starting';
    this.message = '打开 AI Studio…';
    await this._attach();
    const page = this.page;
    const url = `${ORIGIN}/u/${this.authUser}/prompts/new_chat`;
    await page.send('Page.navigate', { url });

    // wait for the app (or a login page)
    let lastNav = Date.now();
    for (;;) {
      await sleep(700);
      const st = await this._pageState();
      if (st.href.includes('accounts.google.com') || st.href.includes('/signin') || st.href.includes('ServiceLogin')) {
        if (this.cookieRec) {
          this.state = 'error';
          throw new Error('Cookie 已失效（Google 要求重新登录），请重新复制这个账号的 Cookie');
        }
        if (this.state !== 'login') {
          this.state = 'login';
          this.message = '请在弹出的浏览器窗口里登录 Google 账号';
          log.warn(`[${this.label}] 需要登录：请在浏览器窗口中登录 Google 账号（只需一次）`);
          await this.browser.restore().catch(() => {});
          await this.browser.cdp.send('Target.activateTarget', { targetId: page.targetId }).catch(() => {});
        }
        lastNav = Date.now();
        continue;
      }
      if (st.href.includes('available-regions')) throw new Error('当前网络所在地区无法使用 AI Studio（被重定向到 available-regions）');
      if (st.dms && st.textarea) break;
      if (this.state === 'login' || Date.now() - lastNav > 25000) {
        // just finished logging in, or the app landed somewhere else → go to a fresh chat
        if (st.href.startsWith(ORIGIN) || this.state === 'login' || Date.now() - lastNav > 25000) {
          this.state = 'starting';
          this.message = '打开 AI Studio…';
          await page.send('Page.navigate', { url });
          lastNav = Date.now();
        }
      }
      if (Date.now() - t0 > 10 * 60 * 1000) throw new Error('等待 AI Studio 页面超时');
      if (st.dms && !st.textarea) await page.evaluate(DIALOG_CLEANUP_JS).catch(() => {});
    }

    this.message = 'BotGuard 握手中…';
    await page.evaluate(DIALOG_CLEANUP_JS).catch(() => {});
    let hook = '';
    for (let i = 0; i < 10; i++) {
      hook = await page.evaluate(INSTALL_HOOKS_JS);
      if (String(hook).startsWith('hooked:')) break;
      await sleep(800);
    }
    if (!String(hook).startsWith('hooked:')) throw new Error('找不到 BotGuard 签名函数: ' + hook);

    this.template = await this._captureTemplate();
    await this._refreshCookies();
    this.email = (await page.evaluate(EXTRACT_EMAIL_JS).catch(() => '')) || this.email;
    // verify signing works end to end
    const snap = await this.snapshot(createHash('sha256').update('ping').digest('hex'));
    if (!snap.startsWith('!')) log.warn(`[${this.label}] 快照格式异常: ${snap.slice(0, 20)}`);
    this.state = 'ready';
    this.message = '';
    log.info(`[${this.label}] 就绪，握手耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (this.cookieRec) {
      this._persistCookies().catch(() => {});
      clearInterval(this.saveTimer);
      this.saveTimer = setInterval(() => this._persistCookies().catch(() => {}), 20 * 60 * 1000);
      this.saveTimer.unref();
    } else if (this.cfg.minimizeBrowser) this.browser.minimize().catch(() => {});
  }

  // Types a dummy prompt and presses Run once; the GenerateContent request is intercepted with
  // the CDP Fetch domain and aborted before it leaves the browser, so no quota is spent.
  async _captureTemplate() {
    const page = this.page;
    let captured = null;
    const off = page.on('Fetch.requestPaused', async (p) => {
      const u = p.request.url;
      try {
        if (u.includes('/GenerateContent') && !captured && p.request.postData) {
          captured = { url: u, headers: p.request.headers, body: p.request.postData };
          await page.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Aborted' });
        } else if (/SavePrompt|CreatePrompt/.test(u)) {
          await page.send('Fetch.fulfillRequest', {
            requestId: p.requestId, responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'application/json+protobuf' }],
            body: Buffer.from('[]').toString('base64'),
          });
        } else {
          await page.send('Fetch.continueRequest', { requestId: p.requestId });
        }
      } catch (e) {
        log.debug('Fetch intercept error', e.message);
      }
    });
    await page.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*MakerSuiteService/GenerateContent*', requestStage: 'Request' },
        { urlPattern: '*MakerSuiteService/SavePrompt*', requestStage: 'Request' },
        { urlPattern: '*MakerSuiteService/CreatePrompt*', requestStage: 'Request' },
      ],
    });
    try {
      for (let attempt = 0; attempt < 3 && !captured; attempt++) {
        await page.call(FILL_PROMPT_JS, 'hi');
        await sleep(500);
        let clicked = await page.evaluate(CLICK_RUN_JS);
        if (!clicked) {
          await page.evaluate("document.querySelector('textarea')?.focus()");
          for (const type of ['rawKeyDown', 'keyUp']) {
            await page.send('Input.dispatchKeyEvent', { type, modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
          }
        }
        for (let i = 0; i < 50 && !captured; i++) await sleep(200);
        if (!captured) await page.evaluate(DIALOG_CLEANUP_JS).catch(() => {});
      }
      if (!captured) throw new Error('没有捕获到 GenerateContent 请求模板（Run 按钮可能没点到）');
      for (let i = 0; i < 25; i++) {
        if ((await this._pageState()).service) break;
        await sleep(200);
      }
      if (!(await this._pageState()).service) throw new Error('捕获到请求但 BotGuardService 未就绪');
    } finally {
      off();
      await page.send('Fetch.disable').catch(() => {});
      await page.call(FILL_PROMPT_JS, '').catch(() => {});
    }
    const headers = {};
    for (const [k, v] of Object.entries(captured.headers || {})) if (!FORBIDDEN_HEADERS.test(k)) headers[k] = v;
    return { url: captured.url, headers, body: captured.body };
  }

  async _refreshCookies() {
    const { cookies } = await this.page.send('Network.getCookies', { urls: [ORIGIN, RPC_BASE] });
    const pick = (n) => cookies.find((c) => c.name === n)?.value || '';
    this.cookies = { sapisid: pick('SAPISID'), p1: pick('__Secure-1PAPISID'), p3: pick('__Secure-3PAPISID') };
    this.cookiesAt = Date.now();
    if (!this.cookies.sapisid && !this.cookies.p1) throw new Error('浏览器里没有 Google 登录 Cookie（SAPISID）');
  }

  authHeaders() {
    if (Date.now() - this.cookiesAt > 10 * 60 * 1000) this._refreshCookies().catch(() => {});
    const ts = Math.floor(Date.now() / 1000);
    const { sapisid, p1, p3 } = this.cookies;
    const h = (v) => createHash('sha1').update(`${ts} ${v} ${ORIGIN}`).digest('hex');
    const base = sapisid || p1;
    const auth = [
      `SAPISIDHASH ${ts}_${h(base)}`,
      `SAPISID1PHASH ${ts}_${h(p1 || base)}`,
      `SAPISID3PHASH ${ts}_${h(p3 || base)}`,
    ].join(' ');
    return { ...this.template.headers, Authorization: auth, 'X-Goog-AuthUser': String(this.authUser) };
  }

  // ---------- per request ----------
  async snapshot(hash) {
    return await this.page.call(SNAPSHOT_JS, hash, { timeoutMs: 15000 });
  }

  // Returns an async iterator of { t: 'status'|'chunk'|'done'|'error'|'aborted', ... }
  stream(body, signal) {
    const id = rid(10);
    const queue = [];
    let wake = null;
    const sink = { push: (ev) => { queue.push(ev); if (wake) { wake(); wake = null; } } };
    this.streams.set(id, sink);
    const page = this.page;
    const onAbort = () => page.call(ABORT_JS, id).catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });
    const started = page.call(STREAM_JS, {
      rid: id, binding: BINDING, url: this.template.url, headers: this.authHeaders(), body,
      timeoutMs: (this.cfg.requestTimeoutSeconds || 300) * 1000,
    }).catch((e) => sink.push({ t: 'error', message: e.message }));
    const self = this;
    let finished = false;
    return {
      async *[Symbol.asyncIterator]() {
        await started;
        try {
          for (;;) {
            while (queue.length) {
              const ev = queue.shift();
              if (ev.t === 'done' || ev.t === 'error' || ev.t === 'aborted') finished = true;
              yield ev;
              if (finished) return;
            }
            await new Promise((r) => { wake = r; });
          }
        } finally {
          self.streams.delete(id);
          signal?.removeEventListener('abort', onAbort);
          if (!finished) onAbort();
        }
      },
    };
  }

  async listModels() {
    const r = await this.page.call(SIMPLE_POST_JS, { url: RPC_BASE + 'ListModels', headers: this.authHeaders(), body: '[]' }, { timeoutMs: 15000 });
    if (r.status !== 200) throw new Error(`ListModels HTTP ${r.status}`);
    return parseModelList(r.text);
  }
}
