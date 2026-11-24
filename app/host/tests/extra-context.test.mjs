import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const built = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/default-context.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.json': 'json' }, logLevel: 'silent' });
const { defaultContext, withExtraContext } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

test('the Models page offers 16K between 8K and 32K, and still opens at 128K', () => {
  const list = withExtraContext([8192, 32768, 65536, 131072]);
  assert.deepEqual(list, [8192, 16384, 32768, 65536, 131072]);
  assert.deepEqual(withExtraContext(list), list, 'never twice');
  assert.deepEqual(withExtraContext([131072]), [131072], 'a model with one size keeps it');
  assert.equal(defaultContext(list), 131072);
});
