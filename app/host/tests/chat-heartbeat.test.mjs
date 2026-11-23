/**
 * #4878: a quiet desktop chat stream stays open. The chat answer is NDJSON; during a long silence (prompt processing, a tool,
 * an approval wait) a `{"type":"beat"}` frame goes out every 15 seconds so the web view does not drop the request at 60 s.
 *  - the helper, with fake timers: a 60-second tool wait gives the beats, and the timer ends on finish, on close, on error and
 *    on stop(), with no interval left behind;
 * The frontend consumer (src/lib/store.ts) has no branch for an unknown frame type, so `beat` changes nothing there; the last
 * test pins that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startScriptedWorker } from './helpers/scripted-worker.mjs';
import { BEAT_MS, beatInterval, keepStreamAlive } from '../server/stream-beat.mjs';

/** A response stand-in: records writes, emits finish/close like http.ServerResponse. */
function fakeResponse() {
  const res = new EventEmitter();
  res.writes = [];
  res.writableEnded = false;
  res.destroyed = false;
  res.write = chunk => { res.writes.push(String(chunk)); return true; };
  res.end = () => { res.writableEnded = true; res.emit('finish'); res.emit('close'); };
  return res;
}
const beats = res => res.writes.filter(w => w === '{"type":"beat"}\n').length;
const listeners = res => ['finish', 'close', 'error'].reduce((n, e) => n + res.listenerCount(e), 0);

test('the interval is 15 s; a tester can shorten it; nonsense is the default', () => {
  assert.equal(BEAT_MS, 15_000);
  assert.equal(beatInterval({}), 15_000);
  assert.equal(beatInterval({ STRATA_STREAM_BEAT_MS: '200' }), 200);
  for (const bad of ['0', '-5', 'abc', '', '5', '999999', 'NaN']) assert.equal(beatInterval({ STRATA_STREAM_BEAT_MS: bad }), 15_000, bad);
});

test('a 60-second silent tool wait carries a beat every 15 s, each a whole NDJSON line', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const res = fakeResponse();
  const stop = keepStreamAlive(res);
  t.mock.timers.tick(14_999);
  assert.equal(beats(res), 0, 'nothing before 15 s');
  t.mock.timers.tick(1);
  assert.equal(beats(res), 1);
  t.mock.timers.tick(45_000);
  assert.equal(beats(res), 4, 'four beats in 60 s');
  for (const w of res.writes) assert.deepEqual(JSON.parse(w), { type: 'beat' });
  assert.ok(res.writes.every(w => w.endsWith('\n') && w.indexOf('\n') === w.length - 1));
  stop();
});

test('the timer is cleared on finish, on close, on error and by stop(): nothing beats afterwards, no listener is left', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const how of ['finish', 'close', 'error', 'stop', 'end']) {
    const res = fakeResponse();
    const stop = keepStreamAlive(res);
    t.mock.timers.tick(15_000);
    assert.equal(beats(res), 1, how);
    if (how === 'stop') stop(); else if (how === 'end') res.end(); else res.emit(how, new Error('x'));
    const after = res.writes.length;
    t.mock.timers.tick(120_000);
    assert.equal(res.writes.length, after, `${how}: no beat after the end`);
    assert.equal(listeners(res), 0, `${how}: no listener left on the response`);
    stop();   // calling it again is harmless
  }
});

test('a response that was destroyed or ended without an event is not written to, and its timer goes at the next tick', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const a = fakeResponse(); keepStreamAlive(a); a.destroyed = true;
  const b = fakeResponse(); keepStreamAlive(b); b.writableEnded = true;
  const c = fakeResponse(); keepStreamAlive(c); c.write = () => { throw new Error('socket closed'); };
  t.mock.timers.tick(15_000);
  assert.equal(a.writes.length + b.writes.length, 0);
  t.mock.timers.tick(120_000);
  assert.equal(a.writes.length + b.writes.length, 0);
  assert.equal(listeners(a) + listeners(b) + listeners(c), 0);
});

test('two responses beat independently: ending one leaves the other beating', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const one = fakeResponse(), two = fakeResponse();
  keepStreamAlive(one); keepStreamAlive(two);
  t.mock.timers.tick(30_000);
  assert.equal(beats(one), 2); assert.equal(beats(two), 2);
  one.emit('close');
  t.mock.timers.tick(30_000);
  assert.equal(beats(one), 2, 'the closed chat stops');
  assert.equal(beats(two), 4, 'the other keeps going');
});

test('the desktop consumer ignores a frame type it does not know (so beat changes nothing there)', () => {
  const store = readFileSync(resolve(import.meta.dirname, '..', 'src', 'lib', 'store.ts'), 'utf8');
  const start = store.indexOf("if (type === 'delta' || type === 'reasoning') { queueText");
  const doneAt = store.indexOf("} else if (type === 'done') {", start);
  assert.ok(start > 0 && doneAt > start, 'found the frame handler');
  // the chain is if / else if only and its last branch is `done`: no final `else` follows it, so an unknown type falls through silently
  assert.match(store.slice(doneAt, doneAt + 2500), /flushSessions\(\);\s*\}\s*\},/);
  assert.ok(!store.slice(start, doneAt).includes("type === 'beat'"), 'no special case is needed');
  const client = readFileSync(resolve(import.meta.dirname, '..', 'src', 'lib', 'client.ts'), 'utf8');
  assert.match(client, /onFrame\(JSON\.parse\(line\)/);
});
