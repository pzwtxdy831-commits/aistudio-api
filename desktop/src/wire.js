// AI Studio (MakerSuite) Protobuf-over-JSON wire codec.
// Internal representation everywhere is the public Gemini API JSON shape
// (contents[].parts[] with text / inlineData / functionCall / functionResponse / thought / thoughtSignature).
import { createHash } from 'node:crypto';

// ---- top-level request indexes ----
const I_MODEL = 0, I_CONTENTS = 1, I_SAFETY = 2, I_GEN = 3, I_SNAPSHOT = 4,
  I_SYSTEM = 5, I_TOOLS = 6, I_FLAG = 10, I_CACHED = 11, I_LOCATION = 13;

// ---- part indexes ----
const P_THOUGHT_LEAD = 0, P_TEXT = 1, P_INLINE = 2, P_FC = 3, P_FR = 4, P_FILE = 5,
  P_EXEC = 8, P_EXEC_RESULT = 9, P_FC_ALT = 10, P_FR_ALT = 11, P_THOUGHT_FLAG = 12, P_SIG = 14;

// ---- generationConfig indexes ----
const G = {
  stop: 1, maxTokens: 3, temperature: 4, topP: 5, topK: 6, mime: 7, schema: 8,
  presence: 9, frequency: 10, imageMode: 14, thinking: 16, mediaRes: 17, outputRes: 26,
};

export const THINKING_LEVELS = { low: 1, medium: 2, high: 3, minimal: 4 };

export const FINISH_REASONS = [
  'FINISH_REASON_UNSPECIFIED', 'STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'LANGUAGE', 'OTHER',
  'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL', 'IMAGE_SAFETY',
  'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS', 'IMAGE_PROHIBITED_CONTENT', 'NO_IMAGE',
  'IMAGE_RECITATION', 'IMAGE_OTHER',
];

export const BUILTIN_TOOLS = {
  codeExecution: [[]],
  googleSearch: [null, null, null, [null, [[]]]],
  googleMaps: [null, null, null, null, null, null, null, null, null, null, []],
  urlContext: [null, null, null, null, null, null, null, []],
};

const compact = (arr) => {
  while (arr.length && (arr[arr.length - 1] === null || arr[arr.length - 1] === undefined)) arr.pop();
  for (let i = 0; i < arr.length; i++) if (arr[i] === undefined) arr[i] = null;
  return arr;
};

// ---------------- google.protobuf.Struct / Value ----------------
export function encodeValue(v) {
  if (v === null || v === undefined) return [0];
  if (typeof v === 'boolean') return [null, null, null, v];
  if (typeof v === 'number') return [null, v];
  if (typeof v === 'string') return [null, null, v];
  if (Array.isArray(v)) return [null, null, null, null, null, [v.map(encodeValue)]];
  if (typeof v === 'object') return [null, null, null, null, encodeStruct(v)];
  return [null, null, String(v)];
}

export function encodeStruct(obj) {
  return [Object.entries(obj || {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encodeValue(v)])];
}

const isWireValue = (v) => Array.isArray(v) && v.length > 0 && (v[0] === null || (v[0] === 0 && v.length === 1));

export function decodeStruct(raw) {
  if (raw && !Array.isArray(raw) && typeof raw === 'object') return raw;
  if (!Array.isArray(raw) || !raw.length) return {};
  if (raw.length >= 2 && typeof raw[0] === 'string') return { [raw[0]]: decodeValue(raw[1]) };
  let entries = raw;
  while (Array.isArray(entries) && entries.length === 1 && Array.isArray(entries[0]) &&
    !(entries[0].length >= 2 && typeof entries[0][0] === 'string')) entries = entries[0];
  const out = {};
  if (!Array.isArray(entries)) return out;
  for (const item of entries) {
    if (Array.isArray(item) && item.length >= 2 && typeof item[0] === 'string') out[item[0]] = decodeValue(item[1]);
  }
  return out;
}

function decodeList(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const items = raw.length === 1 && Array.isArray(raw[0]) && !isWireValue(raw[0]) ? raw[0] : raw;
  return items.map(decodeValue);
}

export function decodeValue(v) {
  if (!Array.isArray(v)) return v;
  if (v.length === 0) return [];
  if (v.length === 1 && v[0] === 0) return null;
  if (v.length >= 2 && typeof v[1] === 'number') return v[1];
  if (v.length >= 3 && typeof v[2] === 'string') return v[2];
  if (v.length >= 4 && v[3] !== null && v[3] !== undefined) {
    if (typeof v[3] === 'boolean') return v[3];
    if (v[3] === 0 || v[3] === 1) return Boolean(v[3]);
  }
  if (v.length >= 5 && v[4] !== null && v[4] !== undefined) return decodeStruct(v[4]);
  if (v.length >= 6 && v[5] !== null && v[5] !== undefined) return decodeList(v[5]);
  return v.map(decodeValue);
}

