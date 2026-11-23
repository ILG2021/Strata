// #5084: the person's own rules for every chat. Settings saves them to <data>/agent/home/AGENTS.md (the path is kept so saved rules
// survive updates); the chat paths add the text to the system prompt. With no rules the prompt is byte-identical to the one before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createUserRules, rulesFile, RULES_MAX_BYTES } from '../server/user-rules.mjs';
import { createMockModelApi } from './mock-model-api.mjs';
import { ROOMY_HOST } from './helpers/hardware.mjs';

function scratch(t) { const dir = mkdtempSync(join(tmpdir(), 'strata-user-rules-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

test('the rules live in AGENTS.md in the data folder, and a save round-trips', t => {
  const data = scratch(t), file = rulesFile(data);
  assert.equal(file, join(data, 'agent', 'home', 'AGENTS.md'));
  const rules = createUserRules({ file });
  const empty = rules.read();
  assert.equal(empty.text, ''); assert.equal(empty.maxBytes, RULES_MAX_BYTES);
  const saved = rules.write('Answer in German.\r\nKeep answers short.', empty.revision);
  assert.equal(readFileSync(file, 'utf8'), 'Answer in German.\nKeep answers short.');
  assert.deepEqual(rules.read(), saved);
  assert.notEqual(saved.revision, empty.revision);
});

test('a save over a file another window changed is refused and changes nothing', t => {
  const data = scratch(t), file = rulesFile(data), rules = createUserRules({ file });
  const first = rules.read();
  rules.write('One', first.revision);                                    // window A saves
  assert.throws(() => rules.write('Two', first.revision), e => e.status === 409 && e.code === 'changed');   // window B still holds the old revision
  assert.equal(readFileSync(file, 'utf8'), 'One');
  writeFileSync(file, 'edited by hand');                                 // a change outside Strata counts too
  assert.throws(() => rules.write('Three', rules.read().revision.replace(/./, c => (c === '0' ? '1' : '0'))), e => e.status === 409);
  assert.equal(rules.read().text, 'edited by hand');
});

test('the 64 KB limit counts UTF-8 bytes, not characters', t => {
  const rules = createUserRules({ file: rulesFile(scratch(t)) });
  const fits = 'x'.repeat(RULES_MAX_BYTES), rev = rules.read().revision;
  const next = rules.write(fits, rev);
  assert.equal(next.bytes, RULES_MAX_BYTES);
  const han = '中'.repeat(21846);                                        // 21,846 characters, 65,538 bytes
  assert.ok(han.length < RULES_MAX_BYTES);
  assert.throws(() => rules.write(han, next.revision), e => e.status === 413 && e.code === 'too-long');
  assert.equal(rules.read().text, fits);
});

test('no rules add nothing to the prompt; rules add one block', t => {
  const data = scratch(t), file = rulesFile(data), rules = createUserRules({ file });
  const compose = () => ['SYSTEM', rules.promptBlock(), 'SKILLS'].filter(Boolean).join('\n\n');
  assert.equal(compose(), 'SYSTEM\n\nSKILLS');                         // no file
  mkdirSync(join(data, 'agent', 'home'), { recursive: true }); writeFileSync(file, ' \n\t\n');
  assert.equal(compose(), 'SYSTEM\n\nSKILLS');                         // only blank lines
  writeFileSync(file, '﻿Answer in German.\n');
  assert.equal(rules.promptBlock(), 'The person you are helping set these rules for every answer:\nAnswer in German.');
});

test('every plain chat path of the host adds the rules block', () => {
  const src = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/userRules\.promptBlock\(\)/g) ?? []).length, 2);   // the native-gateway and local-model paths (the cloud model API path was removed)
  assert.equal((src.match(/\[SYSTEM_PROMPT, *skillInstructions/g) ?? []).length, 0);
});
