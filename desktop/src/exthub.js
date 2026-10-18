// Extension transport. Every Chrome profile with the bridge extension installed opens its own
// WebSocket to /ext and is identified by a profileId; each worker tab in it is an account
// keyed "profileId:authUser". Bootstrap / snapshot / streaming fetch run inside that tab.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AccountBase, parseModelList } from './accountbase.js';
import { log, rid, sleep, ROOT } from './util.js';

function diskExtensionVersion() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

const splitKey = (key) => {
  const i = key.lastIndexOf(':');
  return { profileId: key.slice(0, i), authUser: Number(key.slice(i + 1)) || 0 };
};

export class ExtHub extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.profiles = new Map(); // profileId -> { conn, workers: Map(authUser -> state) }
    this.pending = new Map(); // cmd id -> { resolve, reject, timer, profileId }
    this.sinks = new Map(); // stream rid -> sink
    setInterval(() => { for (const p of this.profiles.values()) p.conn.send({ type: 'ping' }); }, 20000).unref();
  }

  get connected() {
    return this.profiles.size > 0;
  }

  profileConnected(profileId) {
    return !!this.profiles.get(profileId)?.conn.open;
  }

  workerState(key) {
    const { profileId, authUser } = splitKey(key);
    return this.profiles.get(profileId)?.workers.get(authUser) || null;
  }

  attach(conn) {
    let profileId = null;
    conn.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'hello') {
        const disk = diskExtensionVersion();
        if (disk && msg.version !== disk) {
          log.info(`扩展版本 ${msg.version} → ${disk}，自动重新加载扩展`);
          conn.send({ type: 'reload-ext' });
          return;
        }
        if (!msg.profileId) return;
        profileId = msg.profileId;
        const old = this.profiles.get(profileId);
        // a profile may briefly hold two sockets; keep the newest, carry worker state over
        this.profiles.set(profileId, { conn, workers: old?.workers || new Map() });
        if (!old) log.info(`Chrome 配置文件 ${profileId} 已连接`);
        this.emit('profile', profileId, true);
        setTimeout(() => conn.send({ type: 'ensure' }), 1500);
        return;
      }
      if (profileId) this._onMessage(profileId, msg);
    });
    conn.on('close', () => {
      if (!profileId) return;
      const p = this.profiles.get(profileId);
      if (!p || p.conn !== conn) return;
      this.profiles.delete(profileId);
      log.warn(`Chrome 配置文件 ${profileId} 断开（配置文件关闭了？）`);
      for (const [id, pend] of this.pending) {
        if (pend.profileId === profileId) {
          clearTimeout(pend.timer);
          pend.reject(new Error('扩展连接断开'));
          this.pending.delete(id);
        }
      }
      for (const s of this.sinks.values()) if (s.profileId === profileId) s.push({ t: 'error', message: '扩展连接断开' });
      for (const authUser of p.workers.keys()) this.emit('worker', `${profileId}:${authUser}`, 'gone');
      this.emit('profile', profileId, false);
    });
  }

  _onMessage(profileId, msg) {
    if (msg.type === 'reply') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || '扩展执行失败'));
    } else if (msg.type === 'ev') {
      this.sinks.get(msg.ev?.rid)?.push(msg.ev);
    } else if (msg.type === 'worker') {
      const p = this.profiles.get(profileId);
      if (!p) return;
      const prev = p.workers.get(msg.authUser);
      if (msg.state === 'gone') p.workers.delete(msg.authUser);
      else p.workers.set(msg.authUser, msg.state);
      if (prev !== msg.state) this.emit('worker', `${profileId}:${msg.authUser}`, msg.state);
    } else if (msg.type === 'log') {
      log.warn(`[扩展 ${profileId}] ${msg.message}`);
    }
  }

  send(profileId, obj) {
    const p = this.profiles.get(profileId);
    if (p?.conn.open) p.conn.send(obj);
  }

  cmd(key, cmd, arg, timeoutMs = 30000) {
    const { profileId, authUser } = splitKey(key);
    if (!this.profileConnected(profileId)) return Promise.reject(new Error('这个 Chrome 配置文件没有打开'));
    const id = rid(10);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`扩展命令 ${cmd} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, profileId });
      this.send(profileId, { type: 'cmd', id, authUser, cmd, arg });
    });
  }
}

export class ExtAccount extends AccountBase {
  constructor(hub, key, cfg, info = {}) {
    const { profileId, authUser } = splitKey(key);
    super(authUser, cfg);
    this.hub = hub;
    this.key = key;
    this.profileId = profileId;
    this.id = 'ext:' + key;
    this.source = 'extension';
    this.email = info.email || '';
    this.enabled = info.enabled !== false;
    this.bootPromise = null;
    this.state = 'offline';
    this.message = 'Chrome 配置文件未打开';
    this._onWorker = (k, state) => {
      if (k !== this.key) return;
      if (state === 'connected') {
        if (!this.bootPromise && this.enabled) this.start().catch(() => {});
      } else if (state === 'login') {
        this.state = 'login';
        this.message = '这个配置文件里的 Google 账号没登录';
      } else {
        this.state = this.hub.profileConnected(this.profileId) ? 'idle' : 'offline';
        this.message = this.state === 'offline' ? 'Chrome 配置文件未打开' : '工作标签页已关闭/刷新';
      }
    };
    hub.on('worker', this._onWorker);
  }

  dispose() {
    this.hub.off('worker', this._onWorker);
  }

  get label() {
    return this.email || `配置文件 ${this.profileId}${this.authUser ? ' u/' + this.authUser : ''}`;
  }

  canStart() {
    return this.hub.profileConnected(this.profileId);
  }

  isReady() {
    return this.state === 'ready' && this.hub.workerState(this.key) === 'connected';
  }

  start(force = false) {
    if (this.bootPromise && !force) return this.bootPromise;
    const p = this._boot().catch((e) => {
      if (this.state !== 'login' && this.state !== 'offline') {
        this.state = 'error';
        this.message = e.message;
      }
      log.error(`[${this.label}] 初始化失败: ${e.message}`);
      // a page left in a bad UI state by an earlier run: reload the tab once and handshake again
      if (/capture GenerateContent template/.test(e.message) && !this.reloadedForCapture) {
        this.reloadedForCapture = true;
        log.info(`[${this.label}] 刷新工作标签页后重试握手`);
        setTimeout(() => this.restart(), 0);
      }
      throw e;
    }).finally(() => {
      if (this.bootPromise === p) this.bootPromise = null;
    });
    p.catch(() => {});
    this.bootPromise = p;
    return p;
  }

  async _boot() {
    if (!this.canStart()) {
      this.state = 'offline';
      this.message = 'Chrome 配置文件未打开';
      throw new Error('这个 Chrome 配置文件没有打开');
    }
    if (this.hub.workerState(this.key) !== 'connected') {
      this.state = 'starting';
      this.message = '打开工作标签页…';
      this.hub.send(this.profileId, { type: 'reload', authUser: this.authUser });
      for (let i = 0; i < 120 && this.hub.workerState(this.key) !== 'connected'; i++) await sleep(500);
      if (this.hub.workerState(this.key) !== 'connected') throw new Error('工作标签页没有连上（未登录？）');
    }
    this.state = 'starting';
    this.message = 'BotGuard 握手中…';
    const t0 = Date.now();
    const step = (name) => this.hub.cmd(this.key, 'step', name, 15000);
    let prep;
    for (;;) {
      prep = await step('prep');
      if (prep.ready && prep.key) break;
      if (Date.now() - t0 > 60000) throw new Error(prep.ready ? '找不到 BotGuard 签名函数' : 'AI Studio 页面没加载出来（未登录？）');
      await sleep(700);
    }
    let r = await step('reuse');
    if (!r) {
      let polled = { captured: false, service: false };
      for (let attempt = 0; attempt < 3 && !polled.captured; attempt++) {
        await step('fill');
        await sleep(500);
        await step('run');
        for (let i = 0; i < 40 && !polled.captured; i++) {
          await sleep(150);
          polled = await step('poll');
        }
        if (!polled.captured) await step('dismiss');
      }
      for (let i = 0; i < 30 && polled.captured && !polled.service; i++) {
        await sleep(150);
        polled = await step('poll');
      }
      if (!polled.captured) {
        const d = await step('diag').catch((e) => ({ error: e.message }));
        log.warn(`[${this.label}] 模板捕获失败，页面状态: ${JSON.stringify(d)}`);
      }
      r = await step('finish');
    }
    if (!r.service) throw new Error('捕获到请求但 BotGuardService 未就绪');
    this.reloadedForCapture = false;
    this.template = { url: r.url, body: r.body };
    if (r.email && r.email !== this.email) {
      this.email = r.email;
      this.onEmail?.(r.email);
    }
    this.state = 'ready';
    this.message = '';
    log.info(`[${this.label}] 就绪（扩展），握手耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  restart() {
    if (!this.canStart()) return;
    this.state = 'starting';
    this.message = '重新载入工作标签页…';
    this.hub.send(this.profileId, { type: 'reload', authUser: this.authUser });
    // fallback: if the tab never reconnects, run the handshake on whatever page is there
    setTimeout(() => { if (this.state === 'starting' && !this.bootPromise) this.start().catch(() => {}); }, 20000);
  }

  show() {
    this.hub.send(this.profileId, { type: 'show', authUser: this.authUser });
  }

  snapshot(hash) {
    return this.hub.cmd(this.key, 'snapshot', hash, 15000);
  }

  stream(body, signal) {
    const id = rid(10);
    const queue = [];
    let wake = null;
    const sink = { profileId: this.profileId, push: (ev) => { queue.push(ev); if (wake) { wake(); wake = null; } } };
    this.hub.sinks.set(id, sink);
    const abort = () => this.hub.cmd(this.key, 'abort', id, 5000).catch(() => {});
    signal?.addEventListener('abort', abort, { once: true });
    const started = this.hub.cmd(this.key, 'stream', { rid: id, body, timeoutMs: (this.cfg.requestTimeoutSeconds || 600) * 1000 })
      .catch((e) => sink.push({ t: 'error', message: e.message }));
    const hub = this.hub;
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
          hub.sinks.delete(id);
          signal?.removeEventListener('abort', abort);
          if (!finished) abort();
        }
      },
    };
  }

  async listModels() {
    const r = await this.hub.cmd(this.key, 'listModels', null, 15000);
    if (r.status !== 200) throw new Error(`ListModels HTTP ${r.status}`);
    return parseModelList(r.text);
  }
}
