/** Round 8, item 11: the folder chip reads the host's answer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const src = f => fileURLToPath(new URL(`../src/${f}`, import.meta.url));
const stub = fileURLToPath(new URL('./helpers/react-stub.mjs', import.meta.url));
globalThis.window ??= globalThis; globalThis.localStorage ??= { getItem: () => null, setItem: () => {} }; globalThis.navigator ??= { language: 'en' };
async function load(file) {
  const r = await build({ entryPoints: [src(file)], bundle: true, format: 'esm', platform: 'node', write: false, alias: { react: stub }, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
}
const F = await load('lib/chat-folder.ts');

test('the folder answer: a path gives a name; nothing gives no folder', () => {
  assert.deepEqual(F.readFolder({ path: 'C:\Users\me\pagoda-site', name: 'pagoda-site', exists: true }), { path: 'C:\Users\me\pagoda-site', name: 'pagoda-site', exists: true });
  assert.equal(F.readFolder({ path: '/home/me/site' }).name, 'site');
  assert.equal(F.readFolder(null), null);
  assert.equal(F.readFolder({ path: '' }), null);
});

