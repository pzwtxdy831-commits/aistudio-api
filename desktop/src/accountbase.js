// Shared bookkeeping for both transports (CDP-controlled Chrome and browser extension).
import { log } from './util.js';

export class AccountBase {
  constructor(authUser, cfg) {
    this.authUser = authUser;
    this.cfg = cfg;
    this.state = 'idle'; // idle | starting | login | ready | error
    this.message = '';
    this.email = '';
    this.template = null; // { url, headers, body }
    this.cooldowns = new Map(); // model -> { until, strikes }
    this.inflight = 0;
    this.stats = { requests: 0, ok: 0, fail: 0 };
    this.id = String(authUser);
    this.source = 'chrome';
    this.name = '';
    this.enabled = true;
  }

  canStart() {
    return true;
  }

  get label() {
    return `u/${this.authUser}${this.email ? ' ' + this.email : ''}`;
  }

  onUnauthorized() {}

  cooldownFor(model) {
    const c = this.cooldowns.get(model);
    return c && c.until > Date.now() ? c.until : 0;
  }

  markRateLimited(model) {
    const prev = this.cooldowns.get(model);
    const strikes = prev && Date.now() - prev.until < 10 * 60 * 1000 ? prev.strikes + 1 : 1;
    let until;
    if (strikes === 1) until = Date.now() + 90 * 1000;
    else if (strikes === 2) until = Date.now() + 20 * 60 * 1000;
    else until = nextPacificMidnight();
    this.cooldowns.set(model, { until, strikes });
    log.warn(`[${this.label}] ${model} 触发 429，冷却到 ${new Date(until).toLocaleTimeString()}`);
  }

  status() {
    const cds = {};
    for (const [m, c] of this.cooldowns) if (c.until > Date.now()) cds[m] = c.until;
    return {
      id: this.id, source: this.source, label: this.label, name: this.name, enabled: this.enabled,
      authUser: this.authUser, email: this.email, state: this.state, message: this.message,
      inflight: this.inflight, stats: this.stats, cooldowns: cds,
    };
  }
}

export function parseModelList(text) {
  const raw = JSON.parse(String(text).replace(/^\)\]\}'\s*/, ''));
  const out = [];
  for (const item of Array.isArray(raw?.[0]) ? raw[0] : []) {
    if (!Array.isArray(item) || typeof item[0] !== 'string') continue;
    const id = item[0].replace(/^models\//, '');
    const methods = Array.isArray(item[7]) ? item[7].join(',') : '';
    if (!/generateContent/i.test(methods) && !/image|veo|lyria/.test(id)) continue;
    out.push({
      id,
      displayName: typeof item[3] === 'string' && item[3] ? item[3] : id,
      description: typeof item[4] === 'string' ? item[4] : '',
      inputTokenLimit: Number(item[5]) || 0,
      outputTokenLimit: Number(item[6]) || 0,
    });
  }
  return out;
}

function nextPacificMidnight() {
  const now = new Date();
  const la = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const offset = now.getTime() - la.getTime();
  const next = new Date(la);
  next.setHours(24, 0, 30, 0);
  return next.getTime() + offset;
}
