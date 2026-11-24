// Settings > General > System prompt: the built-in prompt until the person saves their own, kept in <data>/system-prompt.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSystemPrompt, DEFAULT_SYSTEM_PROMPT, systemPromptFile, SYSTEM_PROMPT_MAX_BYTES } from '../server/system-prompt.mjs';

function scratch(t) { const dir = mkdtempSync(join(tmpdir(), 'strata-system-prompt-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

test('with nothing saved the built-in prompt is shown and used', t => {
  const file = systemPromptFile(scratch(t)), prompt = createSystemPrompt({ file });
  const shown = prompt.read();
  assert.equal(shown.text, DEFAULT_SYSTEM_PROMPT); assert.equal(shown.isDefault, true); assert.equal(shown.defaultText, DEFAULT_SYSTEM_PROMPT);
  assert.equal(prompt.current(), DEFAULT_SYSTEM_PROMPT);
  assert.ok(DEFAULT_SYSTEM_PROMPT.startsWith('You are Strata, a local inference assistant'));
});

test('a saved prompt replaces the built-in one; saving the built-in text again removes the file', t => {
  const file = systemPromptFile(scratch(t)), prompt = createSystemPrompt({ file });
  const own = prompt.write('你是一个中文助手。\r\n回答要简短。', prompt.read().revision);
  assert.equal(own.isDefault, false);
  assert.equal(readFileSync(file, 'utf8'), '你是一个中文助手。\n回答要简短。');
  assert.equal(prompt.current(), '你是一个中文助手。\n回答要简短。');
  const back = prompt.write(DEFAULT_SYSTEM_PROMPT + '\n', own.revision);
  assert.equal(back.isDefault, true); assert.equal(existsSync(file), false);
  assert.equal(prompt.current(), DEFAULT_SYSTEM_PROMPT);
});

test('an empty save is kept: the chat then has no Strata prompt at all', t => {
  const file = systemPromptFile(scratch(t)), prompt = createSystemPrompt({ file });
  prompt.write('  \n', prompt.read().revision);
  assert.equal(prompt.read().isDefault, false);
  assert.equal(prompt.current(), '');
  assert.equal([prompt.current(), 'RULES'].filter(Boolean).join('\n\n'), 'RULES');
});

test('a save over a change from another window is refused; the limit counts UTF-8 bytes', t => {
  const file = systemPromptFile(scratch(t)), prompt = createSystemPrompt({ file });
  const first = prompt.read();
  prompt.write('A', first.revision);
  assert.throws(() => prompt.write('B', first.revision), e => e.status === 409 && e.code === 'changed');
  writeFileSync(file, 'by hand');
  assert.equal(prompt.current(), 'by hand');
  assert.throws(() => prompt.write('中'.repeat(21846), prompt.read().revision), e => e.status === 413 && e.code === 'too-long');
  assert.equal(SYSTEM_PROMPT_MAX_BYTES, 65536);
});

test('both plain chat paths of the host start with the editable prompt', () => {
  const src = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/\[systemPrompt\.current\(\), *userRules\.promptBlock\(\)/g) ?? []).length, 2);
  assert.equal(/\bSYSTEM_PROMPT\b/.test(src), false);
});
