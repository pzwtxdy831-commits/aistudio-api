// Account pool + request pipeline (sign → build → stream → parse) with retry/rotation.
import path from 'node:path';
import { launchBrowser, CDP } from './cdp.js';
import { Account } from './account.js';
import { ExtHub, ExtAccount } from './exthub.js';
import { contentHash, buildRequestBody, StreamSplitter, parseChunk, parseErrorBody, THINKING_LEVELS } from './wire.js';
import { SigCache } from './sigcache.js';
import { log, sleep, rid, DATA_DIR, saveConfig } from './util.js';
import { AccountStore } from './store.js';
import { toCookieParam } from './cookies.js';

export class ProxyError extends Error {
  constructor(status, message, type = 'upstream_error') {
    super(message);
    this.status = status;
    this.type = type;
  }
}

const GENERATED_ID_PREFIX = 'call_ais_';
const DUMMY_SIGNATURE = 'skip_thought_signature_validator';
const FALLBACK_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

const LEVEL_NAMES = Object.fromEntries(Object.entries(THINKING_LEVELS).map(([k, v]) => [v, k]));
// models that reject thinking level MINIMAL (found by testing): fall back to LOW up front
const NO_MINIMAL = /^gemini-4-argon/;

const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
    : JSON.stringify(v ?? null));
const stableKey = (name, args) => `${name}:${stable(args ?? {})}`;

export class Engine {
  constructor(cfg) {
    this.cfg = cfg;
    this.cdp = null;
    this.hub = new ExtHub();
    this.store = new AccountStore();
    this.accounts = [];
    this.sticky = 0;
    this.sigs = new SigCache(path.join(DATA_DIR, 'signatures.json'));
    this.models = { list: null, at: 0 };
    this.connecting = null;
    this.contextsCleaned = false;
    this.totals = { requests: 0, ok: 0, fail: 0, promptTokens: 0, outputTokens: 0 };
    this.recent = [];
  }

  async init() {
    // extension accounts appear as soon as a Chrome profile with the bridge extension connects
    this.hub.on('worker', (key, state) => { if (state !== 'gone') this._extAccount(key); });
    for (const [key, info] of Object.entries(this.store.ext)) this._extAccount(key, info);
    // cookie accounts (and legacy "log in inside the proxy window" accounts) use the proxy's own Chrome
    for (const rec of this.store.cookie) this.accounts.push(this._cookieAccount(rec));
    if (this.cfg.mode === 'chrome') {
      for (const n of this.cfg.accounts) this.accounts.push(new Account(this.browserHandle(), n, this.cfg));
    }
    const ext = this.accounts.filter((a) => a.source === 'extension').length;
    log.info(`账号：扩展 ${ext} 个，Cookie ${this.store.cookie.length} 个（在控制面板里管理）`);
    if (this.accounts.some((a) => a.source !== 'extension' && a.enabled)) this.startBrowserAccounts();
  }

  _extAccount(key, info) {
    let a = this.accounts.find((x) => x.id === 'ext:' + key);
    if (a) return a;
    a = new ExtAccount(this.hub, key, this.cfg, info || this.store.extInfo(key));
    a.onEmail = (email) => this.store.updateExt(key, { email });
    this.accounts.push(a);
    if (!info) this.store.updateExt(key, {});
    if (this.hub.workerState(key) === 'connected' && a.enabled) a.start().catch(() => {});
    return a;
  }

  _cookieAccount(rec) {
    return new Account(this.browserHandle(), rec.authUser || 0, this.cfg, {
      cookieRec: rec,
      onCookies: (list) => {
        rec.cookies = list.map(toCookieParam);
        this.store.updateCookie(rec.id, { cookies: rec.cookies });
      },
    });
  }

  browserHandle() {
    const engine = this;
    return {
      get cdp() { return engine.cdp; },
      claimedTargets: () => engine.accounts.map((a) => a.page?.targetId).filter(Boolean),
      cookieContexts: () => engine.accounts.map((a) => a.contextId).filter(Boolean),
      // never hide the window while someone is still logging in
      minimize: () => (engine.accounts.some((a) => a.state === 'login') ? Promise.resolve() : engine._setWindowState('minimized')),
      restore: () => engine._setWindowState('normal'),
    };
  }

