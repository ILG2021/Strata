/** Pass 2 GUI regression tests: #6680 Hy4-Flash reasoning_effort clamp, #6668 QuestionCard usability, #6661 shutdown chat-save drain. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createChatStore, drainChatStore, realIo } from '../server/chat-store.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(r => setTimeout(r, ms));
async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}
const bundleTs = async rel => {
  const built = await build({
    entryPoints: [fileURLToPath(new URL(rel, import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'esm', loader: { '.json': 'json' },
  });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
};



test('#6661 drainChatStore waits for queued and in-flight chat saves and bounds hangs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'strata-drain-unit-'));
  try {
    let writeDone = false;
    const store = createChatStore({
      dir,
      io: {
        ...realIo,
        async writeFile(path, text) {
          await delay(120);
          await realIo.writeFile(path, text);
          if (path.includes('s_slow.json')) writeDone = true;
        },
      },
    });
    const inFlight = new Set();
    const p = (async () => {
      await delay(40);
      await store.save('s_slow', JSON.stringify({ id: 's_slow', title: 'Slow', messages: [{ id: 'm1', role: 'user', content: 'saved before exit' }] }));
    })();
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));

    const res = await drainChatStore(store, { inFlight, timeoutMs: 2000 });
    assert.equal(res.drained, true);
    assert.equal(writeDone, true);
    const saved = JSON.parse(await store.read('s_slow'));
    assert.equal(saved.session.messages[0].content, 'saved before exit');

    // Bounded timeout: a stuck save never hangs shutdown forever
    const stuck = createChatStore({
      dir,
      io: { ...realIo, writeFile: () => new Promise(() => {}) },
    });
    void stuck.save('s_hung', JSON.stringify({ id: 's_hung', title: 'Hung', messages: [] })).catch(() => {});
    const t0 = Date.now();
    const resTimeout = await drainChatStore(stuck, { timeoutMs: 120 });
    assert.equal(resTimeout.drained, false);
    assert.ok(Date.now() - t0 < 1000, 'drain respected bounded timeout');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('#6661 real host shutdown drains an in-flight chat save before exiting', { timeout: 30000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'strata-drain-host-'));
  const port = await freePort();
  const token = 'a'.repeat(40);
  const env = {
    ...process.env,
    STRATA_HOME: home,
    STRATA_MODELS_DIR: join(home, 'models'),
    STRATA_PORT: String(port),
    STRATA_SHARE_PORT: String(await freePort()),
    STRATA_TUNNEL_PORT: String(await freePort()),
    STRATA_REAL_ENGINE: '1',
    STRATA_SHUTDOWN_TOKEN: token,
    STRATA_SHUTDOWN_CHAT_DRAIN_MS: '4000',
    STRATA_SETTINGS_FILE: join(home, 'app-settings.json'),
    STRATA_COMPONENTS_DIR: join(home, 'components'),
    LOCALAPPDATA: join(home, 'Local'),
    APPDATA: join(home, 'Roaming'),
    XDG_DATA_HOME: join(home, 'xdg-data'),
    XDG_STATE_HOME: join(home, 'xdg-state'),
    XDG_CONFIG_HOME: join(home, 'xdg-config'),
  };
  const host = spawn(process.execPath, ['server/index.mjs'], { cwd: root, stdio: 'ignore', env, windowsHide: true });
  const exited = new Promise(r => host.once('exit', (code, signal) => r({ code, signal })));
  try {
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 150 && !up; i++) {
      try { up = (await fetch(`${base}/api/health`)).ok; } catch { await delay(100); }
    }
    assert.ok(up, 'host started');

    // Start a large (~4 MB) chat save over a streaming HTTP request, wait briefly so the host
    // has accepted it into its in-flight chat-save set, then trigger clean shutdown before finishing the body.
    const { default: http } = await import('node:http');
    const payload = JSON.stringify({
      id: 's_drain',
      title: 'Drain test',
      createdAt: '2026-11-22T12:00:00.000Z',
      updatedAt: '2026-11-22T12:00:01.000Z',
      messages: [{ id: 'm1', role: 'assistant', content: 'Z'.repeat(4_000_000) }],
    });
    const half = Math.floor(payload.length / 2);
    const savePromise = new Promise((resolveSave, rejectSave) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/api/chats/s_drain',
        method: 'PUT',
        headers: {
          'x-strata-client': 'ui',
          'x-strata-window': 'w1',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      }, res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolveSave({ status: res.statusCode, body }));
      });
      req.on('error', rejectSave);
      req.write(payload.slice(0, half));
      // Hold the second half for 80 ms so /api/control/shutdown arrives mid-upload.
      setTimeout(() => req.end(payload.slice(half)), 80);
    });
    await delay(30);
    const stopRes = await fetch(`${base}/api/control/shutdown`, {
      method: 'POST',
      headers: { 'x-strata-shutdown': token },
    });
    const saveRes = await savePromise;
    assert.equal(stopRes.status, 202);
    assert.equal(saveRes.status, 200, 'in-flight chat save completed cleanly during shutdown');
    const exitInfo = await exited;
    assert.equal(exitInfo.code, 0, 'host exited cleanly');

    const disk = JSON.parse(await readFile(join(home, 'data', 'chats', 's_drain.json'), 'utf8'));
    assert.equal(disk.rev, 1);
    assert.equal(disk.session.id, 's_drain');
    assert.equal(disk.session.messages[0].content.length, 4_000_000);
  } finally {
    if (host.exitCode === null) { host.kill('SIGKILL'); await exited; }
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
});
