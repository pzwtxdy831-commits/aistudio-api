// Gemini native protocol: /v1beta/models/{model}:generateContent | :streamGenerateContent
import {
  pick, buildSafety, buildTools, buildGen, normalizeContents, systemFrom, addSystemText, FORCE_CALL_HINT,
} from './common.js';

export function parseModelSuffix(model) {
  const extra = [];
  let m = model.replace(/^models\//, '');
  if (m.endsWith('-search')) {
    m = m.slice(0, -7);
    extra.push('googleSearch');
  }
  return { model: m, extra };
}

export function fromGemini(body, rawModel, cfg) {
  const { model, extra } = parseModelSuffix(rawModel);
  const contents = normalizeContents(body.contents);
  if (!contents.length) throw Object.assign(new Error('contents 不能为空'), { status: 400 });
  let systemInstruction = systemFrom(pick(body, 'systemInstruction', 'system_instruction'));
  const { tools, forceCall } = buildTools(body.tools, pick(body, 'toolConfig', 'tool_config'), extra);
  if (forceCall) systemInstruction = addSystemText(systemInstruction, FORCE_CALL_HINT);
  const gen = buildGen(pick(body, 'generationConfig', 'generation_config') || {}, cfg);
  return {
    model, contents, systemInstruction, tools, gen,
    safety: buildSafety(pick(body, 'safetySettings', 'safety_settings'), cfg),
    includeThoughts: gen.includeThoughts ?? cfg.includeThoughts,
  };
}

function mergeParts(parts) {
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && typeof p.text === 'string' && typeof last.text === 'string' && !!p.thought === !!last.thought && !p.thoughtSignature && !last.thoughtSignature) {
      last.text += p.text;
    } else out.push({ ...p });
  }
  return out;
}

function chunkBody(parts, finishReason, usage, model, responseId) {
  const cand = { content: { role: 'model', parts }, index: 0 };
  if (finishReason) cand.finishReason = finishReason;
  const body = { candidates: [cand], modelVersion: model };
  if (usage) body.usageMetadata = usage;
  if (responseId) body.responseId = responseId;
  return body;
}

export async function handleGemini(engine, cfg, rawModel, body, res, { stream, sse }, signal) {
  const req = fromGemini(body, rawModel, cfg);
  const keep = (p) => !(p.thought && !req.includeThoughts);
  const it = engine.generate(req, signal);

  if (!stream) {
    const parts = [];
    let finish = 'STOP';
    let usage = null;
    let blocked = null;
    for await (const ev of it) {
      if (ev.type === 'part' && keep(ev.part)) parts.push(ev.part);
      else if (ev.type === 'finish') finish = ev.reason;
      else if (ev.type === 'usage') usage = ev.usage;
      else if (ev.type === 'blocked') blocked = ev.reason;
    }
    const out = blocked && !parts.length
      ? { promptFeedback: { blockReason: blocked }, modelVersion: req.model }
      : chunkBody(mergeParts(parts), finish, usage, req.model);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out));
    return;
  }

  // streaming: wait for the first event before committing headers so early errors become proper HTTP errors
  let started = false;
  let first = true;
  const begin = () => {
    if (started) return;
    started = true;
    res.writeHead(200, {
      'Content-Type': sse ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (!sse) res.write('[');
  };
  const send = (obj) => {
    begin();
    if (sse) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    else {
      res.write((first ? '' : ',\n') + JSON.stringify(obj));
      first = false;
    }
  };
  let pendingFinish = null;
  try {
    for await (const ev of it) {
      if (ev.type === 'part') {
        if (keep(ev.part)) send(chunkBody([ev.part], null, null, req.model));
      } else if (ev.type === 'finish') pendingFinish = ev.reason;
      else if (ev.type === 'blocked') send({ promptFeedback: { blockReason: ev.reason }, modelVersion: req.model });
      else if (ev.type === 'usage') {
        send(chunkBody([{ text: '' }], pendingFinish || 'STOP', ev.usage, req.model));
        pendingFinish = null;
      }
    }
    if (pendingFinish) send(chunkBody([{ text: '' }], pendingFinish, null, req.model));
    if (!started) send(chunkBody([{ text: '' }], 'STOP', null, req.model));
  } catch (e) {
    if (!started) throw e;
    send({ error: { code: e.status || 500, message: e.message, status: 'INTERNAL' } });
  }
  if (!sse) res.write(']');
  res.end();
}

export function geminiModelList(models) {
  return {
    models: models.map((m) => ({
      name: `models/${m.id}`,
      version: '001',
      displayName: m.displayName,
      description: m.description,
      inputTokenLimit: m.inputTokenLimit || 1048576,
      outputTokenLimit: m.outputTokenLimit || 65536,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
    })),
  };
}
