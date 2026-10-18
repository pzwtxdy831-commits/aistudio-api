// Persists Gemini thought signatures keyed by tool-call id, so OpenAI-style clients
// (which drop unknown fields) can still replay function-call history to Gemini 3 models.
import { readJson, writeJsonAtomic } from './util.js';

const LIMIT = 4000;

export class SigCache {
  constructor(file) {
    this.file = file;
    this.map = new Map(Object.entries(readJson(file, {})));
    this.timer = null;
  }

  get(key) {
    return key ? this.map.get(key) : undefined;
  }

  set(key, sig) {
    if (!key || !sig) return;
    this.map.delete(key);
    this.map.set(key, sig);
    while (this.map.size > LIMIT) this.map.delete(this.map.keys().next().value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 2000);
  }

  flush() {
    try {
      writeJsonAtomic(this.file, Object.fromEntries(this.map));
    } catch { /* best effort */ }
  }
}
