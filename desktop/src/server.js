import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { handleOpenAI, openaiModelList } from './openai.js';
import { handleGemini, geminiModelList } from './gemini.js';
import { ROOT, log, logBuffer } from './util.js';

const MAX_BODY = 200 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function apiKeyOf(req, url) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.headers['x-api-key'] || req.headers['x-goog-api-key'] || url.searchParams.get('key') || '';
}

export function createServer(engine, cfg) {
  const panel = () => readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  return http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    const url = new URL(req.url, 'http://localhost');
    let p = url.pathname.replace(/\/+$/, '') || '/';
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const isGeminiPath = p.startsWith('/v1beta') || p.startsWith('/v1/models/') && p.includes(':');

    try {
      // ---- panel ----
      if (p === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(panel());
      }
      if (p === '/api/ping') return sendJson(res, 200, { ok: true });
      if (p === '/api/status') {
        return sendJson(res, 200, { ...engine.status(), port: cfg.port, hasKey: !!cfg.apiKey, logs: logBuffer.slice(-80) });
      }
      // ---- account management ----
      const am = /^\/api\/accounts\/([^/]+)\/(restart|delete|enable|disable|show)$/.exec(p);
      if (am && req.method === 'POST') {
        const id = decodeURIComponent(am[1]);
        const action = am[2];
        if (action === 'restart') await engine.restartAccount(id);
        else if (action === 'delete') await engine.removeAccount(id);
        else if (action === 'enable') engine.setEnabled(id, true);
        else if (action === 'disable') engine.setEnabled(id, false);
        else if (action === 'show') await engine.showAccount(id);
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/settings' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        if (body.rotation) engine.setRotation(body.rotation);
        if (body.thinking4a !== undefined) engine.setThinkingOverride('gemini-4-argon', body.thinking4a);
        return sendJson(res, 200, { ok: true, rotation: cfg.rotation });
      }
      if (p === '/api/browser/show' && req.method === 'POST') {
        await engine.ensureBrowser();
        await engine._setWindowState('normal').catch(() => {});
        return sendJson(res, 200, { ok: true });
      }

      // ---- auth ----
      if (cfg.apiKey && apiKeyOf(req, url) !== cfg.apiKey) {
        return sendJson(res, 401, isGeminiPath
          ? { error: { code: 401, message: 'API key 无效', status: 'UNAUTHENTICATED' } }
          : { error: { message: 'API key 无效', type: 'invalid_request_error', code: 'invalid_api_key' } });
      }

      // ---- OpenAI ----
      if ((p === '/v1/models' || p === '/models') && req.method === 'GET') {
        return sendJson(res, 200, openaiModelList(await engine.listModels()));
      }
      if ((p === '/v1/chat/completions' || p === '/chat/completions') && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        return await handleOpenAI(engine, cfg, body, res, ac.signal);
      }

      // ---- Gemini ----
      if ((p === '/v1beta/models' || p === '/v1/models') && req.method === 'GET') {
        return sendJson(res, 200, geminiModelList(await engine.listModels()));
      }
      const m = /^\/v1(?:beta|alpha)?\/models\/([^:]+):(generateContent|streamGenerateContent|countTokens)$/.exec(p);
      if (m && req.method === 'POST') {
        const [, model, action] = m;
        const body = JSON.parse(await readBody(req));
        if (action === 'countTokens') {
          const text = JSON.stringify(body.contents || body.generateContentRequest?.contents || []);
          return sendJson(res, 200, { totalTokens: Math.ceil(text.length / 3.5) });
        }
        return await handleGemini(engine, cfg, decodeURIComponent(model), body, res, {
          stream: action === 'streamGenerateContent',
          sse: url.searchParams.get('alt') === 'sse',
        }, ac.signal);
      }
      const mm = /^\/v1(?:beta)?\/models\/([^:/]+)$/.exec(p);
      if (mm && req.method === 'GET') {
        const id = decodeURIComponent(mm[1]);
        const found = (await engine.listModels()).find((x) => x.id === id) || { id, displayName: id, description: '' };
        return sendJson(res, 200, geminiModelList([found]).models[0]);
      }

      sendJson(res, 404, { error: { message: `未知接口 ${req.method} ${p}` } });
    } catch (e) {
      const status = e.status || (e instanceof SyntaxError ? 400 : 500);
      if (status >= 500) log.error(`${req.method} ${p} 失败: ${e.message}`);
      if (res.headersSent) return res.end();
      sendJson(res, status, isGeminiPath
        ? { error: { code: status, message: e.message, status: status === 429 ? 'RESOURCE_EXHAUSTED' : status === 400 ? 'INVALID_ARGUMENT' : 'UNAVAILABLE' } }
        : { error: { message: e.message, type: e.type || (status === 400 ? 'invalid_request_error' : 'upstream_error'), code: status } });
    }
  });
}
