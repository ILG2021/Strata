// Privacy audit 2026-11-24: who may talk to the host, the page's policy, and offline mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { contentSecurityPolicy, foreignApiRequest, hostAllowed } from '../server/request-guard.mjs';
import { readOffline } from '../server/network-mode.mjs';
import { controlEnvironment, runCli } from '../server/control-runtime.mjs';

test('a name pointed at this computer is not this host; addresses and localhost are', () => {
  for (const ok of ['127.0.0.1:47831', 'localhost:47831', '[::1]:47831', 'app.localhost:1', '192.168.1.5:8791']) assert.equal(hostAllowed(new URL(`http://${ok}/`)), true, ok);
  for (const bad of ['evil.example:47831', 'localhost.evil.example', '127.0.0.1.nip.io', 'my-pc']) assert.equal(hostAllowed(new URL(`http://${bad}/`)), false, bad);
});

test('only the host\'s own page, or a client that is no browser, uses the API', () => {
  const host = '127.0.0.1:47831', ask = (headers, packaged = true) => foreignApiRequest({ headers: { host, ...headers } }, { packaged });
  assert.equal(ask({}), false);
  assert.equal(ask({ origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }), false);
  assert.equal(ask({ 'sec-fetch-site': 'none' }), false);
  for (const headers of [{ origin: 'http://localhost:3000' }, { origin: 'http://127.0.0.1:3000' }, { origin: 'https://evil.example' }, { origin: 'null' }, { origin: `https://${host}` }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) assert.equal(ask(headers), true, JSON.stringify(headers));
  assert.equal(ask({ origin: 'http://localhost:5199' }, false), false, "Vite's page in development");
  assert.equal(ask({ origin: 'http://localhost:5199' }, true), true, 'never in the installed app');
});

test('the policy runs only the inline script of the built page and loads from the host alone', () => {
  const csp = contentSecurityPolicy('<script>\r\nlet a = 1;\r\n</script><script type="module" src="/x.js"></script>');
  assert.ok(csp.includes(`'sha256-${createHash('sha256').update('\nlet a = 1;\n').digest('base64')}'`));
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline|unsafe-eval'(?<!wasm-unsafe-eval')|https:|\*/);
});

test('offline mode is retired: a file an older version wrote is ignored, and every download step keeps the download allowlist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'strata-offline-')), components = join(dir, 'components');
  try {
    mkdirSync(components, { recursive: true });
    writeFileSync(join(dir, 'network-mode.json'), JSON.stringify({ offline: true }));
    assert.equal(readOffline(components), false);
    assert.equal(controlEnvironment({}, { env: {}, components, acquire: true }).STRATA_EGRESS, 'allowlist');
    assert.equal(controlEnvironment({}, { env: {}, components }).STRATA_NO_ACQUIRE, '1', 'starting and serving still never download');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the installed app ignores variables that name another download place', () => {
  const env = { STRATA_PACKAGED: '1', HF_ENDPOINT: 'https://mirror.example', Strata_Update_Feed: 'https://x.example', HF_TOKEN: 't' };
  const got = controlEnvironment({}, { env, components: join(tmpdir(), 'strata-none', 'c') });
  assert.equal(got.HF_ENDPOINT, undefined); assert.equal(got.Strata_Update_Feed, undefined); assert.equal(got.HF_TOKEN, 't');
});
