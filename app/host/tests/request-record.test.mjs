// Monitor > Recent requests > View: the row names the engine server's record of its raw request and reply, and the host fetches it with the engine's key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = p => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

test('the engine history names the record and the monitor row carries it', () => {
  assert.match(read('../../../terminal/serve/server.py'), /"api_request": trace\["id"\] if trace else None/);
  assert.match(read('../src/lib/native-monitor.ts'), /apiRequestId:typeof r\.api_request==='string'\?r\.api_request:null/);
});

/* requestRecord as native-control.mjs defines it, with its two collaborators replaced. */
const source = /async function requestRecord[\s\S]*?\n(?= function resolveInstance)/.exec(read('../server/native-control.mjs'))[0];
const make = fetcher => new Function('resolveInstance', 'fetcher', `${source}; return requestRecord;`)(() => ({ port: 9, key: 'k' }), fetcher);

test('a kept record is returned, a dropped one is gone, a dead engine is unavailable', async () => {
  let asked;
  const ok = make(async (url, init) => { asked = { url, auth: init.headers.authorization }; return new Response('{"input":"{}","output":"hi"}'); });
  assert.deepEqual(await ok('m', '0123456789ab'), { status: 'ok', record: { input: '{}', output: 'hi' } });
  assert.deepEqual(asked, { url: 'http://127.0.0.1:9/api/requests?id=0123456789ab', auth: 'Bearer k' });
  assert.deepEqual(await make(async () => new Response('', { status: 404 }))('m', 'x'), { status: 'gone' });
  assert.deepEqual(await make(async () => { throw new Error('down'); })('m', 'x'), { status: 'unavailable' });
});
