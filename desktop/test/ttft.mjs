// Measures time-to-first-token breakdown per thinking level: node test/ttft.mjs [model] [prompt]
const BASE = 'http://127.0.0.1:8765';
const MODEL = process.argv[2] || 'gemini-4-argon';
const PROMPT = process.argv[3] || '用一句话介绍一下你自己。';

async function run(effort) {
  const t0 = Date.now();
  const body = { model: MODEL, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: PROMPT }] };
  if (effort) body.reasoning_effort = effort;
  const r = await fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let firstByte = 0, firstThought = 0, firstText = 0, usage = null, thoughtChars = 0, textChars = 0, buf = '';
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    if (!firstByte) firstByte = Date.now() - t0;
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i).replace(/^data: /, '');
      buf = buf.slice(i + 2);
      if (line === '[DONE]') continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(j.error.message);
      if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta || {};
      if (d.reasoning_content) { thoughtChars += d.reasoning_content.length; if (!firstThought) firstThought = Date.now() - t0; }
      if (d.content) { textChars += d.content.length; if (!firstText) firstText = Date.now() - t0; }
    }
  }
  const total = Date.now() - t0;
  return { effort: effort || '默认', firstThought, firstText, total, reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens, outTokens: usage?.completion_tokens, thoughtChars, textChars };
}

for (const e of process.argv.slice(4).length ? process.argv.slice(4) : ['minimal', 'low', 'medium', 'high']) {
  try {
    const r = await run(e === 'default' ? null : e);
    console.log(`${r.effort.padEnd(8)} 首个思考 ${String(r.firstThought || '-').padStart(6)}ms  首个正文 ${String(r.firstText).padStart(6)}ms  总计 ${String(r.total).padStart(6)}ms  思考token ${r.reasoningTokens}  输出token ${r.outTokens}  思考字数 ${r.thoughtChars}`);
  } catch (err) {
    console.log(`${e.padEnd(8)} 失败: ${err.message}`);
  }
}