// ---------------- request parts ----------------
export function encodePart(p) {
  const w = [];
  const sig = p.thoughtSignature || p.thought_signature;
  if (p.fileData) {
    w[P_FILE] = [p.fileData.fileUri || p.fileData.id];
  } else if (p.inlineData) {
    w[P_INLINE] = [p.inlineData.mimeType || p.inlineData.mime_type || 'application/octet-stream', p.inlineData.data];
  } else if (p.functionCall) {
    const fc = [p.functionCall.name, encodeStruct(p.functionCall.args || {})];
    if (p.functionCall.id) fc.push(p.functionCall.id);
    w[P_FC_ALT] = fc;
  } else if (p.functionResponse) {
    const fr = [p.functionResponse.name, encodeStruct(normalizeResponseObject(p.functionResponse.response))];
    if (p.functionResponse.id) fr.push(p.functionResponse.id);
    w[P_FR_ALT] = fr;
  } else if (p.executableCode) {
    w[P_EXEC] = [String(p.executableCode.language || 'PYTHON').toUpperCase() === 'PYTHON' ? 1 : 0, p.executableCode.code || ''];
  } else if (p.codeExecutionResult) {
    const map = { OUTCOME_OK: 1, OUTCOME_FAILED: 2, OUTCOME_DEADLINE_EXCEEDED: 3 };
    w[P_EXEC_RESULT] = [map[p.codeExecutionResult.outcome] || 1, p.codeExecutionResult.output || ''];
  } else {
    w[P_TEXT] = p.text ?? '';
    if (p.thought) w[P_THOUGHT_FLAG] = 1;
  }
  if (sig) w[P_SIG] = sig;
  return compact(w);
}

function normalizeResponseObject(r) {
  if (r && typeof r === 'object' && !Array.isArray(r)) return r;
  return { result: r ?? null };
}

export function encodeContent(c) {
  return [(c.parts || []).map(encodePart), c.role === 'model' ? 'model' : 'user'];
}

// BotGuard content hash: SHA-256 over every part's text / inline data / file id joined by a space
// (function call / response parts contribute an empty string), contents only — no system prompt.
export function contentHash(contents) {
  const pieces = [];
  for (const c of contents) {
    for (const p of c.parts || []) {
      if (p.fileData) pieces.push(p.fileData.fileUri || p.fileData.id || '');
      else if (p.inlineData) pieces.push(p.inlineData.data || '');
      else if (p.functionCall || p.functionResponse || p.executableCode || p.codeExecutionResult) pieces.push('');
      else pieces.push(p.text ?? '');
    }
  }
  return createHash('sha256').update(pieces.join(' '), 'utf8').digest('hex');
}

// Build the final request body from the browser-captured template.
// req: { model, contents, systemInstruction, tools(wire), safety(wire|null), gen{...}, snapshot, timezone }
export function buildRequestBody(templateBody, req) {
  let body;
  try {
    body = JSON.parse(templateBody);
  } catch {
    body = [];
  }
  if (!Array.isArray(body)) body = [];
  while (body.length <= I_LOCATION) body.push(null);

  const model = req.model.startsWith('models/') ? req.model : `models/${req.model}`;
  body[I_MODEL] = model;
  body[I_CONTENTS] = req.contents.map(encodeContent);
  body[I_SAFETY] = req.safety ?? null;
  body[I_GEN] = buildGenerationConfig(Array.isArray(body[I_GEN]) ? body[I_GEN] : [], req.gen || {}, req.model);
  body[I_SNAPSHOT] = req.snapshot;
  body[I_SYSTEM] = req.systemInstruction && req.systemInstruction.parts?.length
    ? [req.systemInstruction.parts.map(encodePart), 'user']
    : null;
  body[I_TOOLS] = req.tools && req.tools.length ? req.tools : null;
  body[7] = null; // evergreen model uri from the template's model
  body[I_FLAG] = 1;
  body[I_CACHED] = null;
  if (body[I_TOOLS]) body[I_LOCATION] = [[null, null, req.timezone || 'UTC'], null, 1];
  else body[I_LOCATION] = null;
  return JSON.stringify(compact(body));
}

function isImageModel(model) {
  return /image|imagen/i.test(model);
}

