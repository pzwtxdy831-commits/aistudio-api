// Parse cookies pasted by the user into CDP Network.CookieParam[].
// Accepts: "a=b; c=d" header strings, JSON arrays (Cookie-Editor / EditThisCookie exports,
// optionally wrapped in { cookies: [...] }), and Netscape cookies.txt lines.

const GOOGLE = /(^|\.)google\.com$/i;

function sameSite(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'no_restriction' || s === 'none') return 'None';
  if (s === 'lax') return 'Lax';
  if (s === 'strict') return 'Strict';
  return undefined;
}

function fromHeaderPair(name, value) {
  const c = { name, value, path: '/', secure: true };
  if (name.startsWith('__Host-')) c.url = 'https://accounts.google.com/';
  else c.domain = '.google.com';
  if (/^(SID|HSID|SSID|APISID|SAPISID|__Secure-.*)$/.test(name)) c.httpOnly = /^(SID|HSID|SSID|__Secure-\dPSID.*)$/.test(name);
  return c;
}

function fromJson(o) {
  if (!o || !o.name) return null;
  const domain = String(o.domain || o.host || '.google.com');
  if (!GOOGLE.test(domain.replace(/^\./, ''))) return null;
  const c = { name: String(o.name), value: String(o.value ?? ''), path: o.path || '/', secure: o.secure !== false, httpOnly: !!(o.httpOnly ?? o.httponly) };
  if (c.name.startsWith('__Host-') || o.hostOnly) c.url = `https://${domain.replace(/^\./, '')}${c.path}`;
  else c.domain = domain.startsWith('.') ? domain : '.' + domain;
  const ss = sameSite(o.sameSite ?? o.samesite);
  if (ss) c.sameSite = ss;
  const exp = Number(o.expirationDate ?? o.expires ?? o.expiry);
  if (Number.isFinite(exp) && exp > 0) c.expires = exp > 1e12 ? Math.floor(exp / 1000) : exp;
  return c;
}

export function parseCookieInput(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Cookie 为空');
  let list = [];
  if (t.startsWith('[') || t.startsWith('{')) {
    let j;
    try { j = JSON.parse(t); } catch { throw new Error('Cookie JSON 格式不对'); }
    const arr = Array.isArray(j) ? j : Array.isArray(j.cookies) ? j.cookies : [];
    list = arr.map(fromJson).filter(Boolean);
  } else if (t.split('\n').some((l) => l.split('\t').length >= 7)) {
    for (const line of t.split(/\r?\n/)) {
      const f = line.replace(/^#HttpOnly_/, '').split('\t');
      if (f.length < 7 || line.startsWith('#') && !line.startsWith('#HttpOnly_')) continue;
      const c = fromJson({ domain: f[0], path: f[2], secure: f[3] === 'TRUE', expirationDate: Number(f[4]), name: f[5], value: f[6], httpOnly: line.startsWith('#HttpOnly_') });
      if (c) list.push(c);
    }
  } else {
    const header = t.replace(/^cookie:\s*/i, '');
    for (const part of header.split(/;\s*/)) {
      const i = part.indexOf('=');
      if (i <= 0) continue;
      list.push(fromHeaderPair(part.slice(0, i).trim(), part.slice(i + 1).trim()));
    }
  }
  const names = new Set(list.map((c) => c.name));
  if (!names.has('SAPISID') && !names.has('__Secure-1PAPISID')) throw new Error('Cookie 里没有 SAPISID / __Secure-1PAPISID，请复制 google.com 下的完整 Cookie');
  if (!names.has('SID') && !names.has('__Secure-1PSID')) throw new Error('Cookie 里没有 SID / __Secure-1PSID，请复制 google.com 下的完整 Cookie');
  return list;
}

// Network.Cookie (from getCookies) → CookieParam for storage
export function toCookieParam(c) {
  const p = { name: c.name, value: c.value, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly };
  if (c.domain && c.domain.startsWith('.')) p.domain = c.domain;
  else p.url = `https://${c.domain}${c.path || '/'}`;
  if (c.sameSite) p.sameSite = c.sameSite;
  if (c.expires && c.expires > 0) p.expires = c.expires;
  return p;
}
