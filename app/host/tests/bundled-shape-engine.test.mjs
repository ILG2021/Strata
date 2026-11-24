/** Engines of model shapes inside the installer (engine-bundle/shapes/<shape>/<package>): Inkling-2-Mini's strata-inkling and the like. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBundledEngine, removeVerifiedBundle, shapeComponentId } from '../server/bundled-engine.mjs';

const sha = buffer => createHash('sha256').update(buffer).digest('hex');
function makePackage(root, version, { id = 'strata-engine', shape = null, exe = 'strata.exe', backend = 'cuda', body = `${id}-${version}` } = {}) {
  const name = `${version}-windows-x86_64-${backend}`;
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const files = { [exe]: Buffer.from(body), 'cudart64_13.dll': Buffer.from('rt-' + body) };
  for (const [file, data] of Object.entries(files)) writeFileSync(join(dir, file), data);
  writeFileSync(join(dir, 'engine-component.json'), JSON.stringify({
    schema_version: 2, id, name: id, version, platform: 'windows-x86_64', backend, archs: ['sm_86'], build_id: 'b-' + version, entrypoint: exe,
    files: Object.entries(files).map(([path, data]) => ({ path, sha256: sha(data), bytes: data.length })), signature: null, ...(shape ? { shape } : {}) }));
  return name;
}
const inkling = (bundle, version, extra = {}) => makePackage(join(bundle, 'shapes', 'inkling2'), version, { id: 'strata-inkling', shape: 'inkling2', exe: 'strata-inkling.exe', ...extra });
function setup(t) {
  const base = mkdtempSync(join(tmpdir(), 'st-bundled-shape-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bundle = join(base, 'engine-bundle'), components = join(base, 'components');
  mkdirSync(bundle); mkdirSync(components);
  return { bundle, components, engine: join(components, 'engine'), inklingRoot: join(components, 'shapes', 'inkling2', 'engine') };
}

test('component ids follow strata_control/shape_engine.component_id', () => {
  assert.equal(shapeComponentId('inkling2'), 'strata-inkling');
  assert.equal(shapeComponentId('hy4'), 'strata-hy4');
  assert.equal(shapeComponentId('q4_lite'), 'strata-q4-lite');
});

test('the bundled Inkling engine goes to <components>/shapes/inkling2/engine beside the Strata engine', async t => {
  const s = setup(t);
  const main = makePackage(s.bundle, '1.0.1');
  const ink = inkling(s.bundle, '0.1.65');
  const result = await installBundledEngine({ bundleDir: s.bundle, components: s.components, backend: 'cuda', driver: null });
  assert.equal(result.action, 'installed');
  assert.deepEqual(result.shapes.map(r => [r.shape, r.action, r.version]), [['inkling2', 'installed', '0.1.65']]);
  assert.deepEqual(readdirSync(s.engine), [main], 'the shape package is never put in the Strata engine folder');
  assert.deepEqual(readdirSync(s.inklingRoot), [ink], 'no temporary folder remains');
  assert.equal(readFileSync(join(s.inklingRoot, ink, 'strata-inkling.exe'), 'utf8'), 'strata-inkling-0.1.65');
  const again = await installBundledEngine({ bundleDir: s.bundle, components: s.components, backend: 'cuda', driver: null });
  assert.deepEqual(again.shapes.map(r => r.action), ['kept']);
});

test('a newer installed Inkling engine is kept; a damaged copy of the same package is repaired', async t => {
  const s = setup(t);
  makePackage(s.bundle, '1.0.1');
  const ink = inkling(s.bundle, '0.1.65');
  await installBundledEngine({ bundleDir: s.bundle, components: s.components, backend: 'cuda', driver: null });
  writeFileSync(join(s.inklingRoot, ink, 'strata-inkling.exe'), 'broken!');
  const repaired = await installBundledEngine({ bundleDir: s.bundle, components: s.components, backend: 'cuda', driver: null });
  assert.equal(repaired.shapes[0].action, 'repaired');
  assert.equal(readFileSync(join(s.inklingRoot, ink, 'strata-inkling.exe'), 'utf8'), 'strata-inkling-0.1.65');
  makePackage(s.inklingRoot, '0.1.70', { id: 'strata-inkling', shape: 'inkling2', exe: 'strata-inkling.exe' });
  const kept = await installBundledEngine({ bundleDir: s.bundle, components: s.components, backend: 'cuda', driver: null });
  assert.deepEqual([kept.shapes[0].action, kept.shapes[0].version], ['kept', '0.1.70']);
});

test('a bundled shape package that does not match its manifest is refused; a build for another make is left alone', async t => {
  const s = setup(t);
  makePackage(s.bundle, '1.0.1');
  const ink = inkling(s.bundle, '0.1.65');
  writeFileSync(join(s.bundle, 'shapes', 'inkling2', ink, 'strata-inkling.exe'), 'tampered');
  const refused = await installBundledEngine({ bundleDir: s.bundle, components: s.components, backend: 'cuda', driver: null });
  assert.equal(refused.shapes[0].action, 'refused');
  assert.equal(existsSync(s.inklingRoot) ? readdirSync(s.inklingRoot).length : 0, 0);
  const t2 = setup(t);
  makePackage(t2.bundle, '1.0.1', { backend: 'hip' });
  inkling(t2.bundle, '0.1.65');
  const result = await installBundledEngine({ bundleDir: t2.bundle, components: t2.components, backend: 'cuda', driver: null });
  assert.equal(result.action, 'wrong-make');
  assert.equal(existsSync(t2.inklingRoot), false);
});

test('the leftover bundle is removed only when the shape engines are complete in the store too', async t => {
  const s = setup(t);
  makePackage(s.bundle, '1.0.1');
  const ink = inkling(s.bundle, '0.1.65');
  await installBundledEngine({ bundleDir: s.bundle, components: s.components, backend: 'cuda', driver: null });
  rmSync(join(s.inklingRoot, ink), { recursive: true, force: true });
  const kept = await removeVerifiedBundle({ bundleDir: s.bundle, components: s.components });
  assert.equal(kept.removed, false);
  assert.match(kept.reason, /inkling2 engine/);
  await installBundledEngine({ bundleDir: s.bundle, components: s.components, backend: 'cuda', driver: null });
  const removed = await removeVerifiedBundle({ bundleDir: s.bundle, components: s.components });
  assert.equal(removed.removed, true);
  assert.deepEqual(readdirSync(s.bundle), []);
});
