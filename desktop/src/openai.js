// OpenAI Chat Completions compatibility: /v1/chat/completions, /v1/models
import { buildSafety, buildTools, buildGen, normalizeContents, addSystemText, FORCE_CALL_HINT } from './common.js';
import { schemaToWire } from './schema.js';
import { parseModelSuffix } from './gemini.js';
import { rid, log } from './util.js';

const FINISH_MAP = {
  STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter',
  BLOCKLIST: 'content_filter', PROHIBITED_CONTENT: 'content_filter', SPII: 'content_filter',
  IMAGE_SAFETY: 'content_filter', IMAGE_PROHIBITED_CONTENT: 'content_filter',
};

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && (c.type === 'text' || typeof c.text === 'string')).map((c) => c.text || '').join('');
  return content == null ? '' : String(content);
}

function parseDataUrl(url) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url || '');
  if (!m) return null;
  const data = m[2] ? m[3] : Buffer.from(decodeURIComponent(m[3]), 'utf8').toString('base64');
  return { mimeType: m[1] || 'application/octet-stream', data };
}

async function fetchAsInline(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw Object.assign(new Error(`下载图片失败 HTTP ${r.status}: ${url}`), { status: 400 });
  const buf = Buffer.from(await r.arrayBuffer());
  return { mimeType: (r.headers.get('content-type') || 'image/jpeg').split(';')[0], data: buf.toString('base64') };
}

async function userParts(content) {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  const parts = [];
  for (const c of Array.isArray(content) ? content : []) {
    if (!c) continue;
    if (c.type === 'text' || (typeof c.text === 'string' && !c.type)) {
      if (c.text) parts.push({ text: c.text });
    } else if (c.type === 'image_url') {
      const url = typeof c.image_url === 'string' ? c.image_url : c.image_url?.url;
      const inline = parseDataUrl(url) || (url ? await fetchAsInline(url) : null);
      if (inline) parts.push({ inlineData: inline });
    } else if (c.type === 'input_audio' && c.input_audio?.data) {
      parts.push({ inlineData: { mimeType: `audio/${c.input_audio.format || 'wav'}`, data: c.input_audio.data } });
    } else if (c.type === 'file' && c.file?.file_data) {
      const inline = parseDataUrl(c.file.file_data);
      if (inline) parts.push({ inlineData: inline });
    }
  }
  return parts;
}

function parseArgs(s) {
  if (s && typeof s === 'object') return s;
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { arguments: String(s) };
  }
}

function parseToolResult(content) {
  const t = textOf(content);
  try {
    const v = JSON.parse(t);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    return { result: v };
  } catch {
    return { result: t };
  }
}

export async function fromOpenAI(body, cfg) {
  const { model, extra } = parseModelSuffix(String(body.model || ''));
  if (!model) throw Object.assign(new Error('缺少 model'), { status: 400 });
  const systemTexts = [];
  const contents = [];
  const callNames = new Map();
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m) continue;
    const role = m.role;
    if (role === 'system' || role === 'developer') {
      const t = textOf(m.content);
      if (t) systemTexts.push(t);
    } else if (role === 'user') {
      const parts = await userParts(m.content);
      if (parts.length) contents.push({ role: 'user', parts });
    } else if (role === 'assistant') {
      const parts = [];
      const t = textOf(m.content);
      if (t) parts.push({ text: t });
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const fn = tc.function || {};
        callNames.set(tc.id, fn.name);
        parts.push({ functionCall: { name: fn.name, args: parseArgs(fn.arguments), id: tc.id } });
      }
      if (m.function_call) parts.push({ functionCall: { name: m.function_call.name, args: parseArgs(m.function_call.arguments) } });
      if (parts.length) contents.push({ role: 'model', parts });
    } else if (role === 'tool' || role === 'function') {
      const name = m.name || callNames.get(m.tool_call_id) || 'tool';
      contents.push({ role: 'user', parts: [{ functionResponse: { name, response: parseToolResult(m.content), id: m.tool_call_id } }] });
    }
  }
  const merged = normalizeContents(contents);
  if (!merged.length) throw Object.assign(new Error('messages 里没有可发送的内容'), { status: 400 });

  // tools / legacy functions
  let toolList = [];
  if (Array.isArray(body.tools)) toolList = body.tools.filter((t) => t && (t.type === 'function' || t.function));
  if (Array.isArray(body.functions)) toolList.push(...body.functions.map((f) => ({ type: 'function', function: f })));
  if (Array.isArray(body.tools) && body.tools.some((t) => t?.type === 'web_search' || t?.type === 'web_search_preview' || t?.googleSearch || t?.google_search)) extra.push('googleSearch');
  const choice = body.tool_choice ?? body.function_call;
  let toolConfig;
  if (choice === 'none') toolConfig = { functionCallingConfig: { mode: 'NONE' } };
  else if (choice === 'required') toolConfig = { functionCallingConfig: { mode: 'ANY' } };
  else if (choice && typeof choice === 'object') {
    const name = choice.function?.name || choice.name;
    if (name) toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } };
  }
  const { tools, forceCall } = buildTools(toolList.map((t) => ({ functionDeclarations: [t.function] })), toolConfig, extra);

  let systemInstruction = systemTexts.length ? { parts: [{ text: systemTexts.join('\n\n') }] } : null;
  if (forceCall) systemInstruction = addSystemText(systemInstruction, FORCE_CALL_HINT);

  const effort = body.reasoning_effort ?? body.reasoning?.effort;
  const budget = body.thinking?.budget_tokens ?? body.extra_body?.thinking_budget;
  const gen = buildGen({
    temperature: body.temperature,
    topP: body.top_p,
    topK: body.top_k,
    maxOutputTokens: body.max_completion_tokens ?? body.max_tokens,
    stopSequences: typeof body.stop === 'string' ? [body.stop] : body.stop,
    presencePenalty: body.presence_penalty,
    frequencyPenalty: body.frequency_penalty,
    thinkingConfig: { thinkingLevel: effort ?? budget },
  }, cfg);
  const rf = body.response_format;
  if (rf?.type === 'json_object') gen.responseMimeType = 'application/json';
  if (rf?.type === 'json_schema' && rf.json_schema?.schema) {
    gen.responseMimeType = 'application/json';
    gen.responseSchemaWire = schemaToWire(rf.json_schema.schema);
  }
  let include;
  if (body.include_reasoning !== undefined) include = Boolean(body.include_reasoning);
  else if (body.reasoning?.exclude === true) include = false;
  return {
    model, contents: merged, systemInstruction, tools, gen,
    safety: buildSafety(null, cfg),
    includeThoughts: include ?? cfg.includeThoughts,
  };
}

