/** "Answer speed" is one number everywhere: every token the model produced over its decode time, never over a time that holds the prompt being read. */
import { fileURLToPath } from 'node:url';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import * as monitor from '../server/monitor.mjs';
import * as serving from '../server/serving.mjs';

async function moduleAt(path) { const result = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' }); return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`); }
const { chatMetrics } = await moduleAt('../src/lib/chat-metrics.ts');

test('the monitor and the request list average answer speeds, not tokens over the whole request', () => {
  monitor.record({ tokensIn: 308, tokensOut: 73, durationMs: 2320, tps: 65.9 });
  monitor.record({ tokensIn: 62, tokensOut: 34, durationMs: 1652, tps: 47.8 });
  assert.equal(monitor.snapshot().totals.avgTps, 56.9);
  monitor.record({ tokensIn: 1, tokensOut: 5, durationMs: 100 });      // no decode figure: left out, not divided by the wall time
  assert.equal(monitor.snapshot().totals.avgTps, 56.9);
  const a = serving.open({ client: 't', endpoint: '/x', model: 'm' });
  serving.mark(a.id, { tps: 65.9 });
  serving.finish(a.id, { tokensOut: 73, durationMs: 2320 });
  assert.equal(serving.rateSample(), 65.9);
});

const reply = (o) => ({ role: 'assistant', at: new Date().toISOString(), content: 'x', ...o });
const chat = (messages) => ({ id: 's', messages, tokensIn: 0, tokensOut: 0, statsAvailable: true });

test('the footer shows the last reply own speed, and the prompt reading speed next to it', () => {
  const s = chat([reply({ tps: 61, inputTokens: 10, tokens: 5 }), reply({ tps: 66, promptTps: 254, inputTokens: 20, tokens: 7 })]);
  const m = chatMetrics(s, null, 32768);
  assert.equal(m.speed, 66);
  assert.equal(m.promptSpeed, 254);
  // an older reply's number is never shown under "last reply"
  const m2 = chatMetrics(chat([reply({ tps: 61, inputTokens: 10, tokens: 5 }), reply({ inputTokens: 20, tokens: 7 })]), null, 32768);
  assert.equal(m2.speed, null);
});

test('while it thinks the footer reads the engine like the monitor does', () => {
  const s = chat([reply({ streaming: true, tps: 12 })]);
  const monitorState = { phase: 'thinking', outputTps: 64.2, context: { sessionId: 's', usedTokens: 100, maxTokens: 32768 } };
  assert.equal(chatMetrics(s, monitorState, 32768).speed, 64.2);
  assert.equal(chatMetrics(s, { ...monitorState, outputTps: 0 }, 32768).speed, 12);   // no reading yet: the stream's own estimate
});
