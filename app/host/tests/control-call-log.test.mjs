// SOAK-APP 11-17 13:20: a model Unload stayed pending for 5 min 46 s and nothing in the host log said which call to Control it was waiting for, or for how long.
// Every call to Control now writes its start and its end with the time it took.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { controlCallName, createControl } from '../server/control-runtime.mjs';

const control = { dir: '/c', python: 'p', cli: 'c' };

test('a call to Control writes its start, its end and how long it took; the command line past its first two words and the profile stays out of the log', async () => {
  const lines = []; let clock = 1000;
  const ctl = createControl({
    control, log: line => lines.push(line), now: () => clock,
    run: async args => { clock += 2500; return { code: 0, json: { ok: true }, text: '', stderr: '', args }; },
  });
  await ctl.stop('web-1', { waitSeconds: 120 });
  assert.deepEqual(lines, ['control #1 begin runtime stop (profile web-1)', 'control #1 end runtime stop (profile web-1): exit 0 after 2.5 s']);
  lines.length = 0;
  await ctl.updateCheck({ feed: 'https://user:secret@example.invalid/feed', appVersion: '1.2.3' }).catch(() => {});
  assert.ok(lines.length >= 2, 'the update check was logged too: ' + lines.join(' | '));
  assert.match(lines[0], /^control #2 begin update --check$/);
  for (const l of lines) assert.doesNotMatch(l, /secret|example\.invalid|1\.2\.3/, l);
});

test('a call that fails or times out is logged as failed with its code and its time, and the error still reaches the caller', async () => {
  const lines = []; let clock = 0;
  const ctl = createControl({
    control, log: line => lines.push(line), now: () => clock,
    run: async () => { clock += 180_000; throw Object.assign(new Error('Strata Control did not answer within 180 s (runtime stop).'), { code: 'control_timeout' }); },
  });
  await assert.rejects(ctl.stop('web-1'), /did not answer within 180 s/);
  assert.deepEqual(lines, ['control #1 begin runtime stop (profile web-1)', 'control #1 failed runtime stop (profile web-1): control_timeout after 180.0 s']);
});

test('calls are numbered, a log that throws never breaks a call, and without a log nothing is written', async () => {
  const seen = [];
  const noisy = createControl({ control, log: () => { throw new Error('the log is broken'); }, run: async args => { seen.push(args[0]); return { code: 0, json: { ok: true, state: 'ready' }, text: '', stderr: '' }; } });
  await noisy.stop('a'); await noisy.stop('b');
  assert.deepEqual(seen, ['runtime', 'runtime']);
  const lines = [];
  const numbered = createControl({ control, log: l => lines.push(l), run: async () => ({ code: 0, json: { ok: true }, text: '', stderr: '' }) });
  await numbered.stop('a'); await numbered.stop('b');
  assert.deepEqual(lines.filter(l => /begin/.test(l)), ['control #1 begin runtime stop (profile a)', 'control #2 begin runtime stop (profile b)']);
  const quiet = createControl({ control, run: async () => ({ code: 0, json: { ok: true }, text: '', stderr: '' }) });
  await quiet.stop('a');   // no log option: as before
});

test('controlCallName: the first two words, the profile only when it is a plain name', () => {
  assert.equal(controlCallName(['runtime', 'stop', '--profile', 'web-1', '--wait', '120']), 'runtime stop (profile web-1)');
  assert.equal(controlCallName(['components', 'engines', '--output', 'json']), 'components engines');
  assert.equal(controlCallName(['models', 'import', 'C:\\Users\\x\\secret model.gguf']), 'models import');
  assert.equal(controlCallName(['runtime', 'start', '--profile', 'C:\\Users\\x\\p']), 'runtime start');
});

