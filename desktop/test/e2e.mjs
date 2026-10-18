// Live end-to-end checks against a running proxy: node test/e2e.mjs [baseUrl] [model]
const BASE = process.argv[2] || 'http://127.0.0.1:8765';
const MODEL = process.argv[3] || 'gemini-3.8-flash';
const H = { 'Content-Type': 'application/json' };

const tools = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string', description: 'city name' }, unit: { type: 'string', enum: ['c', 'f'] } }, required: ['city'], additionalProperties: false },
  },
}];

async function post(path, body) {
  const t0 = Date.now();
  const r = await fetch(BASE + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, ms: Date.now() - t0, text };
}

async function streamOpenAI(body) {
  const t0 = Date.now();
  const r = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }) });
  const dec = new TextDecoder();
  let buf = '', content = '', reasoning = '', first = 0, finish = null, usage = null;
  const calls = [];
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).replace(/^data: /, '');
      buf = buf.slice(i + 2);
      if (line === '[DONE]') continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(JSON.stringify(j.error));
      if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta || {};
      if ((d.content || d.reasoning_content || d.tool_calls) && !first) first = Date.now() - t0;
      content += d.content || '';
      reasoning += d.reasoning_content || '';
      if (d.tool_calls) calls.push(...d.tool_calls);
      if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
    }
  }
  return { status: r.status, first, ms: Date.now() - t0, content, reasoningLen: reasoning.length, calls, finish, usage };
}

const results = [];
const check = (name, ok, info) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`); };

// 1. models
{
  const r = await fetch(BASE + '/v1/models').then((x) => x.json());
  check('GET /v1/models', Array.isArray(r.data) && r.data.length > 0, `${r.data?.length} models, e.g. ${r.data?.slice(0, 4).map((m) => m.id).join(', ')}`);
}

// 2. OpenAI non-stream text
{
  const r = await post('/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'Reply with exactly: pong' }], reasoning_effort: 'low' });
  const j = JSON.parse(r.text);
  check('OpenAI 非流式文本', r.status === 200 && /pong/i.test(j.choices?.[0]?.message?.content || ''), `${r.ms}ms → ${JSON.stringify(j.choices?.[0]?.message?.content || j.error)}`);
}

// 3. OpenAI streaming text
{
  const r = await streamOpenAI({ model: MODEL, messages: [{ role: 'system', content: 'You are terse.' }, { role: 'user', content: 'Count 1 to 10 separated by spaces.' }] });
  check('OpenAI 流式文本', r.status === 200 && /1.*10/s.test(r.content), `首字 ${r.first}ms 总 ${r.ms}ms 思考 ${r.reasoningLen} 字 → ${JSON.stringify(r.content.slice(0, 60))} usage=${JSON.stringify(r.usage)}`);
}

// 4. OpenAI tool call round 1 (stream) + round 2 without signatures (client drops them)
{
  const messages = [{ role: 'user', content: 'What is the weather in Shanghai and Beijing? Call the tool for each city.' }];
  const r1 = await streamOpenAI({ model: MODEL, messages, tools, tool_choice: 'auto' });
  check('OpenAI 工具调用 第1轮', r1.finish === 'tool_calls' && r1.calls.length >= 1, `${r1.ms}ms calls=${JSON.stringify(r1.calls.map((c) => [c.id, c.function.name, c.function.arguments]))}`);
  if (r1.calls.length) {
    messages.push({ role: 'assistant', content: null, tool_calls: r1.calls.map((c) => ({ id: c.id, type: 'function', function: c.function })) });
    for (const c of r1.calls) {
      const city = JSON.parse(c.function.arguments).city;
      messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ city, temperature: city.includes('Shang') ? 24 : 18, condition: 'rainy' }) });
    }
    const r2 = await post('/v1/chat/completions', { model: MODEL, messages, tools });
    const j = JSON.parse(r2.text);
    const txt = j.choices?.[0]?.message?.content || '';
    check('OpenAI 工具调用 第2轮(回传结果)', r2.status === 200 && /24/.test(txt), `${r2.ms}ms → ${JSON.stringify(txt.slice(0, 120) || j.error)}`);
  }
}

// 5. tool_choice forcing a specific function on a prompt that would not need it
{
  const r = await post('/v1/chat/completions', { model: MODEL, messages: [{ role: 'user', content: 'Hi there!' }], tools, tool_choice: { type: 'function', function: { name: 'get_weather' } } });
  const j = JSON.parse(r.text);
  check('OpenAI tool_choice 指定函数', j.choices?.[0]?.finish_reason === 'tool_calls', `${r.ms}ms → ${JSON.stringify(j.choices?.[0]?.message?.tool_calls?.[0]?.function || j.choices?.[0]?.message?.content || j.error)}`);
}

// 6. Gemini native SSE with function calling + response round trip carrying thoughtSignature
{
  const decl = { name: 'get_weather', description: 'Get current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } };
  const contents = [{ role: 'user', parts: [{ text: 'Weather in Tokyo? use the tool' }] }];
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`, { method: 'POST', headers: H, body: JSON.stringify({ contents, tools: [{ functionDeclarations: [decl] }] }) });
  const text = await r.text();
  const parts = text.split('\n\n').filter((l) => l.startsWith('data: ')).flatMap((l) => JSON.parse(l.slice(6)).candidates?.[0]?.content?.parts || []);
  const fcPart = parts.find((p) => p.functionCall);
  check('Gemini SSE 函数调用', !!fcPart, `${Date.now() - t0}ms → ${JSON.stringify(fcPart?.functionCall)} sig=${fcPart?.thoughtSignature ? 'yes' : 'no'}`);
  if (fcPart) {
    contents.push({ role: 'model', parts: [fcPart] });
    contents.push({ role: 'user', parts: [{ functionResponse: { name: 'get_weather', id: fcPart.functionCall.id, response: { temperature: 31, condition: 'sunny' } } }] });
    const r2 = await post(`/v1beta/models/${MODEL}:generateContent`, { contents, tools: [{ functionDeclarations: [decl] }] });
    const j = JSON.parse(r2.text);
    const txt = (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    check('Gemini 函数结果回传', /31/.test(txt), `${r2.ms}ms → ${JSON.stringify(txt.slice(0, 100) || j.error)}`);
  }
}

// 7. structured output
{
  const r = await post('/v1/chat/completions', {
    model: MODEL, messages: [{ role: 'user', content: 'Give me a fruit and its color.' }],
    response_format: { type: 'json_schema', json_schema: { name: 'f', schema: { type: 'object', properties: { fruit: { type: 'string' }, color: { type: 'string' } }, required: ['fruit', 'color'] } } },
  });
  let parsed = null;
  try { parsed = JSON.parse(JSON.parse(r.text).choices[0].message.content); } catch { /* ignore */ }
  check('JSON Schema 结构化输出', parsed && parsed.fruit && parsed.color, `${r.ms}ms → ${JSON.stringify(parsed) || r.text.slice(0, 200)}`);
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} 通过`);
