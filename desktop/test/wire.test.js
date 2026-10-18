import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  encodeStruct, decodeStruct, encodePart, parseChunk, StreamSplitter, buildRequestBody, contentHash, parseErrorBody,
} from '../src/wire.js';
import { schemaToWire, declarationToWire } from '../src/schema.js';
import { fromOpenAI } from '../src/openai.js';
import { fromGemini } from '../src/gemini.js';

const cfg = { safetyOff: true, defaultThinkingLevel: 'high', includeThoughts: true };

test('struct round trip keeps nested values, lists and booleans', () => {
  const v = { a: 1, b: 'x', c: true, d: null, e: [1, 'two', { f: false }], g: { h: [] }, i: ['only'] };
  assert.deepEqual(decodeStruct(encodeStruct(v)), v);
});

test('function call part uses index 10 with call id and signature at 14', () => {
  const w = encodePart({ functionCall: { name: 'get', args: { city: 'SH' }, id: 'abc' }, thoughtSignature: 'SIG' });
  assert.equal(w[10][0], 'get');
  assert.deepEqual(w[10][1], [[['city', [null, null, 'SH']]]]);
  assert.equal(w[10][2], 'abc');
  assert.equal(w[14], 'SIG');
  const r = encodePart({ functionResponse: { name: 'get', response: { t: 24 } } });
  assert.deepEqual(r[11], ['get', [[['t', [null, 24]]]]]);
});

test('parses the real AI Studio function call response shape', () => {
  const chunk = [[[[[[null, null, null, null, null, null, null, null, null, null,
    ['getWeather', [[['city', [null, null, 'Shanghai']]]], 'e6ni61kr'], null, null, null, 'SIGNATURE']], 'model'], 1]],
  null, [5, 1, 6], null, null, null, null, 'resp_1'];
  const out = parseChunk(chunk);
  assert.deepEqual(out.parts, [{ functionCall: { name: 'getWeather', args: { city: 'Shanghai' }, id: 'e6ni61kr' }, thoughtSignature: 'SIGNATURE' }]);
  assert.equal(out.finishReason, 'STOP');
  assert.equal(out.responseId, 'resp_1');
});

test('stream splitter yields chunks incrementally from arbitrary splits', () => {
  const raw = ")]}'\n" + JSON.stringify(JSON.parse(readFileSync(new URL('./fixtures/stream_text.json', import.meta.url), 'utf8')));
  const whole = new StreamSplitter().feed(raw);
  assert.ok(whole.length >= 2);
  for (const size of [1, 7, 64, 333]) {
    const sp = new StreamSplitter();
    const got = [];
    for (let i = 0; i < raw.length; i += size) got.push(...sp.feed(raw.slice(i, i + size)));
    assert.deepEqual(got, whole);
  }
  const parsed = whole.map(parseChunk);
  assert.equal(parsed[0].parts[0].thought, true);
  assert.ok(parsed.some((p) => p.usage));
});

test('schema conversion handles $ref, nullable unions, const and drops unsupported keys', () => {
  const schema = {
    type: 'object', additionalProperties: false, $schema: 'x',
    $defs: { Unit: { type: 'string', enum: ['c', 'f'] } },
    properties: {
      unit: { $ref: '#/$defs/Unit' },
      maybe: { anyOf: [{ type: 'integer' }, { type: 'null' }], default: 3 },
      kind: { const: 'fixed' },
      tags: { type: 'array', items: { type: 'string' } },
      t: { type: ['number', 'null'] },
    },
    required: ['unit', 'missing'],
  };
  const w = schemaToWire(schema);
  assert.equal(w[0], 6);
  const props = Object.fromEntries(w[6]);
  assert.deepEqual(props.unit, [1, null, null, null, ['c', 'f']]);
  assert.deepEqual(props.maybe, [3, null, null, true]);
  assert.deepEqual(props.kind, [1, null, null, null, ['fixed']]);
  assert.deepEqual(props.tags, [5, null, null, null, null, [1]]);
  assert.deepEqual(props.t, [2, null, null, true]);
  assert.deepEqual(w[7], ['unit']);
  assert.ok(w.length <= 23);
  assert.deepEqual(declarationToWire({ name: 'noargs', description: 'd', parameters: { type: 'object', properties: {} } }), ['noargs', 'd']);
});

