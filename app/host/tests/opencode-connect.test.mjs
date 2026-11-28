// Fork: "Connect OpenCodeFork" (server/opencode-connect.mjs). The same model connected again replaces its entry, never a second one
// (owner, 2026-11-27); the rest of the user's config stays as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectOpenCode, opencodeConfigDir, stripJsonc } from '../server/opencode-connect.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'strata-opencode-'));
const read = dir => JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'));
const base = { baseURL: 'http://127.0.0.1:47831/v1' };

test('the config folder is OpenCodeFork\'s: XDG config home, else ~/.config, then opencodefork', () => {
  assert.equal(opencodeConfigDir({ XDG_CONFIG_HOME: join('X', 'cfg') }), join('X', 'cfg', 'opencodefork'));
  assert.equal(opencodeConfigDir({ USERPROFILE: join('C', 'Users', 'me') }), join('C', 'Users', 'me', '.config', 'opencodefork'));
});

test('a first connect creates the file with the strata provider and the model', () => {
  const dir = scratch();
  try {
    const r = connectOpenCode({ ...base, model: 'qwen36-ud-iq3_s', name: 'Qwen3.6-35B-A3B (qwen36-ud-iq3_s)', context: 131072, dir });
    assert.equal(r.created, true);
    assert.equal(r.replaced, false);
    const cfg = read(dir);
    assert.equal(cfg.provider.strata.npm, '@ai-sdk/openai-compatible');
    assert.equal(cfg.provider.strata.options.baseURL, 'http://127.0.0.1:47831/v1');
    assert.deepEqual(cfg.provider.strata.models['qwen36-ud-iq3_s'], { name: 'Qwen3.6-35B-A3B (qwen36-ud-iq3_s)', tool_call: true, limit: { context: 131072, output: 32768 } });
    assert.equal('apiKey' in cfg.provider.strata.options, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('connecting the same model again replaces its entry; other models, providers and settings stay', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({
      theme: 'dark', model: 'strata/qwen36-ud-iq3_s',
      provider: { strata: { npm: '@ai-sdk/openai-compatible', name: 'My Strata', options: { baseURL: 'http://127.0.0.1:8791/v1', timeout: 600000 },
        models: { 'qwen36-ud-iq3_s': { name: 'old', limit: { context: 8192, output: 4096 }, extra: 1 }, other: { name: 'Other' } } },
        lmstudio: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:1234/v1' } } },
    }));
    const r = connectOpenCode({ ...base, model: 'qwen36-ud-iq3_s', name: 'Qwen3.6', context: 65536, apiKey: 'sk-strata-x', dir });
    assert.equal(r.replaced, true);
    assert.ok(existsSync(join(dir, 'opencode.json.strata-backup')));
    const cfg = read(dir);
    assert.equal(cfg.theme, 'dark');
    assert.equal(cfg.model, 'strata/qwen36-ud-iq3_s');
    assert.deepEqual(Object.keys(cfg.provider.strata.models).sort(), ['other', 'qwen36-ud-iq3_s'], 'one entry per model, no second one');
    assert.deepEqual(cfg.provider.strata.models['qwen36-ud-iq3_s'], { name: 'Qwen3.6', tool_call: true, limit: { context: 65536, output: 32768 } });
    assert.deepEqual(cfg.provider.strata.models.other, { name: 'Other' });
    assert.equal(cfg.provider.strata.name, 'My Strata');
    assert.deepEqual(cfg.provider.strata.options, { baseURL: 'http://127.0.0.1:47831/v1', timeout: 600000, apiKey: 'sk-strata-x' });
    assert.deepEqual(cfg.provider.lmstudio, { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:1234/v1' } });
    connectOpenCode({ ...base, model: 'qwen36-ud-iq3_s', name: 'Qwen3.6', dir });
    assert.equal(Object.keys(read(dir).provider.strata.models).length, 2, 'a third click still keeps one entry');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a native providers.strata entry is updated in its own shape, and a legacy copy of the model is dropped', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({
      providers: { strata: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: 'http://old/v1' }, models: { m1: { name: 'old' } } } },
      provider: { strata: { models: { m1: { name: 'legacy' }, keep: { name: 'Keep' } } } },
    }));
    const r = connectOpenCode({ ...base, model: 'm1', name: 'M1', context: 4096, dir });
    assert.equal(r.shape, 'providers');
    assert.equal(r.replaced, true);
    const cfg = read(dir);
    assert.deepEqual(cfg.providers.strata.models.m1, { name: 'M1', limit: { context: 4096, output: 4096 } });
    assert.equal(cfg.providers.strata.settings.baseURL, 'http://127.0.0.1:47831/v1');
    assert.deepEqual(Object.keys(cfg.provider.strata.models), ['keep']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a file that does not parse is left unchanged', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'opencode.json'), '{ "provider": ');
    assert.throws(() => connectOpenCode({ ...base, model: 'm1', dir }), /not valid JSON/);
    assert.equal(readFileSync(join(dir, 'opencode.json'), 'utf8'), '{ "provider": ');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an opencode.jsonc (comments, trailing commas) is read and written back', () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'opencode.jsonc'), '{\n  // mine\n  "theme": "a // not a comment",\n  /* block */ "x": [1,2,],\n}\n');
    const r = connectOpenCode({ ...base, model: 'm1', dir });
    assert.equal(r.file, join(dir, 'opencode.jsonc'));
    const cfg = JSON.parse(readFileSync(join(dir, 'opencode.jsonc'), 'utf8'));
    assert.equal(cfg.theme, 'a // not a comment');
    assert.deepEqual(cfg.x, [1, 2]);
    assert.ok(cfg.provider.strata.models.m1);
    assert.equal(stripJsonc('{"a":"/*x*/",}'), '{"a":"/*x*/"}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
