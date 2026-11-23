/**
 * #5008: two chats, one workspace, a tool that writes a unique marker.
 * A folder shared by two chats is shared on purpose; what a chat shows as its own (messages, tool cards, "files this turn made") is private.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatStore } from '../server/chat-store.mjs';
import { installFakeHostFetch } from './helpers/fake-host-chats.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

/* ---------------------------------------------------------------- host side: files a turn made */

/** A "tool" of a chat: writes a file with a unique marker, then asks the chat's tracker about it (what the bridge does on a write/edit card). */
function tool(dir, tracker, name, marker) {
  writeFileSync(join(dir, name), `marker:${marker}\n`);
  return tracker.check(name, { explicit: true });
}

/* ---------------------------------------------------------------- app side: messages and tool cards of two live chats */

async function bundle(entry, plugins = []) {
  const result = await build({
    entryPoints: [here(entry)], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
    alias: { react: here('./helpers/react-stub.mjs') }, loader: { '.json': 'json' }, plugins,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

test('two live chats in one workspace keep their messages, tool cards and saved copies apart, interleaved, and after a restart', async () => {
  const hostDir = mkdtempSync(join(tmpdir(), 'strata-5008-host-'));
  const chatStore = createChatStore({ dir: hostDir });
  const fakeHost = installFakeHostFetch(chatStore);
  try {
  globalThis.window ??= globalThis;
  globalThis.document ??= { addEventListener() {}, hasFocus: () => true, visibilityState: 'visible', documentElement: { dataset: {}, style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } } };
  const memory = new Map();
  globalThis.localStorage = {
    get length() { return memory.size; },
    key: (i) => [...memory.keys()][i] ?? null,
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => { memory.set(k, v); },
    removeItem: (k) => memory.delete(k),
  };
  globalThis.navigator ??= { language: 'en' };
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  globalThis.__streams = [];
  const mockClient = {
    name: 'mock-client',
    setup(b) {
      b.onResolve({ filter: /\/client$/ }, () => ({ path: 'mock-client', namespace: 'mock' }));
      b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
        loader: 'js',
        contents: `
          export class ApiError extends Error {}
          const reject = async () => { throw new Error('offline'); };
          export const api = { get: reject, post: async () => ({}), put: reject, patch: reject, del: reject, delete: reject };
          export function onEvent() { return () => {}; }
          export async function streamPost(path, body, onFrame) {
            await new Promise((release) => globalThis.__streams.push({ body, onFrame, release }));
          }`,
      }));
    },
  };
  const store = await bundle('../src/lib/store.ts', [mockClient]);
  await store.loadChatsFromHost();   // the first read of the host's chats (the page's own start-up does this inside bootstrap)
  const wait = async (n) => { for (let i = 0; i < 200 && globalThis.__streams.length < n; i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(globalThis.__streams.length >= n, `stream ${n} started`); };

  const a = store.newSession();
  const turnA = store.sendMessage('question for chat A MARK-A');
  await wait(1);
  const b = store.newSession();
  const turnB = store.sendMessage('question for chat B MARK-B');
  await wait(2);
  const [sa, sb] = globalThis.__streams;
  assert.equal(sa.body.sessionId, a.id);
  assert.equal(sb.body.sessionId, b.id);
  assert.notEqual(sa.body.sessionId, sb.body.sessionId);
  assert.ok(!JSON.stringify(sb.body.history).includes('MARK-A'), 'chat B\'s request carries none of chat A\'s history');

  const tool = (id, marker) => ({ type: 'agent-tool', tool: { id, name: 'write', state: 'done', args: { file_path: `${marker}.txt` }, result: `wrote marker ${marker}` } });
  // interleave: A, B, A, B
  sa.onFrame({ type: 'start', model: 'm', contextMax: 8192, requestId: 'rA', agent: true });
  sb.onFrame({ type: 'start', model: 'm', contextMax: 8192, requestId: 'rB', agent: true });
  sa.onFrame(tool('call-1', 'A-unique-1'));
  sb.onFrame(tool('call-1', 'B-unique-1'));   // the same call id in both chats: ids are only unique inside a chat
  sa.onFrame({ type: 'delta', text: 'answer A ' });
  sb.onFrame({ type: 'delta', text: 'answer B ' });
  sa.onFrame({ type: 'delta', text: 'ends A' });
  sb.onFrame({ type: 'delta', text: 'ends B' });
  sa.onFrame({ type: 'done', tokensIn: 5, tokensOut: 5, durationMs: 10, usageSource: 'reported' });
  sb.onFrame({ type: 'done', tokensIn: 5, tokensOut: 5, durationMs: 10, usageSource: 'reported' });
  sa.release(); sb.release();
  await Promise.all([turnA, turnB]);
  await store.flushSessions();

  const saved = [];
  for (const e of chatStore.list().chats) saved.push(JSON.parse(await chatStore.read(e.id)).session);
  assert.equal(saved.length, 2, JSON.stringify(fakeHost.calls.map((c) => `${c.method} ${c.path}`)));
  const bodyOf = (id) => JSON.stringify(saved.find((s) => s.id === id));
  assert.ok(bodyOf(a.id).includes('MARK-A') && bodyOf(a.id).includes('ends A'));
  assert.ok(!/MARK-B|B-unique|ends B/.test(bodyOf(a.id)), 'chat A holds nothing of chat B');
  assert.ok(bodyOf(b.id).includes('MARK-B') && bodyOf(b.id).includes('ends B'));
  assert.ok(!/MARK-A|A-unique|ends A/.test(bodyOf(b.id)), 'chat B holds nothing of chat A');

  // A second window saves a chat of its own, and then one of this window's chats; this window takes the first over and keeps its own.
  const other = { id: 's_from_other_window', title: 'from window 2', createdAt: '2026-12-01T00:00:00.000Z', updatedAt: '2026-12-01T00:00:01.000Z', messages: [{ id: 'o1', role: 'user', content: 'MARK-OTHER-WINDOW' }] };
  const saved2 = await chatStore.save(other.id, JSON.stringify(other));
  await store.applyChatChange(other.id, saved2.rev, false);
  assert.ok(store.useStore((s) => s.sessions).some((s) => s.id === other.id && s.messages[0].content === 'MARK-OTHER-WINDOW'), 'the chat saved by the other window appears here');
  // while a turn is running in chat A here, the other window's save of chat A does not replace it
  store.selectSession(a.id);
  const liveSend = store.sendMessage('second question MARK-A2');
  await wait(3);
  const [, , sa2] = globalThis.__streams;
  await chatStore.save(a.id, JSON.stringify({ ...JSON.parse(JSON.stringify(store.useStore((s) => s.sessions).find((s) => s.id === a.id))), title: 'renamed in window 2' }));
  await store.applyChatChange(a.id, 99, false);
  assert.notEqual(store.useStore((s) => s.sessions).find((s) => s.id === a.id).title, 'renamed in window 2', 'a chat with a turn running here is not replaced');
  sa2.onFrame({ type: 'done', tokensIn: 1, tokensOut: 1, durationMs: 1, usageSource: 'reported' });
  sa2.release(); await liveSend;
  // the other window deletes its chat
  await chatStore.remove(other.id);
  await store.applyChatChange(other.id, null, true);
  assert.ok(!store.useStore((s) => s.sessions).some((s) => s.id === other.id), 'a chat the other window deleted goes here too');
  } finally { fakeHost.restore(); rmSync(hostDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }   // a save that lands while the folder is removed (ENOTEMPTY, seen on a macOS runner): try again
});