  async _setWindowState(windowState) {
    if (!this.cdp || this.cdp.closed) return;
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    const contexts = new Set(this.accounts.map((a) => a.contextId).filter(Boolean));
    const page = targetInfos.find((t) => t.type === 'page' && !contexts.has(t.browserContextId));
    if (!page) return;
    if (windowState === 'normal') await this.cdp.send('Target.activateTarget', { targetId: page.targetId }).catch(() => {});
    const { windowId } = await this.cdp.send('Browser.getWindowForTarget', { targetId: page.targetId });
    await this.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState } });
  }

  async ensureBrowser() {
    if (this.cdp && !this.cdp.closed) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const ws = await launchBrowser({ browserPath: this.cfg.browserPath, userDataDir: this.cfg.userDataDir, port: this.cfg.debugPort });
      const cdp = new CDP(ws);
      await cdp.connect();
      cdp.on('disconnected', () => {
        log.warn('独立浏览器连接断开（被关闭了？），需要时会自动重新打开');
        for (const a of this.accounts) {
          if (a.source === 'extension') continue;
          a.page = null;
          a.state = 'idle';
          a.message = '浏览器已关闭';
        }
      });
      this.cdp = cdp;
      // contexts left over from an earlier proxy run (the browser is reused across restarts)
      const { browserContextIds = [] } = await cdp.send('Target.getBrowserContexts').catch(() => ({}));
      for (const id of browserContextIds) await cdp.send('Target.disposeBrowserContext', { browserContextId: id }).catch(() => {});
      if (this.cfg.mode !== 'chrome') this._setWindowState('minimized').catch(() => {});
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async startBrowserAccounts() {
    try {
      await this.ensureBrowser();
    } catch (e) {
      log.error('独立浏览器启动失败: ' + e.message);
      return;
    }
    // one after another: they share one Chrome, parallel navigation only slows each other down
    for (const a of this.accounts) {
      if (a.source !== 'extension' && a.enabled && !a.isReady()) await a.start().catch(() => {});
    }
  }

  // ---------- account management (control panel) ----------
  find(id) {
    const a = this.accounts.find((x) => x.id === id);
    if (!a) throw Object.assign(new Error('账号不存在'), { status: 404 });
    return a;
  }

  async removeAccount(id) {
    const a = this.find(id);
    if (a.source === 'chrome') throw Object.assign(new Error('这个账号来自 config.json 的 accounts，请在那里删除'), { status: 400 });
    await a.dispose();
    this.accounts = this.accounts.filter((x) => x !== a);
    if (a.source === 'cookie') this.store.removeCookie(id);
    else this.store.removeExt(a.key);
    log.info(`删除账号 ${a.label}`);
  }

  setEnabled(id, enabled) {
    const a = this.find(id);
    a.enabled = !!enabled;
    if (a.source === 'cookie') this.store.updateCookie(id, { enabled: a.enabled });
    else if (a.source === 'extension') this.store.updateExt(a.key, { enabled: a.enabled });
    if (a.enabled && !a.isReady() && a.canStart()) {
      (async () => {
        if (a.source !== 'extension') await this.ensureBrowser();
        await a.start();
      })().catch(() => {});
    }
  }

  async restartAccount(id) {
    const a = this.find(id);
    if (a.restart) return a.restart();
    if (a.source !== 'extension') await this.ensureBrowser();
    a.state = 'idle';
    a.start(true).catch(() => {});
  }

  showAccount(id) {
    const a = this.find(id);
    if (a.show) return a.show();
    if (a.page && this.cdp) {
      return this.cdp.send('Browser.getWindowForTarget', { targetId: a.page.targetId })
        .then(({ windowId }) => this.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }))
        .then(() => this.cdp.send('Target.activateTarget', { targetId: a.page.targetId }))
        .catch(() => {});
    }
  }

  setRotation(rotation) {
    this.cfg.rotation = rotation === 'sticky' ? 'sticky' : 'round-robin';
    saveConfig({ rotation: this.cfg.rotation });
  }

  // ---------- account selection ----------
  async pick(model, exclude) {
    const deadline = Date.now() + 90 * 1000;
    for (;;) {
      const pool = this.accounts.filter((a) => a.enabled);
      const n = pool.length;
      if (!n) throw new ProxyError(503, '没有可用账号：请在装了「AIS 反代桥接」扩展的 Chrome 配置文件里打开 Chrome，或在控制面板里启用账号', 'not_ready');
      for (let i = 0; i < n; i++) {
        const idx = (this.sticky + i) % n;
        const a = pool[idx];
        if (exclude.has(a) || !a.isReady() || a.cooldownFor(model)) continue;
        // round-robin: next request starts from the following account; sticky: stay until it fails
        this.sticky = this.cfg.rotation === 'sticky' ? idx : (idx + 1) % n;
        return a;
      }
      const usable = pool.filter((a) => !exclude.has(a));
      if (!usable.length) throw new ProxyError(429, '所有账号都已尝试失败或处于冷却中', 'rate_limit');
      if (usable.every((a) => a.cooldownFor(model))) {
        const soon = Math.min(...usable.map((a) => a.cooldownFor(model)));
        throw new ProxyError(429, `所有账号的 ${model} 额度都在冷却中，最早 ${new Date(soon).toLocaleTimeString()} 恢复`, 'rate_limit');
      }
      // nothing ready yet → (re)start idle accounts that can be started, and wait
      for (const a of usable) {
        if ((a.state === 'idle' || a.state === 'error') && a.canStart() && Date.now() - (a.kickedAt || 0) > 15000) {
          a.kickedAt = Date.now();
          (async () => {
            if (a.source !== 'extension') await this.ensureBrowser();
            await a.start();
          })().catch(() => {});
        }
      }
      if (!usable.some((a) => a.canStart() && a.state !== 'error') || Date.now() > deadline) {
        const st = usable.map((a) => `${a.label}: ${a.message || a.state}`).join('; ');
        throw new ProxyError(503, `没有就绪的账号（${st}）`, 'not_ready');
      }
      await sleep(400);
    }
  }

  // ---------- thought signatures ----------
  prepareContents(contents, model) {
    const needSig = !/gemini-(1|2)\.|gemma/i.test(model);
    return contents.map((c) => {
      if (c.role !== 'model') {
        return { ...c, parts: c.parts.map((p) => (p.functionResponse?.id?.startsWith(GENERATED_ID_PREFIX)
          ? { ...p, functionResponse: { ...p.functionResponse, id: undefined } } : p)) };
      }
      let firstCall = true;
      const parts = c.parts.map((p) => {
        if (!p.functionCall) return p;
        const q = { ...p, functionCall: { ...p.functionCall } };
        if (!q.thoughtSignature) {
          q.thoughtSignature = this.sigs.get(q.functionCall.id) || this.sigs.get(stableKey(q.functionCall.name, q.functionCall.args));
          if (!q.thoughtSignature && needSig && firstCall) q.thoughtSignature = DUMMY_SIGNATURE;
        }
        if (q.functionCall.id?.startsWith(GENERATED_ID_PREFIX)) delete q.functionCall.id;
        firstCall = false;
        return q;
      });
      return { ...c, parts };
    });
  }

  rememberCall(part) {
    const fc = part.functionCall;
    if (!fc.id) fc.id = GENERATED_ID_PREFIX + rid(16);
    if (part.thoughtSignature) {
      this.sigs.set(fc.id, part.thoughtSignature);
      this.sigs.set(stableKey(fc.name, fc.args), part.thoughtSignature);
    }
  }

  // ---------- main pipeline ----------
  // Panel setting: force a thinking level for a model family, e.g. { "gemini-4-argon": "low" }.
  thinkingOverride(model) {
    const map = this.cfg.thinkingOverrides || {};
    const key = Object.keys(map).find((k) => model === k || model.startsWith(k + '-'));
    return key ? map[key] : '';
  }

  setThinkingOverride(modelKey, level) {
    const map = { ...(this.cfg.thinkingOverrides || {}) };
    if (level && THINKING_LEVELS[level]) map[modelKey] = level;
    else delete map[modelKey];
    this.cfg.thinkingOverrides = map;
    saveConfig({ thinkingOverrides: map });
    log.info(`${modelKey} 思考强度: ${level || '跟随客户端'}`);
  }

  applyThinking(model, gen = {}) {
    let g = gen;
    const forced = this.thinkingOverride(model);
    if (forced && THINKING_LEVELS[forced]) g = { ...g, thinkingLevel: THINKING_LEVELS[forced] };
    if (NO_MINIMAL.test(model) && g.thinkingLevel === THINKING_LEVELS.minimal) g = { ...g, thinkingLevel: THINKING_LEVELS.low };
    return g;
  }

  // req: { model, contents, systemInstruction, tools, safety, gen }
  // yields { type: 'part', part } | { type: 'finish', reason, message } | { type: 'usage', usage } | { type: 'blocked', reason }
  async *generate(req, signal) {
    const t0 = Date.now();
    const model = req.model.replace(/^models\//, '');
    const contents = this.prepareContents(req.contents, model);
    const hash = contentHash(contents);
    let gen = this.applyThinking(model, req.gen);
    const tried = new Set();
    const maxAttempts = Math.max(2, this.accounts.length + 1);
    this.totals.requests++;
    let lastErr = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) return;
      const acc = await this.pick(model, tried);
      acc.inflight++;
      acc.stats.requests++;
      let emitted = false;
      let usage = null;
      let tFirst = 0;
      let tStatus = 0;
      const tSnap0 = Date.now();
      try {
        const snapshot = await acc.snapshot(hash);
        const snapMs = Date.now() - tSnap0;
        const body = buildRequestBody(acc.template.body, {
          model, contents, snapshot,
          systemInstruction: req.systemInstruction, tools: req.tools, safety: req.safety, gen,
          timezone: this.cfg.timezone,
        });
        let status = 0;
        let errText = '';
        const splitter = new StreamSplitter();
        for await (const ev of acc.stream(body, signal)) {
          if (ev.t === 'status') { status = ev.status; tStatus = Date.now(); continue; }
          if (ev.t === 'chunk') {
            if (status !== 200) { errText += ev.text; continue; }
            for (const chunk of splitter.feed(ev.text)) {
              const parsed = parseChunk(chunk);
              if (parsed.usage) usage = parsed.usage;
              for (const part of parsed.parts) {
                if (part.functionCall) this.rememberCall(part);
                if (!tFirst) tFirst = Date.now();
                emitted = true;
                yield { type: 'part', part };
              }
              if (parsed.blockReason) { emitted = true; yield { type: 'blocked', reason: parsed.blockReason }; }
              if (parsed.finishReason) yield { type: 'finish', reason: parsed.finishReason, message: parsed.finishMessage };
            }
            continue;
          }
          if (ev.t === 'aborted') return;
          if (ev.t === 'error') throw new ProxyError(502, `浏览器内请求失败: ${ev.message}`);
          if (ev.t === 'done') break;
        }
        if (status !== 200) throw this._classify(acc, model, status, errText);
        if (usage) yield { type: 'usage', usage };
        acc.stats.ok++;
        this.totals.ok++;
        this._record(acc, model, t0, tFirst, snapMs, usage, 'ok', gen, tStatus);
        return;
      } catch (e) {
        lastErr = e instanceof ProxyError ? e : new ProxyError(502, e.message);
        if (signal?.aborted) return;
        // a model that rejects the requested thinking level: retry once on LOW instead of failing
        const levelRejected = /Thinking level \w+ is not supported/i.test(lastErr.message) ||
          (gen.thinkingLevel === THINKING_LEVELS.minimal && /unsupported capabilities/i.test(lastErr.message));
        if (!emitted && levelRejected && gen.thinkingLevel !== THINKING_LEVELS.low) {
          log.warn(`${model} 不支持思考强度 ${LEVEL_NAMES[gen.thinkingLevel] || gen.thinkingLevel}，自动改用 low 重试`);
          gen = { ...gen, thinkingLevel: THINKING_LEVELS.low };
          continue;
        }
        acc.stats.fail++;
        if (emitted || !lastErr.retry) {
          this.totals.fail++;
          this._record(acc, model, t0, tFirst, 0, usage, lastErr.message, gen);
          throw lastErr;
        }
        tried.add(acc);
        log.warn(`[${acc.label}] ${lastErr.message} → 换账号/重试`);
        if (lastErr.waitRestart && this.accounts.length === 1) {
          tried.delete(acc);
          await acc.start().catch(() => {});
        }
      } finally {
        acc.inflight--;
      }
    }
    this.totals.fail++;
    throw lastErr || new ProxyError(502, '请求失败');
  }

  _classify(acc, model, status, errText) {
    const { code, message } = parseErrorBody(errText);
    const msg = `HTTP ${status}${message ? ': ' + message : ''}`;
    const err = new ProxyError(status || 502, msg);
    if (status === 429 || code === 8) {
      acc.markRateLimited(model);
      err.status = 429;
      err.type = 'rate_limit';
      err.retry = true;
    } else if (status === 403 || code === 7) {
      // BotGuard / session invalid → rebuild the tab in the background
      acc.state = 'idle';
      acc.message = '签名失效，重新握手中';
      if (acc.restart) acc.restart();
      else acc.start(true).catch(() => {});
      err.retry = true;
      err.waitRestart = true;
    } else if (status === 401) {
      acc.onUnauthorized();
      err.retry = true;
    } else if (status >= 500 || status === 0) {
      err.retry = true;
    }
    return err;
  }

  _record(acc, model, t0, tFirst, snapMs, usage, result, gen, tStatus = 0) {
    const total = Date.now() - t0;
    const entry = {
      time: Date.now(), account: acc.label, model, result,
      level: gen?.thinkingLevel ? LEVEL_NAMES[gen.thinkingLevel] : null,
      snapMs, headMs: tStatus ? tStatus - t0 : null, firstMs: tFirst ? tFirst - t0 : null, totalMs: total,
      in: usage?.promptTokenCount ?? null, out: usage ? (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0) : null,
      thoughts: usage?.thoughtsTokenCount || 0,
      tps: null,
    };
    // output speed after the first token arrived (tokens per second)
    const genMs = tFirst ? Date.now() - tFirst : 0;
    if (entry.out && genMs > 300) entry.tps = Math.round((entry.out / (genMs / 1000)) * 10) / 10;
    if (usage) {
      this.totals.promptTokens += usage.promptTokenCount || 0;
      this.totals.outputTokens += entry.out || 0;
    }
    this.recent.unshift(entry);
    if (this.recent.length > 50) this.recent.pop();
    const fmt = (ms) => (ms == null ? '-' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
    const line = `[${acc.label}] ${model}${entry.level ? '(' + entry.level + ')' : ''} 签名 ${fmt(snapMs)} 响应头 ${fmt(entry.headMs)} 首字 ${fmt(entry.firstMs)} 总计 ${fmt(total)}` +
      (usage ? ` 输入 ${entry.in} 输出 ${entry.out}` : '') + (entry.tps ? ` ${entry.tps} tok/s` : '') + (result === 'ok' ? '' : ` ✗ ${result}`);
    (result === 'ok' ? log.info : log.warn)(line);
  }

  async listModels() {
    if (this.models.list && Date.now() - this.models.at < 10 * 60 * 1000) return this.models.list;
    const acc = this.accounts.find((a) => a.isReady());
    if (acc) {
      try {
        const list = await acc.listModels();
        if (list.length) {
          this.models = { list, at: Date.now() };
          return list;
        }
      } catch (e) {
        log.warn('获取模型列表失败: ' + e.message);
      }
    }
    return this.models.list || FALLBACK_MODELS.map((id) => ({ id, displayName: id, description: '', inputTokenLimit: 0, outputTokenLimit: 0 }));
  }

  status() {
    return {
      accounts: this.accounts.map((a) => a.status()),
      totals: this.totals,
      recent: this.recent,
      browser: this.cdp && !this.cdp.closed ? 'connected' : 'disconnected',
      profiles: this.hub.profiles.size,
      rotation: this.cfg.rotation,
      thinking4a: this.thinkingOverride('gemini-4-argon'),
    };
  }
}
