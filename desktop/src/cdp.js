// Chrome launcher + minimal Chrome DevTools Protocol client (browser-level socket, flattened sessions).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { log, sleep } from './util.js';

const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

export function findBrowser(configured) {
  if (configured && existsSync(configured)) return path.normalize(configured);
  for (const p of BROWSER_CANDIDATES) if (p && existsSync(p)) return path.normalize(p);
  throw new Error('找不到 Chrome / Edge，请在 config.json 的 browserPath 里填写浏览器路径');
}

async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    return (await r.json()).webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

// Reuses an already running debug browser (so restarting the proxy keeps the login + warm tabs).
export async function launchBrowser({ browserPath, userDataDir, port }) {
  let ws = await probe(port);
  if (ws) {
    log.info(`复用已在运行的浏览器 (端口 ${port})`);
    return ws;
  }
  const exe = findBrowser(browserPath);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.resolve(userDataDir)}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion,Translate,MediaRouter',
    '--disable-sync',
    '--window-size=1100,820',
    'about:blank',
  ];
  log.info(`启动浏览器: ${exe}`);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    ws = await probe(port);
    if (ws) return ws;
  }
  throw new Error(`浏览器调试端口 ${port} 没有响应`);
}

export class CDP extends EventEmitter {
  constructor(wsUrl) {
    super();
    this.setMaxListeners(0);
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.onopen = () => resolve(this);
      ws.onerror = (e) => reject(new Error('CDP 连接失败: ' + (e.message || 'error')));
      ws.onclose = () => {
        this.closed = true;
        for (const p of this.pending.values()) p.reject(new Error('CDP 连接已关闭'));
        this.pending.clear();
        this.emit('disconnected');
      };
      ws.onmessage = (ev) => this._onMessage(ev.data);
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result || {});
      return;
    }
    this.emit(`${msg.sessionId || ''}|${msg.method}`, msg.params || {});
    this.emit('event', msg);
  }

  send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify(payload));
    });
  }

  async attachPage(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return new Page(this, targetId, sessionId);
  }
}

export class Page {
  constructor(cdp, targetId, sessionId) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  send(method, params, timeoutMs) {
    return this.cdp.send(method, params, this.sessionId, timeoutMs);
  }

  on(method, fn) {
    const key = `${this.sessionId}|${method}`;
    this.cdp.on(key, fn);
    return () => this.cdp.off(key, fn);
  }

  async evaluate(expression, { timeoutMs = 30000, awaitPromise = true } = {}) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise, userGesture: true },
      timeoutMs,
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面脚本异常: ' + (d.exception?.description || d.text || 'unknown'));
    }
    return r.result?.value;
  }

  // Calls a function source with a JSON-serialisable argument.
  call(fnSource, arg, opts) {
    return this.evaluate(`(${fnSource})(${JSON.stringify(arg ?? null)})`, opts);
  }

  async url() {
    try {
      return (await this.evaluate('location.href', { timeoutMs: 5000 })) || '';
    } catch {
      return '';
    }
  }
}