// Slots copied from the UI-captured template. Everything else is rebuilt per request: the template
// reflects whatever model is selected in the AI Studio page, and model-specific slots (e.g. index 47
// captured under gemini-4-argon) make other models reject the request as "unsupported capabilities".
const TEMPLATE_GEN_SLOTS = [G.maxTokens, 13];

function buildGenerationConfig(template, gen, model) {
  const g = [];
  const set = (idx, v) => {
    while (g.length <= idx) g.push(null);
    g[idx] = v;
  };
  for (const idx of TEMPLATE_GEN_SLOTS) if (template[idx] !== undefined && template[idx] !== null) set(idx, template[idx]);
  set(G.mime, gen.responseMimeType || 'text/plain');
  if (gen.maxOutputTokens) set(G.maxTokens, gen.maxOutputTokens);
  if (gen.temperature !== undefined && gen.temperature !== null) set(G.temperature, gen.temperature);
  if (gen.topP !== undefined && gen.topP !== null) set(G.topP, gen.topP);
  if (gen.topK !== undefined && gen.topK !== null) set(G.topK, gen.topK);
  if (gen.stopSequences?.length) set(G.stop, gen.stopSequences.slice(0, 5));
  if (gen.presencePenalty) set(G.presence, gen.presencePenalty);
  if (gen.frequencyPenalty) set(G.frequency, gen.frequencyPenalty);
  if (gen.responseSchemaWire) set(G.schema, gen.responseSchemaWire);
  if (gen.mediaResolution) set(G.mediaRes, gen.mediaResolution);
  if (isImageModel(model)) {
    if (gen.imageMode) set(G.imageMode, gen.imageMode);
    if (gen.outputResolution) set(G.outputRes, gen.outputResolution);
    // image models reject text-model carry-over slots
    for (const idx of [G.mime, G.schema, G.topK, G.thinking, G.presence, G.frequency]) if (idx < g.length) g[idx] = null;
  } else if (gen.thinkingLevel && !/gemma|tts|lyria/i.test(model)) {
    set(G.thinking, [1, null, null, gen.thinkingLevel]);
  }
  return compact(g);
}

// ---------------- response parsing ----------------
function parsePart(raw) {
  if (!Array.isArray(raw)) return null;
  if (raw.length > 0 && Array.isArray(raw[0])) return null;
  const sig = typeof raw[P_SIG] === 'string' ? raw[P_SIG] : undefined;
  const thought = raw[P_THOUGHT_FLAG] === 1 || raw[P_THOUGHT_FLAG] === true || raw[P_THOUGHT_LEAD] === true ||
    raw[P_FC_ALT] === true;

  const fcRaw = [raw[P_FC_ALT], raw[P_FC]].find((x) => Array.isArray(x) && typeof x[0] === 'string');
  if (fcRaw) {
    let args = {};
    if (typeof fcRaw[1] === 'string') {
      try { args = JSON.parse(fcRaw[1]); } catch { args = { arguments: fcRaw[1] }; }
    } else if (fcRaw[1] !== null && fcRaw[1] !== undefined) {
      args = decodeStruct(fcRaw[1]);
    }
    const part = { functionCall: { name: fcRaw[0], args } };
    if (typeof fcRaw[2] === 'string' && fcRaw[2]) part.functionCall.id = fcRaw[2];
    if (sig) part.thoughtSignature = sig;
    return part;
  }
  if (Array.isArray(raw[P_INLINE]) && raw[P_INLINE].length >= 2) {
    const part = { inlineData: { mimeType: String(raw[P_INLINE][0]), data: String(raw[P_INLINE][1]) } };
    if (thought) part.thought = true;
    if (sig) part.thoughtSignature = sig;
    return part;
  }
  if (Array.isArray(raw[P_EXEC])) {
    return { executableCode: { language: 'PYTHON', code: String(raw[P_EXEC][1] ?? raw[P_EXEC][0] ?? '') } };
  }
  if (Array.isArray(raw[P_EXEC_RESULT])) {
    const outcome = ['OUTCOME_UNSPECIFIED', 'OUTCOME_OK', 'OUTCOME_FAILED', 'OUTCOME_DEADLINE_EXCEEDED'][raw[P_EXEC_RESULT][0]] || 'OUTCOME_OK';
    return { codeExecutionResult: { outcome, output: String(raw[P_EXEC_RESULT][1] ?? '') } };
  }
  if (typeof raw[P_TEXT] === 'string') {
    const part = { text: raw[P_TEXT] };
    if (thought) part.thought = true;
    if (sig) part.thoughtSignature = sig;
    return part;
  }
  if (sig) return { text: '', thoughtSignature: sig };
  return null;
}

