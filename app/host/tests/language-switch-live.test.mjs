// Visual walkthrough (GUI-VIS-1117, finding 2): after a live language switch, parts of the chat kept the words of the language before (German with Japanese,
// Hebrew with Korean) until a reload, and the code label was English in every language.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const LANGS = ['zh', 'ja', 'de', 'es', 'ru', 'pt', 'ko', 'fr', 'he'];
const built = await build({ stdin: { contents: "export * from './src/lib/i18n';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.json': 'json' } });
const { tr, setTranslationLanguage, loadCatalog } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
for (const l of LANGS) await loadCatalog(l);

const walk = dir => readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : [p]; });

test('every memoised component that draws translated words subscribes to the language', () => {
  const missing = [];
  for (const file of walk('src').filter(f => /\.tsx$/.test(f))) {
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    if (!/\bmemo\(/.test(text) || !/\btr\(/.test(text)) continue;
    // each memo() component body (or the one the memo wraps) must read the language from the store, else a live switch changes no prop and nothing redraws
    const bodies = [...text.matchAll(/memo\((?:function\s+\w+|\w+)/g)].length;
    const reads = [...text.matchAll(/useStore\(\s*\(?s\)?\s*=>\s*s\.language\s*\)/g)].length;
    if (reads < bodies) missing.push(`${file}: ${bodies} memo(), ${reads} language reads`);
  }
  assert.deepEqual(missing, []);
});

test('the code label has a word of its own in every language', async () => {
  for (const l of LANGS) {
    await setTranslationLanguage(l);
    assert.ok(tr('code').length > 0);
    if (l === 'he' || l === 'ja' || l === 'ko' || l === 'zh' || l === 'ru') assert.notEqual(tr('code'), 'code', l);
  }
});
