// Persistent account registry: data/accounts.json
//   cookie: [{ id, name, authUser, cookies: CookieParam[], enabled, createdAt }]
//   ext:    { [key]: { email, enabled } }       (key = profileId:authUser)
import path from 'node:path';
import { DATA_DIR, readJson, writeJsonAtomic, rid } from './util.js';

const FILE = path.join(DATA_DIR, 'accounts.json');

export class AccountStore {
  constructor() {
    const d = readJson(FILE, {});
    this.cookie = Array.isArray(d.cookie) ? d.cookie : [];
    this.ext = d.ext && typeof d.ext === 'object' ? d.ext : {};
  }

  save() {
    writeJsonAtomic(FILE, { cookie: this.cookie, ext: this.ext });
  }

  addCookie({ name, authUser, cookies }) {
    const rec = { id: 'ck_' + rid(8), name: name || '', authUser: Number(authUser) || 0, cookies, enabled: true, createdAt: Date.now() };
    this.cookie.push(rec);
    this.save();
    return rec;
  }

  updateCookie(id, patch) {
    const rec = this.cookie.find((c) => c.id === id);
    if (!rec) return null;
    Object.assign(rec, patch);
    this.save();
    return rec;
  }

  removeCookie(id) {
    this.cookie = this.cookie.filter((c) => c.id !== id);
    this.save();
  }

  extInfo(key) {
    if (!this.ext[key]) this.ext[key] = { email: '', enabled: true };
    return this.ext[key];
  }

  updateExt(key, patch) {
    Object.assign(this.extInfo(key), patch);
    this.save();
  }

  removeExt(key) {
    delete this.ext[key];
    this.save();
  }
}
