/** Items 1 and 2: the live status line and the reasoning row, as the pure logic the page uses. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

async function load(file) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(`../src/lib/${file}`, import.meta.url))], bundle: true, format: 'esm', platform: 'node', write: false, alias: { react: fileURLToPath(new URL('./helpers/react-stub.mjs', import.meta.url)) }, logLevel: 'silent', loader: { '.json': 'json' } });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
globalThis.window ??= globalThis; globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.navigator ??= { language: 'en' };

const status = await load('live-status.ts');
const reasoning = await load('reasoning.ts');

test('item 1: only the newest status frame is kept, and idle, a missing phase or done clears it', () => {
  const chat = 'c1';
  assert.equal(status.applyStatusFrame(chat, { seq: 1, phase: 'thinking', code: 'thinking', text: 'Thinking…', tokens: 40, elapsedMs: 100 }, 1000), true);
  assert.equal(status.statusOf(chat).tokens, 40);
  assert.equal(status.applyStatusFrame(chat, { seq: 0, phase: 'tool', code: 'tool', text: 'old' }), false, 'an older frame never replaces a newer one');
  assert.equal(status.statusOf(chat).phase, 'thinking');
  status.applyStatusFrame(chat, { seq: 2, phase: 'preparing', code: 'preparing-tool', text: 'Writing pagoda.html…', args: { verb: 'Writing a file', target: 'pagoda.html' } });
  assert.equal(status.statusOf(chat).phase, 'preparing');
  status.applyStatusFrame(chat, { seq: 3, phase: 'idle', code: 'idle', text: '' });
  assert.equal(status.statusOf(chat), null, 'idle removes the line');
  status.applyStatusFrame(chat, { seq: 4, phase: 'thinking', code: 'thinking', text: 'Thinking…' });
  status.clearStatus(chat);
  assert.equal(status.statusOf(chat), null, 'done and error clear it too');
});

test('item 1 (0.2.16, owner): the line says what the model does now - no playful words rotate; a running tool always shows the real action', () => {
  const frame = (phase, code, args) => ({ seq: 1, phase, code, text: `${phase}…`, args, elapsedMs: 0, receivedAt: 0 });
  for (const r of [0, 1, 5, 13]) assert.equal(status.statusWords(frame('thinking', 'thinking'), r), 'Thinking…', 'the same words at every turn of the old rotation');
  assert.equal(status.statusWords(frame('waiting', 'model-working'), 2), 'Waiting for the model…');
  assert.equal(status.statusWords(frame('waiting', 'reading-prompt'), 5), 'Reading your message…', 'what is really happening is said plainly');
  assert.equal(status.statusWords(frame('preparing', 'preparing-tool', { tool: 'write', verb: 'Writing a file', target: 'pagoda.html' }), 5), 'Writing file pagoda.html…');
  assert.equal(status.statusWords(frame('preparing', 'preparing-tool', { verb: 'Writing a file', target: 'pagoda.html' }), 5), 'Writing a file · pagoda.html…', 'a frame without the tool name keeps its verb');
  assert.equal(status.statusWords(frame('tool', 'tool', { verb: 'Searching the web' }), 9), 'Searching the web…');
  assert.equal(status.isPlayful(frame('thinking', 'thinking')), false);
  assert.equal(status.isPlayful(frame('tool', 'tool')), false);
  assert.equal(status.elapsedText(0, 14_000), '14s'); assert.equal(status.elapsedText(0, 64_000), '1m 04s');
});

test('item 2: the reasoning row shows what it is thinking about, then how long it took; it sticks to the bottom only while the person has not scrolled up', () => {
  assert.equal(reasoning.lastReasoningLine('First idea.\n\n**Second** idea about `colours`\n'), 'Second idea about colours');
  assert.equal(reasoning.lastReasoningLine(''), '');
  assert.ok(reasoning.lastReasoningLine('x'.repeat(300)).length <= 110);
  assert.equal(reasoning.thoughtDuration(38_400), '38s'); assert.equal(reasoning.thoughtDuration(64_000), '1m 04s');
  assert.equal(reasoning.thoughtDuration(400), null); assert.equal(reasoning.thoughtDuration(undefined), null);
  assert.equal(reasoning.atBottom({ scrollHeight: 500, scrollTop: 340, clientHeight: 160 }), true);
  assert.equal(reasoning.atBottom({ scrollHeight: 500, scrollTop: 100, clientHeight: 160 }), false, 'scrolled up: stop following');
});

