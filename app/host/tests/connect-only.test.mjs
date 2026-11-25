// The first-run engine card: it comes back while the engine is missing, and its muted line is translated. (The "Only connect to Strata on another
// computer" link of #5529 led to the custom model API settings, which this fork removed; the link is gone too.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = new URL('../', import.meta.url);
const src = path => readFileSync(fileURLToPath(new URL(path, here)), 'utf8');

test('the engine card comes back while setup is dismissed but not complete, and the Models page leads to it', () => {
  const setup = src('src/screens/Setup.tsx');
  assert.match(setup, /if \(!engineStepDone && !setup\?\.complete && \(needsEngine \|\| cardShown\)\)\s*\n\s*return <EngineFirstRun/);
  assert.doesNotMatch(setup.slice(setup.indexOf('if (!engineStepDone')), /dismissed/, 'the card does not look at "dismissed"');
  const warning = src('src/components/EngineWarning.tsx');
  assert.match(warning, /onSetup \? <p><Btn size="sm" onClick=\{onSetup\}>\{tr\("Run guided setup"\)\}<\/Btn><\/p> : null/);
  assert.match(src('src/components/NativeModels.tsx'), /<EngineWarning native=\{native\}(?: family=\{selectedFamily\?\.family\})? onSetup=\{\(\) => go\('setup'\)\}\/>/);
  // the first-run card reads Control's local answer, so the card shows again after a restart while no engine is installed
  assert.match(src('src/components/EngineFirstRun.tsx'), /return !!s\.engine && s\.engine\.usable === false;/);
});

test('the muted line is in the guic catalog in all ten languages', () => {
  const dir = new URL('src/locales/', here);
  const langs = readdirSync(fileURLToPath(dir)).filter(f => /^guic-[a-z]{2}\.json$/.test(f));
  assert.equal(langs.length, 10);
  const en = JSON.parse(readFileSync(fileURLToPath(new URL('guic-en.json', dir)), 'utf8'));
  const values = Object.values(en);
  for (const text of ['Nothing is downloaded. You can add the engine later from the Models page.']) {
    const key = Object.keys(en).find(k => en[k] === text);
    assert.ok(key, text);
    for (const f of langs) assert.ok(JSON.parse(readFileSync(fileURLToPath(new URL(f, dir)), 'utf8'))[key], `${f} has ${key}`);
  }
  assert.ok(values.length >= 24);
});