const toInt = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined);

export function parseUsage(raw) {
  if (!Array.isArray(raw)) return null;
  const prompt = toInt(raw[0]);
  const visible = toInt(raw[1]);
  const total = toInt(raw[2]);
  const cached = toInt(raw[3]);
  const reasoning = toInt(raw[9]);
  const usage = { promptTokenCount: prompt ?? 0 };
  usage.candidatesTokenCount = visible ?? 0;
  if (reasoning) usage.thoughtsTokenCount = reasoning;
  if (cached) usage.cachedContentTokenCount = cached;
  usage.totalTokenCount = total ?? (prompt ?? 0) + (visible ?? 0) + (reasoning ?? 0);
  return usage;
}

// One streamed chunk → { parts, finishReason, usage, responseId, finishMessage }
export function parseChunk(chunk) {
  const out = { parts: [] };
  if (!Array.isArray(chunk)) return out;
  const cand = Array.isArray(chunk[0]) ? chunk[0][0] : null;
  if (Array.isArray(cand)) {
    const content = cand[0];
    const rawParts = Array.isArray(content) && Array.isArray(content[0]) ? content[0] : [];
    for (const rp of rawParts) {
      const p = parsePart(rp);
      if (p) out.parts.push(p);
    }
    if (typeof cand[1] === 'number' && cand[1] > 0) out.finishReason = FINISH_REASONS[cand[1]] || 'OTHER';
    if (typeof cand[3] === 'string') out.finishMessage = cand[3];
  }
  const usage = parseUsage(chunk[2]);
  if (usage) out.usage = usage;
  if (typeof chunk[7] === 'string') out.responseId = chunk[7];
  // prompt feedback (blocked prompt) lives at chunk[1]
  if (Array.isArray(chunk[1]) && typeof chunk[1][0] === 'number' && chunk[1][0] > 0 && !out.parts.length) {
    out.blockReason = ['BLOCK_REASON_UNSPECIFIED', 'SAFETY', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT'][chunk[1][0]] || 'OTHER';
  }
  return out;
}

// Incremental splitter for the streamed `)]}'\n[[chunk,chunk,...]]` body: yields each chunk (depth-3 array) as soon as it closes.
export class StreamSplitter {
  constructor() {
    this.buf = '';
    this.pos = 0;
    this.depth = 0;
    this.inStr = false;
    this.esc = false;
    this.start = -1;
    this.prefixDone = false;
  }

  feed(text) {
    this.buf += text;
    const out = [];
    if (!this.prefixDone) {
      const trimmed = this.buf.trimStart();
      if (trimmed.startsWith(")]}'")) {
        this.buf = trimmed.slice(4);
        this.prefixDone = true;
      } else if (")]}'".startsWith(trimmed)) {
        return out;
      } else {
        this.prefixDone = true;
      }
    }
    const s = this.buf;
    for (let i = this.pos; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (ch === 92) this.esc = true;
        else if (ch === 34) this.inStr = false;
        continue;
      }
      if (ch === 34) this.inStr = true;
      else if (ch === 91) {
        this.depth++;
        if (this.depth === 3 && this.start < 0) this.start = i;
      } else if (ch === 93) {
        this.depth--;
        if (this.depth === 2 && this.start >= 0) {
          try {
            out.push(JSON.parse(s.slice(this.start, i + 1)));
          } catch { /* malformed chunk, skip */ }
          this.start = -1;
        }
      }
    }
    // drop consumed text to keep the buffer small
    if (this.start >= 0) {
      this.buf = s.slice(this.start);
      this.start = 0;
    } else {
      this.buf = '';
    }
    this.pos = this.buf.length;
    return out;
  }
}

// Error bodies look like `[,[7,"The caller does not have permission"]]` or JSON objects.
export function parseErrorBody(text) {
  const t = String(text || '').replace(/^\)\]\}'\s*/, '').trim();
  try {
    const j = JSON.parse(t.replace(/^\[,/, '[null,'));
    if (Array.isArray(j)) {
      const e = j.find((x) => Array.isArray(x) && typeof x[0] === 'number' && typeof x[1] === 'string');
      if (e) return { code: e[0], message: e[1] };
    }
    if (j && j.error) return { code: j.error.code, message: j.error.message || JSON.stringify(j.error) };
  } catch { /* not json */ }
  return { code: 0, message: t.slice(0, 500) };
}
