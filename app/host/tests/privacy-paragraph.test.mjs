import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'src/components/PrivacyNotes.tsx'), 'utf8');
const SENTENCES = ["Strata sends no usage telemetry.", "Conversations stay on this computer, in Strata's data folder.", "Downloads and update checks use GitHub and Hugging Face only.", "If you share Strata or open a Cloudflare tunnel, requests and answers pass over that network.", "The UI request log keeps client, timing and token metadata in memory.", "The native engine keeps the content of the last 100 requests in memory until the model is unloaded."];

test('Privacy is one compact paragraph with all six sentences, in order', () => {
  const text = source.match(/const NOTES = "([^"]*)";/)?.[1];
  assert.equal(text, SENTENCES.join(' '));
  assert.equal((source.match(/<p>/g) ?? []).length, 1, 'one paragraph, not a line per sentence');
});

test('the paragraph is translated as a whole in all 9 languages', () => {
  const joined = SENTENCES.join(' ');
  const en = JSON.parse(readFileSync(resolve(root, 'src/locales/en.json'), 'utf8'));
  const id = Object.keys(en).find(k => en[k] === joined);
  assert.ok(id, 'the English catalog has the whole paragraph');
  for (const lang of ['zh', 'ja', 'de', 'es', 'ru', 'pt', 'ko', 'fr', 'he']) {
    const cat = JSON.parse(readFileSync(resolve(root, `src/locales/${lang}.json`), 'utf8'));
    assert.ok(cat[id] && cat[id] !== joined && cat[id].length > 80, `${lang} has its own translation of the paragraph`);
  }
});
