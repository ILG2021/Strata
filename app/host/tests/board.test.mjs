// The task board: what lands in which column, which button a card gets, what a dismissal hides, and what the host keeps so that it
// stays true (a new run clears the last problem; the loop and chat records the board reads).
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createTaskService } from '../server/tasks.mjs';
import { lastLine } from '../server/task-report.mjs';

const compiled = await build({ stdin: { contents: "export * from './src/lib/board'; export * from './src/lib/loop-runner'; export * from './src/lib/task-handover'; export * from './src/lib/i18n';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.json': 'json' } });
const { boardCards, plainLine, folderName, LoopScheduler, chatHandoverMessage } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

const NOW = Date.parse('2026-10-19T12:00:00Z');
const ago = ms => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const task = (over = {}) => ({ id: 't1', title: 'Backup check', prompt: 'p', frequency: 'daily', at: '02:00', weekday: 1, timeZone: 'UTC', enabled: true, nextRunAt: new Date(NOW + HOUR).toISOString(), status: 'done', lastRunAt: ago(2 * HOUR), finishedAt: ago(2 * HOUR - MIN), ...over });
const msg = (role, content, over = {}) => ({ id: `m${Math.random()}`, role, content, at: ago(HOUR), ...over });
const chat = (over = {}) => ({ id: 'c1', title: 'Fix rounding', workspace: 'C:\\work\\billing-api', createdAt: ago(DAY), updatedAt: ago(HOUR), messages: [msg('user', 'fix it'), msg('assistant', 'Fixed. Totals now round to the cent.')], tokensIn: 0, tokensOut: 0, ...over });
const input = (over = {}) => ({ tasks: [], sessions: [], liveChats: [], loopChats: [], activeSession: null, now: NOW, ...over });
const ids = list => list.map(c => c.id);

test('a scheduled task lands where its state puts it', () => {
  const b = boardCards(input({ tasks: [
    task({ id: 'run', status: 'running', lastRunAt: ago(2 * MIN), finishedAt: null }),
    task({ id: 'err', status: 'error', error: 'no model loaded' }),
    task({ id: 'stop', status: 'cancelled', error: 'Run stopped.' }),
    task({ id: 'gone', status: 'interrupted' }),
    task({ id: 'ok', status: 'done', lastLine: 'Twelve changes this week.' }),
    task({ id: 'new', status: 'idle', lastRunAt: undefined, finishedAt: undefined }),
    task({ id: 'old', status: 'done', finishedAt: ago(8 * DAY), lastRunAt: ago(8 * DAY) }),
    task({ id: 'arch', status: 'error', archived: true, error: 'x' }),
  ] }));
  assert.deepEqual(ids(b.columns.running), ['run']);
  assert.deepEqual(ids(b.columns.attention).sort(), ['err', 'gone', 'stop']);
  assert.deepEqual(ids(b.columns.done), ['ok'], 'older than 7 days, archived and never-run tasks are not on the board');
  assert.deepEqual(Object.keys(b.columns).sort(), ['attention', 'done', 'running'], 'no Waiting column');
  assert.equal(b.need, 3);
  assert.deepEqual(b.problemTasks.sort(), ['err', 'gone', 'stop']);
});

test('a task card has one next step and a menu, by what happened', () => {
  const b = boardCards(input({ tasks: [task({ id: 'run', status: 'running', finishedAt: null }), task({ id: 'err', status: 'error', error: 'boom' }), task({ id: 'ok' })] }));
  const by = id => Object.values(b.columns).flat().find(c => c.id === id);
  assert.deepEqual([by('run').primary, by('run').menu], ['stop-task', ['open-task']]);
  assert.deepEqual([by('err').primary, by('err').menu], ['run-again', ['open-task', 'continue', 'dismiss']]);
  assert.deepEqual([by('ok').primary, by('ok').menu], ['view-result', ['dismiss']], 'a Done card can be dismissed too');
  assert.equal(by('err').reason.tone, 'bad');
});

test('dismissing a task hides that run only; a newer run brings its problem back', () => {
  const failed = task({ status: 'error', error: 'boom', finishedAt: ago(3 * HOUR) });
  assert.equal(boardCards(input({ tasks: [{ ...failed, ackedAt: ago(HOUR) }] })).need, 0);
  assert.equal(boardCards(input({ tasks: [{ ...failed, ackedAt: ago(4 * HOUR) }] })).need, 1, 'dismissed before this run ended');
  const done = task({ ackedAt: ago(MIN) });
  assert.equal(boardCards(input({ tasks: [done] })).columns.done.length, 0);
});

test('the next scheduled runs are listed soonest first, paused tasks left out', () => {
  const b = boardCards(input({ tasks: [task({ id: 'b', title: 'B', nextRunAt: new Date(NOW + 2 * HOUR).toISOString() }), task({ id: 'a', title: 'A', nextRunAt: new Date(NOW + HOUR).toISOString() }), task({ id: 'p', enabled: false })] }));
  assert.deepEqual(b.upcoming.map(u => u.id), ['a', 'b']);
});

test('a running chat and a running loop are one card each, never two for the same chat', () => {
  const loop = { prompt: 'check the build', everyMs: 10 * MIN, startedAt: NOW - 20 * MIN, state: 'running', answers: 2, maxRuns: 6, nextAt: NOW + 4 * MIN, lastText: 'Build is still red.' };
  const b = boardCards(input({ sessions: [chat({ loop }), chat({ id: 'c2', title: 'Refactor' })], liveChats: ['c2'], loopChats: ['c1'] }));
  assert.deepEqual(b.columns.running.map(c => [c.key, c.primary, c.menu]), [['chat:c2', 'open-chat', ['stop-chat']], ['loop:c1', 'stop-loop', ['open-chat']]].sort((x, y) => b.columns.running.findIndex(c => c.key === x[0]) - b.columns.running.findIndex(c => c.key === y[0])));
  const l = b.columns.running.find(c => c.source === 'loop');
  assert.deepEqual(l.meta, { text: 'answer {0} of {1}', params: [3, 6] });
  assert.equal(l.nextAt, NOW + 4 * MIN);
  assert.equal(b.columns.running.find(c => c.id === 'c2').meta, undefined);
});

test('a loop that ended is Done, unless 3 runs in a row failed; then it needs attention', () => {
  const ended = why => chat({ loop: { prompt: 'watch', everyMs: 5 * MIN, startedAt: NOW - HOUR, state: 'ended', endedWhy: why, endedAt: NOW - 10 * MIN, answers: 3 } });
  for (const why of ['count', 'said-done', 'time', 'cap', 'stopped', 'closed']) {
    const b = boardCards(input({ sessions: [ended(why)] }));
    assert.equal(b.columns.done.length, 1, why);
    assert.equal(b.columns.attention.length, 0, why);
  }
  const bad = boardCards(input({ sessions: [ended('failures')] })).columns.attention[0];
  assert.equal(bad.reason.kind, 'loop-failed');
  assert.deepEqual([bad.primary, bad.menu], ['open-chat', ['continue', 'dismiss']]);
  const running = chat({ loop: { prompt: 'x', everyMs: MIN, startedAt: NOW - HOUR, state: 'running', answers: 1 } });
  assert.equal(boardCards(input({ sessions: [running] })).columns.done[0].chip.text, 'Stopped when Strata closed', 'a record that says running with no loop behind it is a loop the window closed on');
});

test('chats show up only with something to do, from the last 7 days', () => {
  const b = boardCards(input({ sessions: [
    chat({ id: 'unread', lastReadAt: ago(2 * HOUR) }),
    chat({ id: 'seen', lastReadAt: ago(30 * MIN) }),
    chat({ id: 'open' }),
    chat({ id: 'old', updatedAt: ago(8 * DAY), lastReadAt: ago(9 * DAY) }),
    chat({ id: 'bad', messages: [msg('user', 'go'), msg('assistant', '', { error: 'The model stopped while starting.' })] }),
    chat({ id: 'typing', messages: [msg('user', 'hello')] }),
    chat({ id: 'stream', lastReadAt: ago(DAY), messages: [msg('user', 'go'), msg('assistant', 'part', { streaming: true })] }),
    chat({ id: 'arch', archived: true, lastReadAt: ago(DAY) }),
  ], activeSession: 'open' }));
  assert.deepEqual(ids(b.columns.done), ['unread']);
  assert.deepEqual(ids(b.columns.attention), ['bad']);
  assert.deepEqual([b.columns.attention[0].primary, b.columns.attention[0].menu], ['open-chat', ['continue', 'dismiss']]);
  assert.equal(b.columns.done[0].folder, 'billing-api');
});

test('dismissing a chat card hides it until something newer happens in that chat', () => {
  const bad = chat({ messages: [msg('user', 'go'), msg('assistant', '', { error: 'boom' })], updatedAt: ago(HOUR) });
  assert.equal(boardCards(input({ sessions: [{ ...bad, ackedAt: ago(30 * MIN) }] })).need, 0);
  assert.equal(boardCards(input({ sessions: [{ ...bad, ackedAt: ago(2 * HOUR) }] })).need, 1);
  const endedLoop = chat({ loop: { prompt: 'x', everyMs: MIN, startedAt: NOW - HOUR, state: 'ended', endedWhy: 'failures', endedAt: NOW - 20 * MIN, answers: 0 } });
  assert.equal(boardCards(input({ sessions: [{ ...endedLoop, ackedAt: ago(10 * MIN) }] })).need, 0);
});

test('every column is newest first', () => {
  const b = boardCards(input({ tasks: [task({ id: 'a', finishedAt: ago(3 * HOUR) }), task({ id: 'b', finishedAt: ago(HOUR) })] }));
  assert.deepEqual(ids(b.columns.done), ['b', 'a']);
});

test('small helpers: one plain line, a folder name', () => {
  assert.equal(plainLine('**Fixed.** Totals now round to the cent and the tests pass. More text.'), 'Fixed. Totals now round to the cent and the tests pass.');
  assert.equal(plainLine('# Report\n\n- first thing\n- second'), 'Report first thing second');
  assert.equal(folderName('C:\\work\\billing-api\\'), 'billing-api');
  assert.equal(folderName(''), undefined);
});

/* ---- what the host and the loop keep for the board ---- */

test('the host line for a card is the first plain sentence, without the list of steps or the note', () => {
  assert.equal(lastLine('Two things need your attention. Disk space is low.\n\n---\n\n**What it did**\n\n- Read the log\n\n> needed a yes'), 'Two things need your attention.');
  assert.equal(lastLine('**All 4** backup folders were found and read.\n\n> note'), 'All 4 backup folders were found and read.');
  assert.equal(lastLine(''), '');
  assert.ok(lastLine('x'.repeat(500)).length <= 160);
});

function service(run, seed = []) {
  let db = seed, t = Date.parse('2026-10-19T12:00:00Z');
  const svc = createTaskService({ read: () => db, write: r => { db = JSON.parse(JSON.stringify(r)); }, run, now: () => t });
  return { svc, advance: ms => { t += ms; }, db: () => db };
}
const draft = { title: 'T', prompt: 'p', frequency: 'daily', at: '08:00', weekday: 1, timeZone: 'UTC', mode: 'plan' };

test('a run records when it ended and its one plain line; a failure keeps only the newest problem', async () => {
  let n = 0;
  const { svc, advance } = service(async () => {
    n += 1;
    if (n === 1) return { text: 'All 4 folders read.\n\n> It wanted a yes.', attention: 'It wanted a yes.' };
    if (n === 2) throw new Error('first problem');
    if (n === 3) throw new Error('second problem');
    return { text: 'Fine now.' };
  });
  const id = svc.put(draft).id;
  await svc.execute(id);
  let t = svc.list()[0];
  assert.equal(t.status, 'done'); assert.equal(t.attention, 'It wanted a yes.'); assert.equal(t.lastLine, 'All 4 folders read.'); assert.ok(t.finishedAt);
  advance(MIN);
  await svc.execute(id);
  t = svc.list()[0];
  assert.equal(t.status, 'error'); assert.equal(t.error, 'first problem'); assert.equal(t.attention, null, 'a stale "needed a yes" does not survive a later run');
  advance(MIN);
  await svc.execute(id);
  assert.equal(svc.list()[0].error, 'second problem', 'only the newest problem is kept');
  await svc.execute(id);
  t = svc.list()[0];
  assert.equal(t.error, null); assert.equal(t.status, 'done');
});

test('Dismiss is a mark on the task (ackedAt) that a new run clears', async () => {
  const { svc } = service(async () => { throw new Error('boom'); });
  const id = svc.put(draft).id;
  await svc.execute(id);
  const mark = new Date().toISOString();
  svc.put({ ackedAt: mark }, id);
  assert.equal(svc.list()[0].ackedAt, mark);
  assert.equal(svc.list()[0].error, 'boom', 'dismissing keeps the result');
  await svc.execute(id);
  assert.equal(svc.list()[0].ackedAt, null);
  svc.put({ title: 'Renamed' }, id);
  assert.equal(svc.list()[0].ackedAt, null, 'an edit that does not mention it leaves it alone');
});

test('a loop leaves a record on its chat: running with the next time, then how it ended', async () => {
  const records = [];
  let clock = 1_000, timer = null;
  const sched = new LoopScheduler({
    send: async () => ({ answered: true, text: 'Build is still red: 2 tests fail.', failed: false }),
    note: () => {}, exists: () => true, ready: () => true, now: () => clock,
    setTimer: (fn, ms) => { timer = { fn, ms }; return timer; }, clearTimer: () => { timer = null; },
    track: (id, record) => records.push({ id, ...record }),
  });
  await sched.start('c1', { everyMs: 10 * MIN, prompt: 'check the build', maxRuns: 2 });
  assert.deepEqual(sched.ids(), ['c1']);
  const waiting = records.at(-1);
  assert.equal(waiting.state, 'running'); assert.equal(waiting.answers, 1); assert.equal(waiting.nextAt, 1_000 + 10 * MIN); assert.equal(waiting.lastText, 'Build is still red: 2 tests fail.'); assert.equal(waiting.maxRuns, 2);
  clock += 10 * MIN;
  await timer.fn();
  await new Promise(r => setImmediate(r));
  const ended = records.at(-1);
  assert.equal(ended.state, 'ended'); assert.equal(ended.endedWhy, 'count'); assert.equal(ended.answers, 2);
  assert.deepEqual(sched.ids(), []);

  await sched.start('c2', { everyMs: MIN, prompt: 'x' });
  assert.equal(sched.stop('c2'), true);
  assert.equal(records.at(-1).endedWhy, 'stopped');
});

test('"Continue in a new chat" on a chat starts from what was asked, what went wrong and the last answer', () => {
  const s = chat({ messages: [msg('user', 'Update the dependencies'), msg('assistant', 'Working on it.', { error: 'The model stopped while starting.' }), msg('assistant', 'note', { local: true })] });
  const text = chatHandoverMessage(s);
  assert.match(text, /Continuing from the chat “Fix rounding”/);
  assert.match(text, /Update the dependencies/);
  assert.match(text, /The model stopped while starting\./);
  assert.match(text, /Working on it\./);
  assert.doesNotMatch(text, /note/);
  assert.match(text, /Please help me take it from here\.$/);
  const loopText = chatHandoverMessage(chat({ loop: { prompt: 'watch the deploy', everyMs: MIN, startedAt: 0, state: 'ended', endedWhy: 'failures', endedAt: 1, answers: 0 } }));
  assert.match(loopText, /watch the deploy/);
  assert.match(loopText, /3 runs in a row did not work/);
});