function toUsage(u) {
  if (!u) return undefined;
  const completion = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
  return {
    prompt_tokens: u.promptTokenCount || 0,
    completion_tokens: completion,
    total_tokens: u.totalTokenCount || (u.promptTokenCount || 0) + completion,
    prompt_tokens_details: { cached_tokens: u.cachedContentTokenCount || 0 },
    completion_tokens_details: { reasoning_tokens: u.thoughtsTokenCount || 0 },
  };
}

// Non-text parts rendered as plain content
function partText(p) {
  if (p.inlineData) return `\n![image](data:${p.inlineData.mimeType};base64,${p.inlineData.data})\n`;
  if (p.executableCode) return `\n\`\`\`python\n${p.executableCode.code}\n\`\`\`\n`;
  if (p.codeExecutionResult) return `\n\`\`\`\n${p.codeExecutionResult.output}\n\`\`\`\n`;
  return p.text || '';
}

export async function handleOpenAI(engine, cfg, body, res, signal) {
  const req = await fromOpenAI(body, cfg);
  const id = 'chatcmpl-' + rid(24);
  const created = Math.floor(Date.now() / 1000);
  const model = body.model;
  const it = engine.generate(req, signal);

  if (!body.stream) {
    let content = '';
    let reasoning = '';
    const toolCalls = [];
    let finish = 'STOP';
    let usage = null;
    let blocked = null;
    for await (const ev of it) {
      if (ev.type === 'part') {
        const p = ev.part;
        if (p.functionCall) {
          toolCalls.push({ id: p.functionCall.id, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } });
        } else if (p.thought) {
          if (req.includeThoughts && p.text) reasoning += p.text;
        } else content += partText(p);
      } else if (ev.type === 'finish') finish = ev.reason;
      else if (ev.type === 'usage') usage = ev.usage;
      else if (ev.type === 'blocked') blocked = ev.reason;
    }
    const message = { role: 'assistant', content: content || (toolCalls.length ? null : '') };
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.length) message.tool_calls = toolCalls;
    const out = {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : blocked ? 'content_filter' : FINISH_MAP[finish] || 'stop' }],
      usage: toUsage(usage),
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out));
    return;
  }

  let started = false;
  const send = (obj) => {
    if (!started) {
      started = true;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const delta = (d, finish = null) => send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: d, finish_reason: finish }] });

  let toolIndex = 0;
  let finish = 'STOP';
  let usage = null;
  let blocked = false;
  try {
    for await (const ev of it) {
      if (ev.type === 'part') {
        const p = ev.part;
        if (p.functionCall) {
          delta({ tool_calls: [{ index: toolIndex++, id: p.functionCall.id, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } }] });
        } else if (p.thought) {
          if (req.includeThoughts && p.text) delta({ reasoning_content: p.text });
        } else {
          const t = partText(p);
          if (t) delta({ content: t });
        }
      } else if (ev.type === 'finish') finish = ev.reason;
      else if (ev.type === 'usage') usage = ev.usage;
      else if (ev.type === 'blocked') blocked = true;
    }
    delta({}, toolIndex ? 'tool_calls' : blocked ? 'content_filter' : FINISH_MAP[finish] || 'stop');
    if (usage && body.stream_options?.include_usage) send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: toUsage(usage) });
  } catch (e) {
    if (!started) throw e;
    log.warn('流式中途出错: ' + e.message);
    send({ error: { message: e.message, type: e.type || 'upstream_error', code: e.status || 500 } });
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

export function openaiModelList(models) {
  const created = Math.floor(Date.now() / 1000);
  return { object: 'list', data: models.map((m) => ({ id: m.id, object: 'model', created, owned_by: 'google' })) };
}
