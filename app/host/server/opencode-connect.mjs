/**
 * Fork: "Connect OpenCodeFork" on a model's settings (NativeSettings.tsx).  Puts the model into OpenCodeFork's global config as a model of
 * the `strata` provider (OpenAI-compatible, this host's /v1), so the coding app lists it without hand-editing JSON.
 *
 * OpenCodeFork (github.com/ILG2021/opencode) reads <XDG config home or ~/.config>/opencodefork/opencode.json (or opencode.jsonc). Two
 * provider shapes are understood there: the native `providers.<id>` (package / settings.baseURL) and the legacy `provider.<id>` (npm /
 * options.baseURL, migrated on load, @ai-sdk/openai-compatible mapping to its built-in OpenAI-compatible client). An existing `strata`
 * entry is updated in the shape it already has; a new one is written in the legacy shape, whose model fields (limit, tool_call) are the
 * well-known ones.
 *
 * The same model connected again REPLACES its entry (owner, 2026-11-27): one entry per model id, never a second one. Everything else in
 * the file is left as it is; the file before the change is kept beside it as <name>.strata-backup. A file that does not parse is not
 * touched (the error says so), and a .jsonc file is written back as plain JSON (its comments are kept in the backup).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const OPENCODE_PROVIDER_ID = 'strata';
const LEGACY_PACKAGE = '@ai-sdk/openai-compatible';
const NATIVE_PACKAGE = '@opencode/ai/providers/openai-compatible';
const OUTPUT_CAP = 32768;

/** OpenCodeFork's global config folder (its Global.Path.config: xdg-basedir's config home + "opencodefork"). */
export function opencodeConfigDir(env = process.env) {
  const base = String(env.XDG_CONFIG_HOME ?? '').trim() || join(env.USERPROFILE ?? env.HOME ?? homedir(), '.config');
  return join(base, 'opencodefork');
}

/** JSON with // and block comments and trailing commas (what OpenCodeFork accepts) as plain JSON text; strings are left alone. */
export function stripJsonc(text) {
  let out = '', i = 0, inString = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += c;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Adds or replaces `model` in the config. `baseURL`: this host's /v1; `apiKey`: the host's API key when one is set (else a key already there is kept);
 * `context`: the model's context length when known. Returns { file, created, replaced, shape, backup }.
 */
export function connectOpenCode({ model, name, context, baseURL, apiKey, dir = opencodeConfigDir() }) {
  if (!model || typeof model !== 'string') throw new Error('No model to connect.');
  if (!baseURL) throw new Error('The local API address is not known.');
  const json = join(dir, 'opencode.json'), jsonc = join(dir, 'opencode.jsonc');
  const file = existsSync(json) || !existsSync(jsonc) ? json : jsonc;
  let config = {}, created = true;
  if (existsSync(file)) {
    created = false;
    const raw = readFileSync(file, 'utf8').replace(/^﻿/, '');
    if (raw.trim()) {
      try { config = JSON.parse(file.endsWith('.jsonc') ? stripJsonc(raw) : raw); }
      catch (e) { throw new Error(`${file} is not valid JSON (${e.message}); it was left unchanged.`); }
      if (!isRecord(config)) throw new Error(`${file} does not hold a JSON object; it was left unchanged.`);
    }
  }
  const ctx = Number.isFinite(Number(context)) && Number(context) > 0 ? Math.floor(Number(context)) : null;
  const label = String(name || model);
  const native = isRecord(config.providers) && isRecord(config.providers[OPENCODE_PROVIDER_ID]);
  let replaced = false;
  if (native) {
    const p = config.providers[OPENCODE_PROVIDER_ID];
    p.name ??= 'Strata';
    p.package = NATIVE_PACKAGE;
    p.settings = { ...(isRecord(p.settings) ? p.settings : {}), baseURL, ...(apiKey ? { apiKey } : {}) };
    p.models = isRecord(p.models) ? p.models : {};
    replaced = Object.hasOwn(p.models, model);
    p.models[model] = { name: label, ...(ctx ? { limit: { context: ctx, output: Math.min(OUTPUT_CAP, ctx) } } : {}) };
    // the same model left in a legacy entry too would be a second definition of it
    const legacy = isRecord(config.provider) ? config.provider[OPENCODE_PROVIDER_ID] : undefined;
    if (isRecord(legacy) && isRecord(legacy.models)) delete legacy.models[model];
  } else {
    config.provider = isRecord(config.provider) ? config.provider : {};
    const p = config.provider[OPENCODE_PROVIDER_ID] = isRecord(config.provider[OPENCODE_PROVIDER_ID]) ? config.provider[OPENCODE_PROVIDER_ID] : {};
    p.npm = LEGACY_PACKAGE;
    p.name ??= 'Strata';
    p.options = { ...(isRecord(p.options) ? p.options : {}), baseURL, ...(apiKey ? { apiKey } : {}) };
    p.models = isRecord(p.models) ? p.models : {};
    replaced = Object.hasOwn(p.models, model);
    p.models[model] = { name: label, tool_call: true, ...(ctx ? { limit: { context: ctx, output: Math.min(OUTPUT_CAP, ctx) } } : {}) };
  }
  mkdirSync(dir, { recursive: true });
  let backup = null;
  if (!created) { backup = `${file}.strata-backup`; copyFileSync(file, backup); }
  const target = file.endsWith('.jsonc') ? file : json;
  const temp = `${target}.strata-tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  renameSync(temp, target);
  return { file: target, created, replaced, shape: native ? 'providers' : 'provider', backup };
}
