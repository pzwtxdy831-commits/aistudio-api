// Shared request normalisation: tools, safety, generation config, contents.
import { BUILTIN_TOOLS, THINKING_LEVELS } from './wire.js';
import { declarationToWire, schemaToWire } from './schema.js';

export const pick = (o, ...keys) => {
  if (!o || typeof o !== 'object') return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

const SAFETY_CATEGORIES = {
  HARM_CATEGORY_HARASSMENT: 7, HARM_CATEGORY_HATE_SPEECH: 8,
  HARM_CATEGORY_SEXUALLY_EXPLICIT: 9, HARM_CATEGORY_DANGEROUS_CONTENT: 10,
};
const SAFETY_THRESHOLDS = {
  BLOCK_LOW_AND_ABOVE: 1, BLOCK_MEDIUM_AND_ABOVE: 2, BLOCK_ONLY_HIGH: 3, BLOCK_NONE: 4, OFF: 5,
};

export function buildSafety(settings, cfg) {
  if (cfg.safetyOff || !Array.isArray(settings) || !settings.length) {
    return [7, 8, 9, 10].map((c) => [null, null, c, 5]);
  }
  const out = [];
  for (const s of settings) {
    const c = SAFETY_CATEGORIES[s.category];
    const t = SAFETY_THRESHOLDS[s.threshold];
    if (c && t) out.push([null, null, c, t]);
  }
  return out.length ? out : null;
}

// Gemini-style tools array → { tools: wire[], forceCall: bool }
export function buildTools(toolList, toolConfig, extraBuiltins = []) {
  const decls = [];
  const builtins = new Set(extraBuiltins);
  for (const t of Array.isArray(toolList) ? toolList : []) {
    if (!t || typeof t !== 'object') continue;
    const fds = pick(t, 'functionDeclarations', 'function_declarations');
    if (Array.isArray(fds)) decls.push(...fds);
    if (t.type === 'function' && t.function) decls.push(t.function); // OpenAI shape
    if (pick(t, 'googleSearch', 'google_search', 'googleSearchRetrieval', 'google_search_retrieval')) builtins.add('googleSearch');
    if (pick(t, 'codeExecution', 'code_execution')) builtins.add('codeExecution');
    if (pick(t, 'urlContext', 'url_context')) builtins.add('urlContext');
    if (pick(t, 'googleMaps', 'google_maps')) builtins.add('googleMaps');
  }
  const fcc = pick(toolConfig, 'functionCallingConfig', 'function_calling_config') || {};
  const mode = String(fcc.mode || 'AUTO').toUpperCase();
  const allowed = pick(fcc, 'allowedFunctionNames', 'allowed_function_names');
  let usable = mode === 'NONE' ? [] : decls;
  if (Array.isArray(allowed) && allowed.length) usable = usable.filter((d) => allowed.includes((d.function || d).name));
  const wire = [];
  if (usable.length) wire.push([null, usable.map(declarationToWire)]);
  for (const b of builtins) if (BUILTIN_TOOLS[b]) wire.push(BUILTIN_TOOLS[b]);
  return { tools: wire, forceCall: usable.length > 0 && (mode === 'ANY' || mode === 'REQUIRED'), names: usable.map((d) => (d.function || d).name) };
}

export function thinkingLevelFrom(value, cfg) {
  if (value === undefined || value === null || value === '') return THINKING_LEVELS[cfg.defaultThinkingLevel] || THINKING_LEVELS.high;
  if (typeof value === 'number') {
    if (value < 0) return THINKING_LEVELS.high;
    if (value === 0) return THINKING_LEVELS.minimal;
    if (value <= 2048) return THINKING_LEVELS.low;
    if (value <= 12000) return THINKING_LEVELS.medium;
    return THINKING_LEVELS.high;
  }
  const v = String(value).toLowerCase().replace('thinking_level_', '');
  if (v === 'none') return THINKING_LEVELS.minimal;
  return THINKING_LEVELS[v] || THINKING_LEVELS[cfg.defaultThinkingLevel] || THINKING_LEVELS.high;
}

const MEDIA_RES = { MEDIA_RESOLUTION_LOW: 1, MEDIA_RESOLUTION_MEDIUM: 2, MEDIA_RESOLUTION_HIGH: 3 };

export function buildGen(gc = {}, cfg) {
  const gen = {
    temperature: pick(gc, 'temperature'),
    topP: pick(gc, 'topP', 'top_p'),
    topK: pick(gc, 'topK', 'top_k'),
    maxOutputTokens: pick(gc, 'maxOutputTokens', 'max_output_tokens'),
    stopSequences: pick(gc, 'stopSequences', 'stop_sequences'),
    presencePenalty: pick(gc, 'presencePenalty', 'presence_penalty'),
    frequencyPenalty: pick(gc, 'frequencyPenalty', 'frequency_penalty'),
    responseMimeType: pick(gc, 'responseMimeType', 'response_mime_type'),
  };
  const schema = pick(gc, 'responseSchema', 'response_schema', 'responseJsonSchema', 'response_json_schema');
  if (schema && typeof schema === 'object') {
    gen.responseMimeType = 'application/json';
    gen.responseSchemaWire = schemaToWire(schema);
  }
  const tc = pick(gc, 'thinkingConfig', 'thinking_config') || {};
  gen.thinkingLevel = thinkingLevelFrom(pick(tc, 'thinkingLevel', 'thinking_level', 'thinkingBudget', 'thinking_budget'), cfg);
  const inc = pick(tc, 'includeThoughts', 'include_thoughts');
  gen.includeThoughts = inc === undefined ? null : Boolean(inc);
  const mods = pick(gc, 'responseModalities', 'response_modalities');
  if (Array.isArray(mods) && mods.map((m) => String(m).toUpperCase()).includes('IMAGE')) {
    gen.imageMode = mods.map((m) => String(m).toUpperCase()).includes('TEXT') ? [2, 1] : [2];
  }
  const ic = pick(gc, 'imageConfig', 'image_config');
  if (ic && (ic.aspectRatio || ic.imageSize)) gen.outputResolution = [ic.aspectRatio || null, ic.imageSize || null];
  const mr = pick(gc, 'mediaResolution', 'media_resolution');
  if (MEDIA_RES[mr]) gen.mediaResolution = MEDIA_RES[mr];
  return gen;
}

// Keep only fields the wire codec understands; drop prior thought text; merge same-role turns.
export function normalizeContents(contents) {
  const out = [];
  for (const c of Array.isArray(contents) ? contents : []) {
    if (!c) continue;
    const role = c.role === 'model' || c.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    for (const p of Array.isArray(c.parts) ? c.parts : typeof c.parts === 'string' ? [{ text: c.parts }] : []) {
      if (!p || typeof p !== 'object') continue;
      const sig = pick(p, 'thoughtSignature', 'thought_signature');
      const fc = pick(p, 'functionCall', 'function_call');
      const fr = pick(p, 'functionResponse', 'function_response');
      const inline = pick(p, 'inlineData', 'inline_data');
      const file = pick(p, 'fileData', 'file_data');
      const q = {};
      if (fc) q.functionCall = { name: fc.name, args: fc.args || {}, id: fc.id };
      else if (fr) q.functionResponse = { name: fr.name, response: fr.response, id: fr.id };
      else if (inline) q.inlineData = { mimeType: pick(inline, 'mimeType', 'mime_type'), data: inline.data };
      else if (file) q.fileData = { fileUri: pick(file, 'fileUri', 'file_uri') };
      else if (p.executableCode || p.executable_code) q.executableCode = p.executableCode || p.executable_code;
      else if (p.codeExecutionResult || p.code_execution_result) q.codeExecutionResult = p.codeExecutionResult || p.code_execution_result;
      else if (typeof p.text === 'string') {
        if (p.thought) continue; // thoughts are never replayed upstream
        q.text = p.text;
      } else continue;
      if (sig) q.thoughtSignature = sig;
      parts.push(q);
    }
    if (!parts.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  }
  return out;
}

export function systemFrom(si) {
  if (!si) return null;
  if (typeof si === 'string') return si.trim() ? { parts: [{ text: si }] } : null;
  const parts = (Array.isArray(si.parts) ? si.parts : []).filter((p) => typeof p?.text === 'string' && p.text).map((p) => ({ text: p.text }));
  return parts.length ? { parts } : null;
}

export function addSystemText(system, text) {
  const parts = system?.parts ? [...system.parts] : [];
  parts.push({ text });
  return { parts };
}

export const FORCE_CALL_HINT = 'You must respond by calling one of the provided functions/tools. Do not reply with plain text.';