test('OpenAI tool-call history converts to Gemini contents', async () => {
  const req = await fromOpenAI({
    model: 'gemini-3-pro',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'w', arguments: '{"city":"SH"}' } }, { id: 'c2', type: 'function', function: { name: 'w', arguments: '{"city":"BJ"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"t":24}' },
      { role: 'tool', tool_call_id: 'c2', content: 'sunny' },
    ],
    tools: [{ type: 'function', function: { name: 'w', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    tool_choice: 'required',
  }, cfg);
  assert.equal(req.contents.length, 3);
  assert.equal(req.contents[1].parts.length, 2);
  assert.deepEqual(req.contents[2].parts.map((p) => p.functionResponse.response), [{ t: 24 }, { result: 'sunny' }]);
  assert.equal(req.contents[2].parts[1].functionResponse.name, 'w');
  assert.equal(req.tools[0][1][0][0], 'w');
  assert.ok(req.systemInstruction.parts.length === 2);
});

test('request body keeps template slots, sets snapshot and location with tools', () => {
  const tpl = JSON.stringify(['models/x', [[[[null, 'hi']], 'user']], null, [null, null, null, 65536, 1, 0.95, 64, 'text/plain', null, null, null, null, null, null, null, null, [1, null, null, 3]], '!old', null, null, null, null, null, 1]);
  const req = fromGemini({ contents: [{ role: 'user', parts: [{ text: 'yo' }] }], tools: [{ functionDeclarations: [{ name: 'f' }] }], generationConfig: { temperature: 0.3 } }, 'gemini-3-flash', cfg);
  const body = JSON.parse(buildRequestBody(tpl, { ...req, snapshot: '!new', timezone: 'Asia/Shanghai' }));
  assert.equal(body[0], 'models/gemini-3-flash');
  assert.deepEqual(body[1], [[[[null, 'yo']], 'user']]);
  assert.equal(body[3][3], 65536);
  assert.equal(body[3][4], 0.3);
  assert.equal(body[3][6], null);
  assert.deepEqual(body[3][16], [1, null, null, 3]);
  assert.equal(body[4], '!new');
  assert.deepEqual(body[6], [[null, [['f']]]]);
  assert.deepEqual(body[13], [[null, null, 'Asia/Shanghai'], null, 1]);
  assert.deepEqual(body[2], [[null, null, 7, 5], [null, null, 8, 5], [null, null, 9, 5], [null, null, 10, 5]]);
});

test('model-specific generation slots from the UI template are not carried over', () => {
  const gen = [null, null, null, 32768, 1, 0.95, 64, null, null, null, null, null, null, 1, null, null, [1, null, null, 2]];
  gen[47] = 1; // captured while gemini-4-argon was selected in the page
  const tpl = JSON.stringify(['models/gemini-4-argon', [], null, gen, '!x', null, [[null, null, null, [null, [[]]]]], null, null, null, 1]);
  const req = fromGemini({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, 'gemini-3.8-flash', cfg);
  const body = JSON.parse(buildRequestBody(tpl, { ...req, snapshot: '!s' }));
  assert.equal(body[3].length <= 27, true);
  assert.equal(body[3][47], undefined);
  assert.equal(body[3][3], 32768);
  assert.equal(body[3][13], 1);
  assert.equal(body[6], null); // UI's google-search toggle is not inherited
});

test('content hash ignores function parts but keeps their slot', () => {
  const a = contentHash([{ role: 'user', parts: [{ text: 'a' }, { functionResponse: { name: 'x', response: {} } }, { text: 'b' }] }]);
  const b = contentHash([{ role: 'user', parts: [{ text: 'a' }, { text: '' }, { text: 'b' }] }]);
  assert.equal(a, b);
});

test('error body parsing', () => {
  assert.deepEqual(parseErrorBody('[,[7,"The caller does not have permission"]]'), { code: 7, message: 'The caller does not have permission' });
});
