#!/usr/bin/env node
import './system-ca.mjs';        // #3722: the operating system's certificates, before any HTTPS request
import { createCloudflare } from './cloudflare.mjs';
import { createConnectorInstaller } from './cloudflared-install.mjs';
import { findRunningConnector } from './cloudflared-find.mjs';
import { openArtifact } from './artifacts.mjs';
import { saveSnapshot } from './snapshot.mjs';
import { resolvePython, shellPrefix } from './python-resolver.mjs';
import { chooseFolder, chooserUnavailable, typedFolder } from './folder-dialog.mjs';
import { createLocalShare } from './local-share.mjs';
import { workspaceBases } from './model-directory-default.mjs';
import { createTaskService, validateTask } from './tasks.mjs';
import { migrateSetup } from './setup.mjs';
import { parseSkillFile } from './skill-files.mjs';
import { systemFonts } from './fonts.mjs';
import { tuningDir } from './platform-paths.mjs';
import { withPlainStatus } from './plain-status.mjs';
/**
 * Strata engine host.
 *
 *   node server/index.mjs                 # API only (use with `npm run dev`)
 *   node server/index.mjs --dist dist     # API + the built web app on one port
 *
 * Owns hardware detection, the model library, engine tuning, the serving log,
 * live metrics and the local inference API. No runtime dependencies.
 */
import http from 'node:http';
import { homedir } from 'node:os';
import { statfsSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as hardware from './hardware.mjs';
import * as models from './models.mjs';
import * as engine from './engine.mjs';
import * as monitor from './monitor.mjs';
import * as serving from './serving.mjs';
import * as store from './store.mjs';
import { createChatStore, drainChatStore, storeFailure, validChatId } from './chat-store.mjs';
import { makePrivateDir } from './private-file.mjs';
import * as supervisor from './supervisor.mjs';
import { detectBackend, currentBackend, streamChat, inferenceLine } from './inference.mjs';
import { CONTEXT_TOKENS, VARIANTS, localModels, variant } from './catalog.mjs';
import { browseLocalModels, inspectLocalModel } from './local-models.mjs';
import { keepStreamAlive } from './stream-beat.mjs';
import { EventHub, InvalidJsonError, badRequest, error, json, readBody, readRaw, requestUrl, sameSecret, uid } from './util.mjs';
import { createUploads } from './chat-uploads.mjs';
import { createNativeDrops } from './native-drop.mjs';
import { RequestQueue } from './request-queue.mjs';
import { selectSkills, withSkills, historyWithSkills } from './skill-selection.mjs';
import { prepareOversized } from './oversize.mjs';
import { createChatFolders, chatRootOf, openFile, resolveChatFile, previewFile, rawFile, createAttachments } from './chat-files.mjs';
import { createUserRules, rulesFile } from './user-rules.mjs';
import { createSystemPrompt, systemPromptFile } from './system-prompt.mjs';
import { checkUpdates, checkAppUpdates, engineFirstRun } from './updates.mjs';
import { plainNoModel } from './no-model-text.mjs';
import { createAppUi } from './app-ui.mjs';
import { appVersionFrom, appVersionToShow } from './app-version.mjs';
import { createImageModels } from './image-models.mjs';
import { createRuntimeModels } from './runtime-models.mjs';
import { createNativeControl } from './native-control.mjs';
import { connectOpenCode } from './opencode-connect.mjs';
import { contentSecurityPolicy, foreignApiRequest, hostAllowed } from './request-guard.mjs';
import { OFFLINE_ON, readOffline } from './network-mode.mjs';
import { nativeUnloadPlan } from './storage-check.mjs';
import { installBundledEngine, cleanupAfterInstall } from './bundled-engine.mjs';
import { systemLocale } from './region.mjs';
import { createShellNotifier, DEFAULT_PORT, parsePortNotice, readShellPrefs, writeShellPrefs } from './shell-prefs.mjs';
import { findControl, createControl, componentsDirectory } from './control-runtime.mjs';
import { listEngines, changeEngine } from './engine-library.mjs';
import { forbidden as acquisitionForbidden } from './acquisition.mjs';
import { timingSafeEqual } from 'node:crypto';
import { nativeGateway } from './native-gateway.mjs';
import { nativeModelEntries } from './native-models.mjs';
import { proxyCompletion } from './inference.mjs';
import { apiPath } from './api-paths.mjs';
import { findFreePort, listenProblem } from './ports.mjs';
import { validateChatImages } from './chat-images.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const argv = process.argv.slice(2);
const distFlag = argv.indexOf('--dist');
// `STRATA_DIST` exists for carriers that load this module directly rather than starting it as its
// own process (the Electron app does that). Such a carrier cannot rely on `--dist`: when the host
// runs as the Electron main process, `process.argv` is Chromium's switch list and the host's own
// flags are not reliably present. An explicit environment variable is unambiguous, and the CLI
// `--dist` form keeps working unchanged.
const DIST = process.env.STRATA_DIST
  ? resolve(process.env.STRATA_DIST)
  : distFlag >= 0
    ? resolve(argv[distFlag + 1] ?? join(ROOT, 'dist'))
    : join(ROOT, 'dist');
const PORT = Number(process.env.STRATA_PORT ?? 8791);
const HOST = process.env.STRATA_BIND ?? '127.0.0.1';
/* The folder chats work in when nothing else is chosen. It is never the app's own folder (the host is started inside its install
   directory, so `process.cwd()` was "host" in the sidebar and chats could reach the app's files): the person's own
   Documents\Strata\Workspace (the models folder is next to it, not in it), created on first use, unless STRATA_WORKSPACE names one. */
function defaultWorkspace() {
  if (process.env.STRATA_WORKSPACE) return resolve(process.env.STRATA_WORKSPACE);
  const user = process.env.USERPROFILE ?? process.env.HOME ?? homedir();
  for (const base of workspaceBases(user)) {                // #3749: the Documents folder the models folder uses
    const dir = join(base, 'Strata', 'Workspace');
    try { mkdirSync(dir, { recursive: true }); return dir; } catch { /* try the next place */ }
  }
  return user;
}
const WORKSPACE = defaultWorkspace();
const WORKSPACE_NAME = process.env.STRATA_WORKSPACE ? basename(WORKSPACE) : 'Strata';
/** True for the app's own install/source folder or anything inside it. */
const insideApp = path => { const rel = relative(ROOT, resolve(path)); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };

const inFlightChatSaves = new Set();
const trackChatSave = fn => {
  const p = Promise.resolve().then(fn);
  const done = p.then(() => {}, () => {});
  inFlightChatSaves.add(done);
  done.finally(() => inFlightChatSaves.delete(done));
  return p;
};
const hub = new EventHub();
/** The chats, as files in the profile's data folder (chat-store.mjs). */
const chatStore = createChatStore({ dir: store.DATA_DIR, privateDir: makePrivateDir });
/* This fork has no cloud model APIs (privacy): an older install's saved connections, API keys included, are deleted. */
try { rmSync(join(store.DATA_DIR, 'model-providers.json'), { force: true }); } catch { /* not there, or not removable now */ }
const imageModels = createImageModels({ dataDir: store.DATA_DIR, modelsDir: () => store.MODELS_DIR, real: models.REAL, changed: value => hub.send('image-models', value) });
/* The installed app ships Strata Control (python + strata_control) next to the host; a source checkout has none and keeps its older paths. */
const CONTROL = findControl({ requireInstaller: true });
const control = createControl({ control: CONTROL, log: line => console.log(line) });
// Files a run as administrator made in Strata's own folders (owner Administrators) are given back to the user at every start; best effort, never blocks.
if (control && process.platform === 'win32' && !process.env.STRATA_NO_REPAIR_ACCESS) void control.repairAccess().catch(() => {});
/* Which window shows the page (the app window or, when that cannot run, a browser tab) and what only the app window can do: app-ui.mjs. */
const appUi = createAppUi({ shutdown: () => shutdown() });
/* The app's version has one source: the desktop shell passes it (STRATA_APP_VERSION, from app/desktop/src-tauri/Cargo.toml). Outside the app it is read from the same file in a checkout, else 'dev'. */
function appVersion() { return appVersionFrom({ env: process.env, here: HERE }); }
const appUpdater = appUi.updater;
const shellNotifier = createShellNotifier();
/** What the page needs for the desktop settings: whether this is the desktop app, the port in use, the saved choices and a busy-port notice. */
function shellState() {
  const saved = readShellPrefs();
  const desktop = !!shellNotifier;
  return {
    desktop,
    tray: desktop && process.platform !== 'linux',
    port: PORT, defaultPort: DEFAULT_PORT,
    pinnedPort: saved.port || null, minimizeToTray: saved.tray,
    portNotice: parsePortNotice(process.env.STRATA_PORT_NOTICE),
  };
}
/* The engine that ships inside the installer is put in the components folder when this PC has none (or an older one); no network, hashes checked. The model list waits for it. */
const bundledEngine = control && !process.env.STRATA_NO_BUNDLED_ENGINE
  ? installBundledEngine({ bundleDir: process.env.STRATA_ENGINE_BUNDLE_DIR || resolve(HERE, '..', '..', 'engine-bundle'), components: componentsDirectory(), log: line => console.log(line) })
  : Promise.resolve({ action: 'none' });
const engineBundleDir = process.env.STRATA_ENGINE_BUNDLE_DIR || resolve(HERE, '..', '..', 'engine-bundle');
/* An update from a per-GPU installer leaves its engine-bundle behind; it goes only when the same engine is complete in the store (sizes and hashes). */
cleanupAfterInstall(bundledEngine, { bundleDir: engineBundleDir, components: componentsDirectory() });
let bundledEngineSettled = !(control && !process.env.STRATA_NO_BUNDLED_ENGINE);
bundledEngine.then(() => { bundledEngineSettled = true; }, () => { bundledEngineSettled = true; });
/* A build made for another make of graphics card is not unpacked; Control's answer then carries the plain sentence (with the right download) instead of its own. */
let bundledWrongMake = null;
bundledEngine.then(result => { if (result?.action === 'wrong-make') { bundledWrongMake = result.notice; console.log(result.notice); } }, () => {});
if (control) {
  const engineOf = control.engine.bind(control);
  control.engine = async (...args) => {
    const answer = await engineOf(...args);
    return answer && !answer.usable && bundledWrongMake ? { ...answer, notice: bundledWrongMake, wrongMake: true } : answer;
  };
}
const native=createNativeControl({control,ready:bundledEngine,appUpdater,implicitDownloads:false,offline:()=>readOffline(componentsDirectory()),hardwareProbe:()=>(hardware.cachedHardware()?.gpus??[]).map((g,n)=>({index:g.index??n,vram_gb:g.vramGb})),directory:store.DATA_DIR,modelsDirectory:()=>store.MODELS_DIR,nativeDataDirectory:store.nativeDataDirectory,beforeLoad:async()=>{if(models.REAL&&models.library().loaded){if(serving.state().requests.some(r=>runtimeModels.state().instances.some(i=>i.id===r.instanceId)&&["queued","generating"].includes(r.state)))throw new Error("Finish requests before switching engines.");await models.unload();runtimeState();}},requests:()=>serving.state().requests,changed:value=>hub.send('native',value)});
let storageChanging = false;
let modelOperations = 0;
const requestQueue = new RequestQueue(n => monitor.queueWaiting(n));
// The supervisor raises its own event names; surface them on the client stream.
let runtimeModels;
const rawSend = hub.send.bind(hub);
hub.send = (event, payload) => {
  if (event === 'engine-status') rawSend('engine-status', payload);
  else if (event === 'engine-log') rawSend('log', payload);
  else if(event==='models' && runtimeModels){
    runtimeModels.adopt(payload.loaded,{beginner:store.get().beginner,expert:engine.params(),extra:store.get().configExtra??{}});
    rawSend('runtime',runtimeModels.state());rawSend(event,runtimeModels.libraryState(payload));
  } else rawSend(event, payload);
};

/* ------------------------------------------------------------------- boot --- */

const boot = await hardware.detect({ force: true });
models.init(hub);
engine.init(hub);
monitor.init(hub, boot);
monitor.setLiveProbe(() => native.hasLive());
serving.init(hub, { port: PORT, host: HOST });
runtimeModels=createRuntimeModels({hardware:()=>hardware.cachedHardware()??boot,library:()=>models.library(),requests:()=>serving.state().requests,real:models.REAL,changed:value=>{
  if(!models.REAL){const primary=value.instances.find(i=>i.id===value.defaultId);if(store.get().loaded!==(primary?.variantId??null))store.update({loaded:primary?.variantId??null});}
  rawSend('runtime',value);rawSend('models',runtimeModels.libraryState(models.library()));
}});
runtimeModels.adopt(models.library().loaded,{beginner:store.get().beginner,expert:engine.params(),extra:store.get().configExtra??{}});
function runtimeState(){
  if(models.REAL)runtimeModels.adopt(models.library().loaded,{beginner:store.get().beginner,expert:engine.params(),extra:store.get().configExtra??{}});
  return runtimeModels.state();
}

/* No start-up load: the remembered model of the real-engine mode was loaded through a llama.cpp llama-server (0.2.14, also for an imported
   GGUF nobody had loaded). Models run on the Strata engine, whose own start does not come through here. */
const backend = await detectBackend({ force: true });

console.log(`strata host  ·  http://${HOST}:${PORT}`);
console.log(`hardware     ·  ${boot.accelerator.label} / ${boot.accelerator.backend} / ${boot.cpu.cores} cores / ${Math.round(boot.memory.totalGb)} GB`);
const printInference = engine => console.log(`inference    ·  ${models.REAL ? inferenceLine({ backend, engine, settled: bundledEngineSettled }) : 'simulated (design iteration) — set STRATA_REAL_ENGINE=1 for a real engine'}`);
if (models.REAL && control && backend.kind === 'unavailable' && bundledEngineSettled) void control.engine().catch(() => null).then(printInference);
else printInference(null);
console.log(`models dir   ·  ${store.MODELS_DIR}`);
console.log(`workspace    ·  ${WORKSPACE}`);

/* ------------------------------------------------------------------- data --- */

function setupState() {
  const s = store.get();
  return {
    complete: !!s.setup.complete,
    dismissed: !!s.setup.dismissed,
    choices: s.setup.choices ?? {},
    step: s.setup.step ?? 1,
    flowVersion: 2,
    completedAt: s.setup.completedAt,
    history: s.setup.history ?? [],
    app: { version: appVersion(), modelsDir: store.MODELS_DIR, dataDir: store.DATA_DIR, modelsDirNotice: store.MODELS_DIR_NOTICE },
  };
}

/** Skills written in the Skills page of earlier versions live here (one folder each, SKILL.md inside); they still apply to plain chat. */
const CREATED_SKILLS = join(store.DATA_DIR, 'skills');

function skills() {
  const bundled = [
    {
      id: 'commit-messages',
      body: `Write the commit message for the staged change.

Subject line: conventional commits, imperative mood, at most 72 characters.
Body: one paragraph explaining why the change was made, not what changed —
the diff already says what changed. Wrap at 72 columns.

If the diff contains more than one unrelated change, say so instead of
inventing a single narrative for it.`,
      name: 'Commit messages',
      description: 'Writes conventional-commit messages from a diff, with a scope line and a why-paragraph.',
      source: 'bundled',
      enabled: true,
      triggers: ['commit', 'git message', 'stage these changes'],
      sizeKb: 3.2,
    },
    {
      id: 'code-review',
      body: `Review the code that follows and report findings.

Correctness first: wrong results, unhandled cases, races, resource leaks.
Then security. Then clarity. Style last, and only where it hides a bug.

For each finding give the line, what is wrong, and what would fix it. If the
code is fine, say that plainly rather than inventing minor notes to seem
useful. Never restate what the code does.`,
      name: 'Code review',
      description: 'Reviews a file or diff for correctness first, style second, and reports findings with line numbers.',
      source: 'bundled',
      enabled: true,
      triggers: ['review this', 'find bugs', 'check my code'],
      sizeKb: 5.6,
    },
    {
      id: 'release-notes',
      body: `Turn the merged commits into release notes a user would understand.

Group by Feature, Fix, and Breaking change. Write for someone who uses the
product, not someone who wrote it: no commit hashes, no internal file names,
no "refactored X".

Omit anything with no user-visible effect. If nothing user-visible shipped,
say so in one line rather than padding.`,
      name: 'Release notes',
      description: 'Turns merged commits into user-facing release notes grouped by feature, fix and breaking change.',
      source: 'bundled',
      enabled: false,
      triggers: ['release notes', 'changelog', 'what shipped'],
      sizeKb: 2.8,
    },
    {
      id: 'hardware-report',
      body: `Explain what this machine can run, in plain language.

Lead with the verdict: which model classes will run comfortably, which will be
tight, which will not fit. Then the evidence — CPU, accelerator, memory — in
that order of importance to the reader.

Avoid jargon a non-technical person would not know: "unified memory", not
"UMA"; "graphics memory", not "VRAM". Give sizes in GB and say what they mean
for the choice being made.`,
      name: 'Hardware report',
      description: 'Explains what this machine can run, in plain language, from the detected CPU, GPU and memory.',
      source: 'bundled',
      enabled: true,
      triggers: ['can this run', 'my hardware', 'how fast'],
      sizeKb: 2.1,
    },
  ];

  // Two places hold skills a person brought or wrote: the app's own folder (written in the Skills page) and the workspace's skills folder (added
  // with "Add skill"). Both are plain `<name>/SKILL.md` folders; the frontmatter (name, description) is optional.
  const extra = [];
  for (const [dir, source, prefix] of [[CREATED_SKILLS, 'created', 'my-'], [join(WORKSPACE, 'skills'), 'workspace', 'ws-']]) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      try { if (!statSync(full).isDirectory()) continue; } catch { continue; }
      let text = '', sizeKb = 1;
      const md = join(full, 'SKILL.md');
      try { text = readFileSync(md, 'utf8'); sizeKb = Math.max(0.1, statSync(md).size / 1024); } catch { /* a folder with no SKILL.md is listed but has nothing to show */ }
      const parsed = parseSkillFile(text);
      extra.push({
        id: `${prefix}${name}`,
        name: parsed.title ?? name.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase()),
        description: parsed.description ?? (source === 'created' ? 'A skill you wrote.' : `Workspace skill loaded from ${name}/SKILL.md`),
        source,
        enabled: true,
        triggers: [name.replace(/-/g, ' ')],
        body: parsed.body,
        sizeKb: Number(sizeKb.toFixed(1)),
      });
    }
  }
  return [...bundled, ...extra].map(s => ({ ...s, ...store.get().skillEdits?.[s.id] }));
}

let skillState = skills().map((s) => ({
  ...s,
  // `enabled` is the standing answer; `onlyIn` narrows it to one workspace.
  // A skill written for one project is noise in another, and a plain on/off
  // switch cannot express "here but not there".
  enabled: store.get().skillPreferences?.[s.id]?.enabled ?? s.enabled,
  onlyIn: store.get().skillPreferences?.[s.id]?.onlyIn ?? null,
  useCount: 0,
  lastUsedAt: null,
}));

/**
 * Records which enabled skills a prompt actually triggered.
 *
 * The triggers were decorative: nothing consulted them, so a skill's list was a
 * claim the product could not back up. Matching them here is what makes "used in
 * N conversations" possible rather than invented.
 */
function noteSkillUse(selected) {
  const hit = new Set(selected.map(s => s.id));
  skillState = skillState.map((s) => {
    if (!hit.has(s.id)) return s;
    return { ...s, useCount: (s.useCount ?? 0) + 1, lastUsedAt: new Date().toISOString() };
  });
  if (hit.size) hub.send('skills', skillState);
}

const execFileAsync = promisify(execFile);

/* ---------------------------------------------------------------- prompt ---
   What Strata puts in front of every conversation. Counted so the context
   breakdown can show where the window actually goes rather than reporting a
   single opaque total. */
// Strata's own prompt lives in system-prompt.mjs: the built-in text, or the person's own from Settings > System prompt.

/**
 * Files a tool proposal could plausibly name.
 *
 * Scanned from the workspace so the demo proposes something that exists — it
 * used to name `README.md` unconditionally, including on machines with none.
 */
function readableCandidates(root = WORKSPACE, depth = 3) {
  const out = [];
  const walk = (dir, at) => {
    if (at > depth || out.length > 60) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length > 60) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      const rel = full.slice(root.length + 1);
      if (e.isDirectory()) walk(full, at + 1);
      else if (/\.(md|txt|json|ts|tsx|mjs|js|css)$/.test(e.name)) out.push(rel);
    }
  };
  walk(root, 0);
  return out;
}

/* ------------------------------------------------------------- workspaces ---
   The host used to expose exactly one root, taken from the environment. A
   sidebar that offers "add a workspace" over a single-root host would be a lie,
   so the roots are now a small persisted registry. The original root is always
   first and cannot be removed, which keeps existing sessions and file paths
   valid. */
const WORKSPACES_FILE = join(store.DATA_DIR, 'workspaces.json');

function loadWorkspaces() {
  try {
    const parsed = JSON.parse(readFileSync(WORKSPACES_FILE, 'utf8'));
    if (Array.isArray(parsed) && parsed.length) {
      // An earlier version saved the app's own folder as the first workspace. The first entry keeps its id (chats point at it) and moves to the default folder.
      if (parsed[0]?.id === 'root' && typeof parsed[0].path === 'string' && insideApp(parsed[0].path)) parsed[0] = { ...parsed[0], aliases: [...new Set([...(parsed[0].aliases ?? []), parsed[0].path])], path: WORKSPACE, name: WORKSPACE_NAME };
      return parsed;
    }
  } catch {
    /* first run */
  }
  return [{ id: 'root', name: WORKSPACE_NAME, path: WORKSPACE }];
}

let workspaces = loadWorkspaces();
/* The folder each chat works in ("Select a folder"). */
const chatAttachments = createAttachments();
const nativeDrops = createNativeDrops();
const uploads = createUploads({ dir: join(store.DATA_DIR, 'uploads'), folderOf: chatId => chatRoot(chatId), attachments: chatAttachments });
try { uploads.sweep(); } catch { /* best effort */ }
const chatFolders = createChatFolders({ file: join(store.DATA_DIR, 'chat-folders.json') });
/* The person's own rules for every answer (#5084), added to the chat's prompt. */
const userRules = createUserRules({ file: rulesFile(store.DATA_DIR) });
const systemPrompt = createSystemPrompt({ file: systemPromptFile(store.DATA_DIR) });
/** Where a chat's files are: its chosen folder, else the default workspace (chat-files.mjs). One source for every file route. */
const chatRoot = chatId => chatRootOf({ chosen: chatFolders.get(chatId), fallback: workspaces[0]?.path ?? WORKSPACE });

function saveWorkspaces() {
  try {
    mkdirSync(store.DATA_DIR, { recursive: true });
    writeFileSync(WORKSPACES_FILE, JSON.stringify(workspaces, null, 2));
  } catch (err) {
    console.warn('workspaces · could not persist', err.message);
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.npm-cache', '.strata', '.shots', 'dist', '.vite', '__pycache__', '.cache']);

function workspaceListing(root = WORKSPACE) {
  const entries = [];
  const walk = (dir, prefix = '', depth = 0) => {
    if (depth > 2) return;
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.slice(0, 60)) {
      if (SKIP_DIRS.has(name) || name.startsWith('.DS')) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const rel = prefix ? `${prefix}/${name}` : name;
      if (st.isDirectory()) {
        entries.push({ path: rel, kind: 'dir' });
        walk(full, rel, depth + 1);
      } else {
        entries.push({ path: rel, kind: 'file', sizeKb: st.size / 1024, updatedAt: st.mtime.toISOString() });
      }
    }
  };
  walk(root);
  entries.sort((a, b) =>
    a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'dir' ? -1 : 1,
  );
  return { path: root, entries };
}

/* ----------------------------------------------------------------- chat io --- */

function clientName(req) {
  const ua = req.headers['user-agent'] ?? '';
  const header = req.headers['x-strata-client'];
  if (typeof header === 'string' && header) return header;
  if (/curl/i.test(ua)) return 'curl';
  if (/python|httpx|requests/i.test(ua)) return 'Python client';
  if (/node|undici|axios/i.test(ua)) return 'Node client';
  if (/strata/i.test(ua)) return 'Strata chat';
  return 'Local client';
}

async function runTurn({ message, history = [], onFrame, signal, client, workspaceId = null, sessionId = null, runtimeModelId = undefined, nativeModelId, images=[], useTools=false, thinking='medium', thinkingBudget=0 }) {
  if(native.hasLive()||nativeModelId){
    let instance;try{instance=native.resolveInstance(nativeModelId??native.state().defaultId);}catch(e){const message=plainNoModel(e.message);onFrame({type:'error',message});return {error:message};}const started=Date.now(),cancel=new AbortController();
    const entry=serving.open({client:client??'Strata chat',endpoint:'/chat/completions',model:instance.apiModelId,instanceId:instance.id,gpuIds:instance.gpus.map(String),cancel:()=>cancel.abort()});
    try{serving.mark(entry.id,{state:'generating'});const applied=selectSkills(skillState,message,workspaceId);const hy4Local=instance.arch==='hy4flash'||/^hy4-flash/i.test(String(instance.model??instance.apiModelId??''));const inklingLocal=instance.arch==='inkling2_loop'||/^inkling-2-mini/i.test(String(instance.model??instance.apiModelId??''));const thinkKey=String(thinking).toLowerCase();const effortWord=hy4Local?(thinkKey==='xhigh'?'max':({off:'none',minimal:'high',low:'high',medium:'high',high:'high',max:'max'}[String(thinking).toLowerCase()]??'high')):inklingLocal?({off:'none',xhigh:'max',minimal:'minimal'}[thinkKey]??thinkKey):({off:'none',max:'high'}[String(thinking).toLowerCase()]??(thinkKey==='xhigh'?'high':thinkKey));const result=await proxyCompletion({baseUrl:`http://127.0.0.1:${instance.port}/v1`,modelId:instance.apiModelId,authorization:instance.key,message:withSkills(skillState,message,workspaceId),history:historyWithSkills(skillState,history,workspaceId),images,extra:{...(thinkingBudget>0&&String(thinking).toLowerCase()!=='off'?{reasoning_budget_tokens:thinkingBudget}:{}),reasoning_effort:effortWord},systemPrompt:[systemPrompt.current(),userRules.promptBlock()].filter(Boolean).join('\n\n'),signal:signal?AbortSignal.any([signal,cancel.signal]):cancel.signal,onFrame:frame=>onFrame({...frame,requestId:entry.id,model:instance.label,contextMax:instance.metrics?.engine?.max_context??instance.context,skills:applied.map(s=>s.name)})});serving.mark(entry.id,{...result,usageSource:result.usageSource});serving.finish(entry.id,{tokensOut:result.tokensOut,durationMs:Date.now()-started});return result;}catch(e){serving.finish(entry.id,{durationMs:Date.now()-started,error:e.message});onFrame({type:'error',message:e.message,requestId:entry.id});return {error:e.message};}
  }
  runtimeState();
  let instance;
  try{instance=runtimeModels.resolve(runtimeModelId,{chatDefault:runtimeModelId===undefined});}
  catch(err){onFrame({type:'error',message:err.message});return {error:err.message};}
  const v = variant(instance.variantId);

  if (!v) {
    onFrame({ type: 'error', message: 'No model is loaded. Pick one in Models, then try again.' });
    return;
  }

  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const entry = serving.open({ client: client ?? 'Strata chat', endpoint: '/chat/completions', model: instance.apiModelId, instanceId:instance.id, gpuIds:instance.gpuIds, cancel: () => controller.abort(new DOMException('Cancelled by the user', 'AbortError')) });
  const started = Date.now();
  let result = { tokensIn: null, tokensOut: null };
  // Time to first token: the gap between asking and the first token arriving.
  let firstTokenMs = null;

  try {
    onFrame({ type: 'queued', requestId: entry.id });
    await (models.REAL?requestQueue:runtimeModels.queue(instance.id)).run(requestSignal, async () => {
      requestSignal.throwIfAborted();
      if(!runtimeModels.state().instances.some(i=>i.id===instance.id))throw new Error('This model was unloaded before dispatch.');
      runtimeModels.update(instance.id,{phase:'reading'});
      // Scope is resolved again at dispatch: a disabled skill never stays active
      // merely because the request waited in the queue.
      const appliedSkills = selectSkills(skillState, message, workspaceId);
      const chatPrompt = [systemPrompt.current(), userRules.promptBlock()].filter(Boolean).join('\n\n');
      serving.mark(entry.id, { state: 'generating' });
      const contextMax = instance.memory.context;
      const modelMonitor=models.REAL?monitor:{
        progressOutput:()=>{},
        beginReading:(total)=>runtimeModels.update(instance.id,{phase:'reading',prompt:{done:0,total,pct:0}}),
        progressReading:(done)=>{const total=runtimeModels.state().instances.find(i=>i.id===instance.id)?.prompt.total??0;runtimeModels.update(instance.id,{prompt:{done,total,pct:total?done/total*100:0}});},
        beginGenerating:()=>runtimeModels.update(instance.id,{phase:'generating'}),
        beginThinking:()=>runtimeModels.update(instance.id,{phase:'thinking'}),
      };
      try {
        result = await streamChat({
          message: withSkills(skillState, message, workspaceId),
          history: historyWithSkills(skillState, history, workspaceId),
          systemPrompt: chatPrompt,
          modelLabel: v.label,
          candidates: readableCandidates(),
          onFrame: (frame) => {
            if(frame.type==='stats'||frame.type==='done')modelMonitor.progressOutput(frame.tokensOut);
            // Time to first *token*. A `tool` frame is a proposal, not generated
            // output, and it arrives before the prompt is even read — counting it
            // reported a 0ms first token. The stream emits `delta` for both
            // reasoning and content; the real-engine path also reports ttftMs
            // itself on the done frame.
            if (firstTokenMs === null && (frame.type === 'delta' || frame.type === 'reasoning')) {
              firstTokenMs = Date.now() - started;
            }
            if (frame.type === 'done' && typeof frame.ttftMs === 'number') firstTokenMs = frame.ttftMs;
            if (frame.type === 'start') {
              // Demo responses cannot demonstrate that instructions affected a model.
              if (!frame.demo) noteSkillUse(appliedSkills);
              serving.mark(entry.id, { tokensIn: frame.promptTokens ?? null, usageSource: frame.demo ? 'demo' : 'unavailable' });
            }
            if (frame.type === 'done') {
              serving.mark(entry.id, { tokensIn: frame.tokensIn, tokensOut: frame.tokensOut, usageSource: frame.usageSource });
            }
            onFrame({ ...frame, ...(frame.type==='done'?{ttftMs:firstTokenMs}:{}), requestId: entry.id, model: v.label, contextMax, ...(frame.type === 'start' ? { skills: frame.demo ? [] : appliedSkills.map(s => s.name) } : {}) });
          },
          signal: requestSignal,
          engine: {
            variantId: v.id,
            beginReading: (tokens, id) => modelMonitor.beginReading(tokens, id),
            progressReading: (done) => modelMonitor.progressReading(done),
            beginGenerating: () => modelMonitor.beginGenerating(),
            beginThinking: () => modelMonitor.beginThinking(),
          },
        });
        requestSignal.throwIfAborted();
        serving.mark(entry.id,{cachedTokens:result.cachedTokens??null,tps:result.tps??null,promptTps:result.promptTps??null,hitRate:result.hitRate??null,pcieShare:result.pcieShare??null,finishReason:result.finishReason??null});
        serving.finish(entry.id, {
          tokensOut: result.tokensOut,
          durationMs: Date.now() - started,
        });
        runtimeModels.update(instance.id,{phase:'idle',outputTps:result.tps??0,promptTps:result.promptTps??0,context:{usedTokens:(result.tokensIn??0)+(result.tokensOut??0),maxTokens:contextMax,pct:((result.tokensIn??0)+(result.tokensOut??0))/contextMax*100}});
        if(models.REAL)monitor.record({
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          durationMs: Date.now() - started,
          ttftMs: firstTokenMs ?? undefined,
          cachedTokens: result.cachedTokens,
          tps: result.tps,
          usageSource: result.usageSource,
        });
        if(models.REAL){monitor.setRecordedContext({ ...result, requestId: entry.id, sessionId });monitor.idle();}
      } catch (error) {
        runtimeModels.update(instance.id,{phase:'idle'});
        if(models.REAL)monitor.idle(requestSignal.aborted ? 'Request cancelled' : 'Last request failed');
        throw error;
      }
    });
    return result;
  } catch (err) {
    const message = requestSignal.aborted ? 'Request cancelled. Partial output is preserved.' : err.message;
    serving.finish(entry.id, { durationMs: Date.now() - started, error: message });
    onFrame({ type: 'error', message, requestId: entry.id });
    return { error: message };
  }
}

// `HERE` is app/host/server, so the repository root is three levels up (server -> host -> app); the Terminal's sources are in its terminal/.
const REPO_ROOT = CONTROL ? CONTROL.dir : resolve(HERE, '..', '..', '..', 'terminal');
// The interpreter that drives the job is the same one the launcher would pick, named explicitly so
// a packaged run uses the runtime the bundle carries rather than whatever `python3` resolves to.
const PYTHON = resolvePython({ repo: REPO_ROOT, control: CONTROL });
const TS_PYTHON = PYTHON.command;
/**
 * Tuning, from the App Host.
 *
 * The job contract is Strata Control's (`strata_control/tuning.py`) and is driven through
 * `strata tune`. Two things the UI needs and neither is computable here:
 *
 *   * **what a sweep would search, and why the rest was excluded** — that depends on the selected
 *     engine binary's own flag list, so it is asked of the CLI rather than guessed;
 *   * **recorded jobs and their reports** — read from the job's durable `job.json`.
 *
 * There is deliberately no "run a sweep" route yet. A sweep needs a measurement harness that boots
 * the engine with each candidate, and inventing measurements is exactly what the handoff forbids.
 * The plan and the report are real; the sweep is gated on that harness.
 */
function createTuning({ repoRoot, python, pythonArgs = [], env = process.env } = {}) {
  const cli = join(repoRoot, 'strata.py');
  const stateDir = () => tuningDir(env);

  function runCli(args) {
    return new Promise((resolve) => {
      const child = spawn(python, [...pythonArgs, cli, ...args, '--output', 'json'], {
        cwd: repoRoot, windowsHide: true, env: { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', STRATA_TUNE_DIR: stateDir() },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout.on('data', (b) => { out += b.toString(); });
      child.stderr.on('data', (b) => { err += b.toString(); });
      child.on('error', (e) => resolve({ ok: false, error: e.message }));
      child.on('close', (code) => {
        let parsed = null;
        try { parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? ''); } catch { parsed = null; }
        if (!parsed) return resolve({ ok: false, code, error: err.trim() || out.trim() || `exit ${code}` });
        resolve({ ok: Boolean(parsed.ok), code, envelope: parsed });
      });
    });
  }

  return {
    stateDir,
    /** The reviewable plan for one backend/engine pair. */
    async plan({ engine, backend, model, objective = 'generation', trials = 16, repeats = 3 }) {
      if (!engine || !backend) return { ok: false, code: 2, error: 'engine and backend are required' };
      const r = await runCli(['tune', 'plan', '--engine', engine, '--backend', backend,
        '--model', model ?? 'unknown', '--objective', objective,
        '--trials', String(Math.max(0, Math.min(512, Number(trials) || 16))),
        '--repeats', String(Math.max(1, Math.min(10, Number(repeats) || 3)))]);
      return r.ok ? { ok: true, plan: r.envelope.plan } : { ok: false, code: r.code, error: r.error };
    },
    /** Recorded jobs, newest state only: the durable record is the authority. */
    jobs() {
      const root = stateDir();
      if (!existsSync(root)) return [];
      const out = [];
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = join(root, entry.name, 'job.json');
        if (!existsSync(file)) continue;
        try {
          const data = JSON.parse(readFileSync(file, 'utf8'));
          out.push({
            id: data.id, state: data.state,
            backend: data.plan?.backend ?? null, objective: data.plan?.objective ?? null,
            trials: data.report?.trials_run ?? null,
            recommendation: data.report?.recommendation_available === true,
            reason: data.report?.reason ?? null,
            startedAt: data.started_at ?? null, finishedAt: data.finished_at ?? null,
          });
        } catch {
          // A partially written record is skipped rather than reported as an empty job.
        }
      }
      return out;
    },
    job(id) {
      if (!/^[0-9a-f]{8,64}$/.test(String(id ?? ''))) return null;
      const file = join(stateDir(), id, 'job.json');
      if (!existsSync(file)) return null;
      try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
    },
  };
}

const tuning = createTuning({ repoRoot: REPO_ROOT, python: TS_PYTHON, pythonArgs: PYTHON.args });

const tasks = createTaskService({
  read: () => store.get().tasks ?? [],
  write: records => store.update({ tasks: records }),
  notify: task => hub.send('task', { id: task.id, title: task.title, status: task.status, attention: task.attention ?? null, error: task.error ?? null }),
  run: async (task, signal) => {
    let text = '', failure = null, demo = !models.REAL;
    await runTurn({ message: task.prompt, signal, client: `Task: ${task.title}`, onFrame: frame => {
      if (frame.type === 'delta') text += frame.text ?? '';
      if (frame.type === 'start') demo = !!frame.demo;
      if (frame.type === 'error') failure = frame.message;
    }});
    if (failure) throw new Error(failure);
    signal.throwIfAborted();
    if (!text) throw new Error('The model returned no answer.');
    return { text, demo };
  },
});
const taskTimer = setInterval(() => tasks.tick(), 15000);
taskTimer.unref();

// The share and tunnel listeners take a free port (the next ones above the host's own) instead of a fixed PORT+1 / PORT+2 that Docker, WSL or Hyper-V may hold or reserve.
// The probe listens on the loopback address only: a probe on 0.0.0.0 made Windows Defender Firewall ask "Allow Node.js to communicate on these networks?" on the
// first start of every new install path (QA 0213). Reserved or taken ports are caught on any address; the share listener itself binds 0.0.0.0 only when the person turns sharing on.
const sharePort = await findFreePort(Number(process.env.STRATA_SHARE_PORT ?? PORT + 1), '127.0.0.1', { skip: [PORT] });
const localShare = createLocalShare({ handle: (req, res, path, method) => openai(req, res, path, method, 'share'), hasKey: () => !!store.get().serving?.apiKey, port: sharePort, allowResponses: true, changed: () => serving.setSharing(localShare.state()) });
const tunnelPort = await findFreePort(Number(process.env.STRATA_TUNNEL_PORT ?? PORT + 2), '127.0.0.1', { skip: [PORT, sharePort] });
const tunnelOrigin = createLocalShare({ handle: (req, res, path, method) => openai(req, res, path, method, 'tunnel'), hasKey: () => !!store.get().serving?.apiKey, host: '127.0.0.1', port: tunnelPort });
const connector = createConnectorInstaller({ directory: join(store.HOME, 'engine', 'cloudflare'), componentDirectory: join(componentsDirectory(), 'cloudflared') });
const cloudflare = createCloudflare({ origin: tunnelOrigin, originUrl: `http://127.0.0.1:${tunnelPort}`, hasKey: () => !!store.get().serving?.apiKey, changed: serving.setTunnel, locate: connector.locate, prepareConnector: connector.ensure, connectorInfo: connector.connector, findRunning: findRunningConnector });
await cloudflare.inspect();

/* --------------------------------------------------------------- routing --- */

const server = http.createServer(async (req, res) => {
  const url = requestUrl(req);
  if (!url) return badRequest(res);   // #4397: a bad Host or request target is a 400, never an unhandled rejection
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // Privacy audit 2026-11-24: a name pointed at this computer (DNS rebinding) is not this host, and only the model API (/v1/, its own rules in
  // openai()) may be read by a page of another origin; the host's own API never carries CORS headers.
  if (!hostAllowed(url)) return error(res, 403, 'Open Strata at 127.0.0.1 or localhost.');
  if (path.startsWith('/v1/')) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization, x-api-key, x-strata-client');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  }
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (path.startsWith('/api/') && foreignApiRequest(req)) return error(res, 403, 'Open the local Strata app to use host controls.');
    if (path.startsWith('/api/')) {
      const modelOperation = !['GET', 'OPTIONS'].includes(method) && /^\/api\/(models|local-models|runtime|image-models|engine|native)(\/|$)/.test(path) && !['/api/runtime/plan', '/api/engine/validate', '/api/local-models/inspect'].includes(path);
      if (modelOperation) modelOperations++;
      try { return await api(req, res, path, method, url); }
      finally { if (modelOperation) modelOperations--; }
    }
    if (path.startsWith('/v1/')) {
      if (storageChanging && method !== 'GET') return error(res, 409, 'Wait for the model folder check to finish.');
      return await openai(req, res, apiPath(path), method, 'app');
    }
    return await staticFile(req, res, path);
  } catch (err) {
    console.error('[strata]', err);
    if (res.headersSent) { res.end(); return; }   // a stream already began: it ends here (a second writeHead would throw out of this handler and end the process)
    error(res, 500, err.message ?? 'Internal error');
  }
});

async function api(req, res, path, method, url) {
  if(path==='/api/fonts'&&method==='GET')return json(res,200,await systemFonts());
  // --- chats: one file each in the data folder -----------------------------
  // Not held back by a model folder move: saving a chat has nothing to do with the models. A page must name itself (x-strata-client), which
  // a web page from another site cannot do without the browser asking the host first.
  const chatsRoute = /^\/api\/chats(?:\/([^/]+))?$/.exec(path);
  if (chatsRoute) {
    if (!req.headers['x-strata-client']) return error(res, 403, 'Not allowed.');
    let id = null;
    try { id = chatsRoute[1] ? decodeURIComponent(chatsRoute[1]) : null; } catch { return error(res, 400, 'That is not a chat id.', { code: 'bad-id' }); }
    const from = typeof req.headers['x-strata-window'] === 'string' ? req.headers['x-strata-window'].slice(0, 64) : null;
    try {
      if (!id && method === 'GET') return json(res, 200, chatStore.list());
      if (id === 'import' && method === 'POST') {
        const result = await trackChatSave(async () => {
          const body = JSON.parse((await readRaw(req, 512 * 1024 * 1024)).toString('utf8') || '{}');
          return chatStore.importMany(body.sessions);
        });
        for (const imported of result.imported) hub.send('chats', { id: imported, rev: chatStore.rev(imported), from });
        return json(res, 200, result);
      }
      if (id && method === 'GET') {
        const text = await chatStore.read(id);
        if (text === null) return error(res, 404, 'No such chat.', { code: 'not-found' });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
        res.end(text);
        return undefined;
      }
      if (id && method === 'PUT') {
        const saved = await trackChatSave(async () => {
          const text = (await readRaw(req, 256 * 1024 * 1024)).toString('utf8');
          const base = req.headers['x-strata-base-rev'];
          return chatStore.save(id, text, { baseRev: typeof base === 'string' && /^\d+$/.test(base) ? Number(base) : null });
        });
        hub.send('chats', { id, rev: saved.rev, from });
        return json(res, 200, saved);
      }
      if (id && method === 'DELETE') {
        const removed = await trackChatSave(() => chatStore.remove(id));
        hub.send('chats', { id, deleted: true, from });
        return json(res, 200, removed);
      }
    } catch (e) {
      const failure = e instanceof SyntaxError ? { status: 400, message: 'The request must be JSON.', code: 'bad-json' } : storeFailure(e);
      return error(res, failure.status, failure.message, { code: failure.code });
    }
    return error(res, 405, 'Method not allowed.');
  }
  if (storageChanging && !['GET', 'OPTIONS'].includes(method)) return error(res, 409, 'Wait for the model folder check to finish.');
  // --- events -------------------------------------------------------------
  if (path === '/api/events') return hub.add(res);
  if(path.startsWith('/api/native')){try{
  if(path==='/api/native'&&method==='GET')return json(res,200,await native.refresh(url.searchParams.get('refresh')==='1'));
  if(path==='/api/native'&&method==='PATCH')return json(res,200,await native.configure(await readBody(req)));
  if(path==='/api/native/ram-reserve'&&method==='GET')return json(res,200,native.ramReserve());
  if(path==='/api/native/ram-reserve'&&method==='POST')return json(res,200,native.saveRamReserve((await readBody(req))?.gib));
  if(path==='/api/native/model-port'&&method==='GET')return json(res,200,native.modelPort());
  if(path==='/api/native/model-port'&&method==='POST')return json(res,200,native.saveModelPort((await readBody(req))?.port??null));
  if(path==='/api/native/prompt-cache-spread'&&method==='GET')return json(res,200,native.promptCacheSpread());
  if(path==='/api/native/prompt-cache-spread'&&method==='POST')return json(res,200,native.savePromptCacheSpread((await readBody(req))?.enabled??null));
  if(path==='/api/native/directory'&&method==='POST')return json(res,200,native.setDownloadDirectory((await readBody(req)).directory));
  /* Settings > Storage > Models folder: pick (or type) a folder, say what it means, then start the choice. Copying is Control's (strata models move). */
  if(path==='/api/native/models-folder/plan'&&method==='POST'){
   const typed=await typedFolder((await readBody(req)).path,{isAbsolute});
   const picked=typed?{path:typed}:await chooseFolder('Choose a folder for your models');
   if(picked.unavailable){const u=chooserUnavailable(picked);return error(res,501,u.message,{code:u.code});}
   if(picked.cancelled)return json(res,200,{cancelled:true});
   return json(res,200,{plan:await native.planModelsFolder(picked.path)});}
  if(path==='/api/native/models-folder/start'&&method==='POST'){const body=await readBody(req);const result=await native.startModelsFolder({folder:body.path,choice:body.choice,stopRunning:body.stopRunning===true});return json(res,result.id?202:200,result);}
  if(path==='/api/native/models-folder/interrupted'&&method==='GET')return json(res,200,{interrupted:await native.interruptedMove()});
  if(path==='/api/native/models-folder/resume'&&method==='POST'){const body=await readBody(req);return json(res,202,await native.finishInterruptedMove({stopRunning:body.stopRunning===true}));}
  if(path==='/api/native/models-folder/leave'&&method==='POST')return json(res,200,await native.leaveInterruptedMove());
  if(path==='/api/native/plan'&&method==='POST')return json(res,200,await native.plan(await readBody(req)));
  if(path==='/api/native/operations'&&method==='POST'){if(storageChanging)return error(res,409,'Wait for the model folder check to finish.');const body=await readBody(req);return json(res,202,native.operation(body.kind,body.args));}
  if(path==='/api/native/engine-restart/dismiss'&&method==='POST')return json(res,200,native.dismissRestart());
  if(path==='/api/native/request-record'&&method==='GET'){const id=url.searchParams.get('id')??'';if(!/^[0-9a-f]{12}$/.test(id))return error(res,400,'Unknown request.');try{return json(res,200,await native.requestRecord(url.searchParams.get('instanceId')??undefined,id));}catch{return json(res,200,{status:'gone'});}}
  if(path==='/api/native/logs'&&method==='GET')return json(res,200,{logs:native.logs()});
  if(path==='/api/native/logs/save'&&method==='POST'){
   /* Diagnostics to a file: the engine messages the app kept, failed operations, and the tail of each model's server log under Control.
      Written to the user's Downloads folder (the window cannot save a download); the path is returned to show. */
   const NL=String.fromCharCode(10);
   const lines=[`Strata diagnostics ${new Date().toISOString()}`,`Version ${native.state().version??'unknown'}`,'','== Engine messages =='];
   for(const l of native.logs())lines.push(`${l.at} ${l.instanceId}: ${l.line}`);
   lines.push('','== Operations ==');for(const j of native.state().jobs)lines.push(`${j.startedAt} ${j.kind} ${j.state}${j.error?`: ${j.error}`:''}${j.details?`${NL}  ${j.details}`:''}`);
   try{const logs=join(dirname(componentsDirectory()),'logs');const names=readdirSync(logs).filter(n=>/^desktop-.*\.log$/.test(n)).sort();const crash=names.filter(n=>n.startsWith('desktop-crash-')).slice(-3).reverse();const runs=names.filter(n=>!n.startsWith('desktop-crash-')).slice(-2).reverse();lines.push('',`== Desktop shell: window crash logs (${crash.length} newest) ==`);for(const n of crash)lines.push('',`-- ${n}`,readFileSync(join(logs,n),'utf8'));lines.push('',`== Desktop shell: last lines of the newest ${runs.length} run logs ==`);for(const n of runs)lines.push('',`-- ${n}`,...readFileSync(join(logs,n),'utf8').split(NL).slice(-300));}catch{/* no desktop logs (not the Linux app, or no crash) */}
   try{const runtime=process.env.STRATA_RUNTIME_DIR??join(dirname(componentsDirectory()),'runtime');for(const name of readdirSync(runtime).filter(n=>n.endsWith('.server.log'))){lines.push('',`== ${name} (last lines) ==`,...readFileSync(join(runtime,name),'utf8').split(NL).slice(-200));}}catch{/* no server logs yet */}
   const folder=process.env.STRATA_EXPORT_DIR||join(process.env.USERPROFILE??process.env.HOME??homedir(),'Downloads');mkdirSync(folder,{recursive:true});
   const file=join(folder,`strata-diagnostics-${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.txt`);writeFileSync(file,lines.join(NL),'utf8');
   return json(res,200,{path:file});}
  if(path==='/api/native/local/preview'&&method==='POST'){
   /* "Use a local GGUF": pick (or type) the folder or file (.gguf / .strata), and Control says what is in it. Nothing is copied or changed. */
   const typed=await typedFolder((await readBody(req)).path,{isAbsolute,fileType:/\.(gguf|strata)$/i});
   const picked=typed?{path:typed}:await chooseFolder('Choose the folder that holds your GGUF files');
   if(picked.unavailable){const u=chooserUnavailable(picked);return error(res,501,u.message,{code:u.code});};
   if(picked.cancelled)return json(res,200,{cancelled:true});
   return json(res,200,{path:picked.path,preview:await native.localPreview(picked.path)});}
  if(path==='/api/native/benchmark'&&method==='GET')return json(res,200,native.benchmarkReport());
  /* The auto-tuner's saved tunings (Strata Control's presets, shared with the Terminal). Starting a tune or a re-check is POST /api/native/operations with kind autotune / recheck. */
  if(path==='/api/native/tune/status'&&method==='GET')return json(res,200,await native.tuneStatus({model:url.searchParams.get('model'),resourceProfile:url.searchParams.get('resourceProfile')||undefined,vision:url.searchParams.get('vision')||undefined}));
  if(path==='/api/native/tune/effective'&&method==='GET')return json(res,200,await native.tuneEffective({model:url.searchParams.get('model'),resourceProfile:url.searchParams.get('resourceProfile')||undefined,vision:url.searchParams.get('vision')||undefined}));
  if(path==='/api/native/tune/off'&&method==='POST'){const body=await readBody(req);return json(res,200,await native.tuneOff({model:body.model,resourceProfile:body.resourceProfile,vision:body.vision}));}
  if(path==='/api/native/tune/presets'&&method==='GET')return json(res,200,await native.tunePresets.list());
  if(path==='/api/native/tune/undo'&&method==='POST'){const body=await readBody(req);return json(res,200,await native.tunePresets.undoFor({model:body.model,resourceProfile:body.resourceProfile,vision:body.vision}));}
  const tunePreset=/^\/api\/native\/tune\/presets\/([0-9a-f]{8,32})\/(apply|rename|delete|undo)$/.exec(path);
  if(tunePreset&&method==='POST')return json(res,200,await native.tunePresets.action(tunePreset[2],tunePreset[1],await readBody(req)));
  const nativeOperation=/^\/api\/native\/operations\/([a-z0-9-]+)\/cancel$/.exec(path);
  if(nativeOperation&&method==='POST')return json(res,200,await native.cancel(nativeOperation[1]));
  const nativeInstance=/^\/api\/native\/instances\/([a-z0-9-]+)\/(unload|default)$/.exec(path);
  if(nativeInstance&&method==='POST')return json(res,200,nativeInstance[2]==='unload'?await native.unload(nativeInstance[1]):native.setDefault(nativeInstance[1]));
  const nativeSettings=/^\/api\/native\/models\/([a-z0-9_.-]+)\/settings$/.exec(path);
  /* Expert mode shows what will actually run: the saved tuning's values come with the settings (null when none applies or unreadable). */
  if(nativeSettings&&method==='GET'){const settings=native.settings(nativeSettings[1]);let tuned=null;try{const t=await native.tuneEffective({model:nativeSettings[1],resourceProfile:url.searchParams.get('resourceProfile')||undefined,vision:url.searchParams.get('vision')||undefined});tuned=t.applied?t:null;}catch{tuned=null;}return json(res,200,{...settings,tuned,hints:await native.settingsHints?.(nativeSettings[1])});}
  if(nativeSettings&&method==='PATCH')return json(res,200,native.save(nativeSettings[1],await readBody(req)));
  // Fork: "Connect OpenCodeFork" writes this model (its API name is the model id) into OpenCodeFork's config; the same model again replaces its entry
  const nativeOpenCode=/^\/api\/native\/models\/([a-z0-9_.-]+)\/opencode$/.exec(path);
  if(nativeOpenCode&&method==='POST'){const body=await readBody(req);return json(res,200,connectOpenCode({model:nativeOpenCode[1],name:typeof body?.name==='string'?body.name:undefined,context:body?.context??openCodeContext(nativeOpenCode[1]),baseURL:`http://127.0.0.1:${PORT}/v1`,apiKey:store.get().serving?.apiKey||undefined}));}
  function openCodeContext(id){try{const saved=Number(native.settings(id)?.values?.context);if(saved>0)return saved;}catch{}return native.state().instances.find(i=>i.model===id||i.apiModelId===id)?.context||undefined;}
  const nativeSettingsFile=/^\/api\/native\/models\/([a-z0-9_.-]+)\/settings-file$/.exec(path);
  if(nativeSettingsFile&&method==='GET')return json(res,200,native.settingsFile(nativeSettingsFile[1]));
  if(nativeSettingsFile&&method==='POST')return json(res,200,await native.openSettingsFile(nativeSettingsFile[1]));

  // Credentials are handled only on the host. Responses and events expose a key-set flag.
  return error(res,404,'Unknown native control action.');}catch(e){return error(res,/Finish|Unload|running|current operation/.test(e.message)?409:400,e.message,{...(e.code&&typeof e.code==='string'?{code:e.code}:{}),...(e.details?{details:String(e.details)}:{})});}}

  if(path === '/api/artifacts/open' && method === 'POST') {
    const body=await readBody(req, 30*1024*1024);
    try { return json(res,200,await openArtifact(body,{examplesDir:join(ROOT,'public','examples'),previewsDir:join(store.HOME,'previews')})); }
    catch (e) { if (e?.status === 400) return error(res, 400, e.message); throw e; }
  }

  // Host-owned recurring prompts. Creating a draft never enables a schedule.
  // ------------------------------------------------------------------- Tuning
  //
  // The review surface and the recorded reports. Both are real: the plan is computed from the
  // selected engine binary's own flag list, and a report is read from the job's durable record.
  // There is no run route, because a sweep needs a measurement harness that does not exist yet and
  // a fabricated measurement is worse than no measurement.
  if (path === '/api/tune/plan' && method === 'POST') {
    const body = await readBody(req);
    const result = await tuning.plan({
      engine: String(body.engine ?? '').trim(),
      backend: String(body.backend ?? '').trim(),
      model: body.model ? String(body.model) : undefined,
      objective: body.objective, trials: body.trials, repeats: body.repeats,
    });
    if (!result.ok) return error(res, result.code === 2 ? 400 : 502, result.error);
    return json(res, 200, { plan: result.plan });
  }
  if (path === '/api/tune/engine' && method === 'GET') {
    // The plan is only meaningful for a real engine binary, so the panel asks rather than guessing.
    // `available` is false when nothing is installed, which is a state the panel must show honestly
    // instead of offering a plan that cannot be computed.
    const status = supervisor.status();
    return json(res, 200, {
      available: false,   // the host starts no engine binary of its own (no llama-server)
      path: null,
      backend: status?.backend ?? null,
      running: Boolean(status?.running),
    });
  }
  if (path === '/api/tune/jobs' && method === 'GET') {
    return json(res, 200, { jobs: tuning.jobs(), stateDir: tuning.stateDir() });
  }
  if (path === '/api/tune/job' && method === 'GET') {
    const job = tuning.job(url.searchParams.get('id'));
    if (!job) return error(res, 404, 'No such tuning job.');
    return json(res, 200, { job });
  }

  if (path === '/api/tasks' && method === 'GET') return json(res, 200, { tasks: tasks.list() });
  if (path === '/api/tasks/draft' && method === 'POST') {
    const body = await readBody(req);
    const description = String(body.description ?? '').trim().slice(0, 12000);
    if (!description) return error(res, 400, 'Describe the task first.');
    let draft = { title: description.slice(0, 70), prompt: description, frequency: /week/i.test(description) ? 'weekly' : /hour/i.test(description) ? 'hourly' : 'daily', at: '09:00', weekday: 1, timeZone: body.timeZone ?? 'UTC', enabled: true };
    if (models.REAL) {
      let text = '', failure = null;
      await runTurn({ message: 'Draft a recurring prompt task from the description below. Return only JSON with title (short), prompt (self-contained; text reasoning only, no file, web, email or external tools), frequency (hourly/daily/weekdays/weekly), at (HH:MM), weekday (0 Sunday to 6 Saturday). Do not claim to execute it. Description: ' + description, signal: AbortSignal.timeout(120000), client: 'Task drafting', onFrame: frame => { if (frame.type === 'delta') text += frame.text ?? ''; if (frame.type === 'error') failure = frame.message; } });
      if (failure) return error(res, 400, failure);
      try { draft = { ...draft, ...JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()), timeZone: body.timeZone ?? 'UTC', enabled: true }; }
      catch { return error(res, 400, 'The model did not return a usable draft. Try again or set up manually.'); }
    }
    try { return json(res, 200, { draft: validateTask(draft), demo: !models.REAL }); }
    catch (e) { return error(res, 400, e.message); }
  }
  if (path === '/api/tasks' && method === 'POST') {
    try { return json(res, 201, tasks.put(await readBody(req))); } catch(e) { return error(res, 400, e.message); }
  }
  const taskRoute = path.match(/^\/api\/tasks\/([^/]+)(?:\/(run|stop))?$/);
  if (taskRoute) {
    const [, id, action] = taskRoute;
    if (!tasks.list().some(t => t.id === id)) return error(res, 404, 'Task not found.');
    try {
      if (method === 'PATCH' && !action) return json(res, 200, tasks.put(await readBody(req), id));
      if (method === 'POST' && action === 'run') { if (tasks.list().find(t => t.id === id)?.archived) return error(res, 400, 'Restore this task first.'); void tasks.execute(id); return json(res, 202, { accepted:true }); }
      if (method === 'POST' && action === 'stop') { tasks.stop(id); return json(res, 200, { stopped:true }); }
    } catch (e) { return error(res, 400, e.message); }
  }

  // --- health / setup -----------------------------------------------------
  if (path === '/api/health') {
    return json(res, 200, {
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      backend: currentBackend(),
      engine: supervisor.status(),
      clients: hub.size,
    });
  }

  // --- Strata Control: what the installed app runs on, and what it will not do ---------------------
  if (path === '/api/control/status' && method === 'GET') {
    const engine = control ? await control.engine().catch(e => ({ usable: false, notice: e.message })) : null;
    // the first start copies the engine that came with the app (about a minute): say so instead of "no engine"
    if (engine && !engine.usable && !bundledEngineSettled) engine.notice = 'The engine that came with the app is being set up. This takes a minute the first time.';
    const shapeEngines = Array.isArray(engine?.shapes)
      ? engine.shapes.map(s => ({ shape: s.shape, component: s.component, usable: s.usable === true, version: s.engine?.version ?? null, backend: s.engine?.backend ?? null }))
      : [];
    const anyUsableEngine = Boolean(engine?.usable) || shapeEngines.some(s => s.usable);
    return json(res, 200, {
      packaged: process.env.STRATA_PACKAGED === '1',
      control: control ? { dir: control.control.dir, python: control.control.python, version: control.version, bundle: control.control.bundle } : null,   // control.control: the Control in use now (a first-run update can switch it)
      engine,
      shapeEngines,
      anyUsableEngine,
      engineSetup: !bundledEngineSettled,
      componentsDir: componentsDirectory(),
      acquisition: { forbidden: acquisitionForbidden(), env: process.env.STRATA_NO_ACQUIRE ?? null },
    });
  }
  // The shell (and nothing else) holds the secret that lets it end the host or tell it which window is in use.
  const fromShell = () => {
    const token = process.env.STRATA_SHUTDOWN_TOKEN ?? '';
    return token.length >= 32 && sameSecret(req.headers['x-strata-shutdown'], token);
  };
  // Which window the person is using: the page shows "Quit Strata" in browser mode only.
  if (path === '/api/app/mode' && method === 'GET') return json(res, 200, appUi.state());
  if (path === '/api/app/quit' && method === 'POST') {
    // A web page cannot send this header without the browser asking the host first, and the host refuses pages that are not local (above).
    if (!req.headers['x-strata-client']) return error(res, 403, 'Not allowed.');
    const verdict = appUi.quit();
    return verdict.ok ? json(res, verdict.status, { stopping: true }) : error(res, verdict.status, verdict.error);
  }
  // The shell: the window process registers its updater; or the window could not run and everything moves to a browser tab.
  if (path === '/api/control/ui' && method === 'POST') {
    if (!fromShell()) return error(res, 403, 'Not allowed.');
    const body = await readBody(req);
    try {
      if (body.bridge) appUi.setBridge(body.bridge);
      if (body.mode === 'browser') return json(res, 200, await appUi.switchToBrowser({ url: `http://127.0.0.1:${PORT}/`, reason: body.reason, notice: typeof body.notice === 'string' ? body.notice.slice(0, 300) : '', openPage: body.open !== false }));
      if (body.open === true) return json(res, 200, { ...appUi.state(), opened: await appUi.openPage(`http://127.0.0.1:${PORT}/`) });
      return json(res, 200, appUi.state());
    } catch (err) { return error(res, 400, err.message); }
  }
  // The shell asks for a clean stop (engines this app started are stopped through Control) before it ends the process.
  if (path === '/api/control/shutdown' && method === 'POST') {
    if (!fromShell()) return error(res, 403, 'Not allowed.');
    json(res, 202, { stopping: true });
    setImmediate(() => void shutdown());
    return;
  }

  // Files dropped on the app window (Linux, macOS): the shell hands over the paths, the page fetches each file once (native-drop.mjs).
  if (path === '/api/app/drop' && method === 'POST') {
    if (!fromShell()) return error(res, 403, 'Not allowed.');
    try { return json(res, 200, { files: await nativeDrops.add((await readBody(req)).paths) }); } catch (err) { return error(res, 400, err.message); }
  }
  const dropGet = /^\/api\/app\/drop\/([0-9a-f-]{36})$/.exec(path);
  if (dropGet && method === 'GET') {
    const file = nativeDrops.take(dropGet[1]);
    if (!file) return error(res, 404, 'That file is no longer available. Drop it again.');
    res.writeHead(200, { 'content-type': file.type, 'content-length': file.bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(file.bytes); return undefined;
  }

  if (path === '/api/setup' && method === 'GET') return json(res, 200, setupState());
  if (path === '/api/engine/first-run' && method === 'GET') {
    if (readOffline(componentsDirectory())) return json(res, 200, { status: 'offline', gpus: [] });
    if (!control?.updateCheck) return json(res, 200, { status: 'unavailable', gpus: [] });
    const info = await engineFirstRun({ control, gpus: hardware.cachedHardware()?.gpus ?? [] });
    try { let at = componentsDirectory(); while (at && !existsSync(at) && dirname(at) !== at) at = dirname(at); const f = statfsSync(at); info.freeBytes = Number(f.bavail) * Number(f.bsize); } catch { /* unknown: no warning */ }
    return json(res, 200, info);
  }
  if (path === '/api/engines' && method === 'GET') {
    const { status, body } = await listEngines(control);
    return json(res, status, body);
  }
  if ((path === '/api/engines/use' || path === '/api/engines/remove') && method === 'POST') {
    const { status, body } = await changeEngine(control, path.endsWith('/use') ? 'use' : 'remove', await readBody(req), { modelsRunning: () => native.state().instances.length > 0 });
    if (status === 200) Promise.resolve(native.refresh?.(true)).catch(() => { /* the next poll reads it */ });
    return json(res, status, body);
  }
  if (path === '/api/engine/job' && method === 'GET') {
    // The newest engine download / file install, read without waiting for the native snapshot to connect (the first-run card needs it before that).
    const kinds = ['update-engine', 'install-engine-file'];
    return json(res, 200, { job: native.state().jobs.filter(j => kinds.includes(j.kind)).slice(-1)[0] ?? null });
  }
  if (path === '/api/engine/from-file' && method === 'POST') {
    // The person chose an engine package in the page (the offline path). The bytes come here; Control checks and installs them.
    const name = String(req.headers['x-file-name'] ?? 'engine.tar.gz').replace(/[^A-Za-z0-9._-]/g, '_').slice(-120);
    if (!/\.(tar\.gz|tgz|tar\.xz|zip)$/i.test(name)) return error(res, 400, 'This is not a Strata engine package. Choose the .tar.gz or .zip file from the release page.');
    const folder = join(store.DATA_DIR, 'incoming-engine');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const target = join(folder, name);
    await pipeline(req, createWriteStream(target, { mode: 0o600 }));
    return json(res, 202, native.operation('install-engine-file', { path: target }));
  }
  // This fork: the packaged app updates only through its own signed updater (no signed feed; the engine ships inside the installer).
  if (path === '/api/updates/check' && method === 'GET' && readOffline(componentsDirectory())) return error(res, 409, OFFLINE_ON);
  if (path === '/api/updates/check' && method === 'GET' && control?.updateCheck && appUpdater) return json(res, 200, await checkAppUpdates({ appUpdater, appVersion: process.env.STRATA_APP_VERSION || null, engineVersion: native.state().installed?.engine?.version ?? null }));
  if (path === '/api/updates/check' && method === 'GET') return json(res, 200, await checkUpdates({ appVersion:appVersionToShow(setupState().app.version,native.state().version), engineVersion:native.state().available?(native.state().installed?.engine?.version??null):(await engine.config()).engine.version }));

  if (path === '/api/setup/step' && method === 'POST') {
    const body = await readBody(req);
    const s = store.get();
    const step = Math.max(1, Math.min(4, migrateSetup({ step: body.step, flowVersion: body.flowVersion }).step));
    store.update({
      setup: { ...s.setup, flowVersion: 2, complete: false, step, dismissed: !!body.dismissed, choices: { ...s.setup.choices, ...body.choices }, history: [...(s.setup.history ?? []), { step, at: new Date().toISOString() }] },
    });
    const next = setupState();
    hub.send('setup', next);
    return json(res, 200, next);
  }

  if (path === '/api/setup/complete' && method === 'POST') {
    const s = store.get();
    if (!models.library().loaded&&!native.hasLive()) return error(res, 409, 'Load a model before completing setup.');
    store.update({ setup: { ...s.setup, dismissed: false, complete: true, flowVersion: 2, step: 4, completedAt: new Date().toISOString() } });
    const next = setupState();
    hub.send('setup', next);
    return json(res, 200, next);
  }

  // --- hardware -----------------------------------------------------------
  if (path === '/api/hardware') {
    const force = url.searchParams.get('reprobe') === '1';
    const hw = await hardware.detect({ force });
    if (force) monitor.init(hub, hw);
    return json(res, 200, hw);
  }

  // --- models -------------------------------------------------------------
  if (path === '/api/local-models/browse' && method === 'GET') {
    const shortcuts = [{name:'Model directory',path:store.MODELS_DIR},{name:'Home',path:process.env.USERPROFILE??process.env.HOME}].filter(s=>s.path);
    try { return json(res, 200, { ...browseLocalModels(url.searchParams.get('directory') ?? store.MODELS_DIR), shortcuts }); }
    catch (err) { return error(res, 400, err.message); }
  }
  if (path === '/api/local-models/inspect' && method === 'POST') {
    try { const body=await readBody(req); return json(res,200,inspectLocalModel(body.path)); }
    catch (err) { return error(res,400,err.message); }
  }
  if (path === '/api/local-models' && method === 'POST') {
    const body=await readBody(req);
    if(storageChanging)return error(res,409,'Wait for the model folder check to finish.');
    try {
      const preview=inspectLocalModel(body.path),previous=variant(preview.variant.id);
      if(body.name!==undefined){if(typeof body.name!=='string'||!body.name.trim()||body.name.length>160)return error(res,400,'Enter a display name up to 160 characters.');preview.variant.name=body.name.replace(/[\x00-\x1f\x7f]/g,' ').trim();if(!preview.variant.name)return error(res,400,'Enter a display name.');preview.variant.label=`${preview.variant.name} · ${preview.variant.quant}`;}
      if(previous && runtimeModels.hasVariant(previous.id) && JSON.stringify(previous.local)!==JSON.stringify(preview.variant.local))return error(res,409,'Unload this local model before replacing its file reference.');
      localModels.add(preview);
      return json(res,200,{library:runtimeModels.libraryState(models.localModelAdded()),variantId:preview.variant.id});
    } catch (err) { return error(res,400,err.message); }
  }
  if (path === '/api/storage/models-directory' && method === 'POST') {
    const body = await readBody(req);
    if (store.MODELS_FIXED) return error(res, 409, 'Models are kept in the models folder of the Strata installation.');
    let directory;
    try { directory = store.validateModelsDirectory(body.directory); }
    catch (err) { return error(res, 400, err.message); }
    const changed = directory !== store.MODELS_DIR;
    const instances = runtimeState().instances;
    if (storageChanging || modelOperations || models.directoryBusy() || imageModels.busy()||native.state().jobs.some(j=>j.state==='running')) return error(res, 409, 'Finish or cancel model downloads and loading before changing the folder.');
    if (serving.state().requests.some(r => ['queued', 'generating'].includes(r.state))) return error(res, 409, 'Finish or cancel model requests before changing the folder.');
    if (changed && instances.length && body.unload !== true) return error(res, 409, 'Unload the current models before changing the folder.');
    const nativePlan=nativeUnloadPlan({changed,unload:body.unload,instances:native.state().instances});
    if(nativePlan.refuse)return error(res,409,nativePlan.refuse);
    for(const id of nativePlan.ids)await native.unload(id);
    storageChanging = true;
    try {
      if (changed) {
        if (models.REAL) await models.unload();
        else for (const instance of instances) runtimeModels.unload(instance.id);
        store.changeModelsDirectory(directory);
        engine.markStopped(); monitor.idle('Model directory changed');
      }
      models.init(hub);
      const images = await imageModels.rescan(changed);
      const hw = await hardware.detect({ force: true });
      const library = runtimeModels.libraryState(models.library());
      hub.send('models', library); hub.send('setup', setupState()); hub.send('engine', await engine.config());
      return json(res, 200, { library, imageModels: images, runtime: runtimeState(), hardware: hw, setup: setupState() });
    } catch (err) { return error(res, 400, err.message); }
    finally { storageChanging = false; hub.send('models', models.library()); hub.send('setup', setupState()); }
  }
  if (path === '/api/image-models' && method === 'GET') return json(res, 200, imageModels.library());
  if (path === '/api/image-models' && method === 'PATCH') {
    const body = await readBody(req);
    return json(res, 200, imageModels.select(body.selected));
  }
  if (path === '/api/image-models/apply' && method === 'POST') return json(res, 200, imageModels.apply());
  const imageMatch = /^\/api\/image-models\/(q4|q5|q6|q8)\/(install|cancel)$/.exec(path);
  if (imageMatch && method === 'POST') {
    const [, id, action] = imageMatch;
    return json(res, 200, action === 'install' ? imageModels.install(id) : await imageModels.cancel(id));
  }
  if(path==='/api/runtime' && method==='GET')return json(res,200,runtimeState());
  if(path==='/api/runtime/plan' && method==='POST')return json(res,200,runtimeModels.plan(await readBody(req)));
  if(path==='/api/runtime/load' && method==='POST'){
    const body=await readBody(req);const checked=await engine.validate({...body.config,variantId:body.variantId});
    if(storageChanging)return error(res,409,'Wait for the model folder check to finish.');
    if(!checked.ok)return error(res,400,checked.issues.filter(i=>i.level==='error').map(i=>i.message).join(' '));
    if(models.REAL)return error(res,409,'This native host supports one model on automatic GPU placement.');
    try{const plan=runtimeModels.plan(body);if(!plan.allowed)return error(res,409,'This model does not fit the selected setup.');for(const instance of native.state().instances)await native.unload(instance.id);return json(res,200,runtimeModels.load(body));}catch(err){return error(res,409,err.message);}
  }
  const runtimeMatch=/^\/api\/runtime\/([^/]+)\/(unload|default)$/.exec(path);
  if(runtimeMatch && method==='POST'){
    const [,id,action]=runtimeMatch;runtimeState();
    if(models.REAL && action==='unload'){
      const instance=runtimeModels.state().instances.find(i=>i.id===id);
      if(!instance)return error(res,404,'This model is no longer loaded.');
      if(serving.state().requests.some(r=>r.instanceId===id && ['queued','generating'].includes(r.state)))return error(res,409,'Finish or cancel this model’s requests first.');
      await models.unload();engine.markStopped();hub.send('engine',await engine.config());runtimeState();return json(res,200,runtimeState());
    }
    try{return json(res,200,action==='unload'?runtimeModels.unload(id):runtimeModels.setDefault(id));}
    catch(err){return error(res,409,err.message);}
  }
  if (path === '/api/models' && method === 'GET') return json(res, 200, runtimeModels.libraryState(models.library()));

  const modelMatch = /^\/api\/models\/([^/]+)(?:\/(install|cancel|load))?$/.exec(path);
  if (modelMatch) {
    const [, id, action] = modelMatch;
    if (method === 'DELETE') {if(runtimeModels.hasVariant(id))return error(res,409,'Unload every instance of this model before deleting its files.');return json(res, 200, runtimeModels.libraryState(models.remove(id)));}
    if (method === 'POST' && action === 'install') { try { return json(res, 200, runtimeModels.libraryState(await models.install(id))); } catch (err) { return error(res, err.status ?? 500, err.message); } }
    if (method === 'POST' && action === 'cancel') return json(res, 200, runtimeModels.libraryState(models.cancel(id)));
    if (method === 'POST' && action === 'load') {
      const hw = await hardware.detect();
      if(storageChanging)return error(res,409,'Wait for the model folder check to finish.');
      if(!models.REAL){
        const config={beginner:store.get().beginner,expert:engine.params(),extra:store.get().configExtra??{}};
        const gpuIds=config.expert.find(p=>p.id==='gpu.layers')?.value==='CPU only'?[]:hw.gpus.map(g=>g.id??`${g.vendor}:${g.index}`);
        try{const choice={variantId:id,gpuIds,config,executionMode:'single'};const plan=runtimeModels.plan(choice);if(!plan.allowed)throw new Error('This model does not fit the selected setup.');for(const instance of native.state().instances)await native.unload(instance.id);runtimeModels.load(choice);}
        catch(err){return error(res,409,err.message);}
        await monitor.setModel(id);engine.markRunning(hw.accelerator.backend);hub.send('engine',await engine.config());
        return json(res,200,runtimeModels.libraryState(models.library()));
      }
      // Strata's own engine only: 0.2.14 started a llama.cpp llama-server here (an imported GGUF, the starter list) in the real-engine mode
      return error(res,409,'Strata runs models only on its own engine, so this model can\'t load here. Open Models and choose a model there, or use "Use a local GGUF…" for a file you already have.');
    }
  }

  if (path === '/api/models/unload' && method === 'POST') {
    if(!models.REAL && runtimeModels.state().defaultId){runtimeModels.unload(runtimeModels.state().defaultId);return json(res,200,runtimeModels.libraryState(models.library()));}
    const lib = await models.unload({ onPhase: () => monitor.idle('Model unloaded') });
    engine.markStopped();
    hub.send('engine', await engine.config());
    return json(res, 200, runtimeModels.libraryState(lib));
  }

  // --- engine -------------------------------------------------------------
  if (path === '/api/engine' && method === 'GET') return json(res, 200, await engine.config());
  if (path === '/api/engine' && method === 'PATCH') {
    const body = await readBody(req);
    const checked = await engine.validate(body);
    if (!checked.ok) return error(res, 400, checked.issues.filter(i => i.level === 'error').map(i => i.message).join(' '));
    const cfg = await engine.patch(body);
    if (body.beginner?.contextLength) {
      monitor.setContextMax(CONTEXT_TOKENS[body.beginner.contextLength] ?? 32768);
    }
    return json(res, 200, cfg);
  }
  if (path === '/api/engine/restart' && method === 'POST') {
    monitor.idle('Engine restarting');
    const cfg = await engine.restart();
    monitor.setModel(store.get().loaded);
    return json(res, 200, cfg);
  }
  if (path === '/api/engine/reset' && method === 'POST') return json(res, 200, await engine.reset());
  if (path === '/api/engine/validate' && method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, await engine.validate(body ?? {}));
  }
  if (path === '/api/engine/status' && method === 'GET') return json(res, 200, supervisor.status());
  if (path === '/api/engine/logs' && method === 'GET') {
    return json(res, 200, {
      logs: supervisor.logs(Number(url.searchParams.get('limit') ?? 200)),
      status: supervisor.status(),
    });
  }
  if (path === '/api/engine/stop' && method === 'POST') {
    const status = await supervisor.stop();
    store.update({ loaded: null });
    monitor.idle('Model unloaded');
    engine.markStopped();
    hub.send('engine', await engine.config());
    hub.send('models', models.library());
    return json(res, 200, status);
  }
  if (path === '/api/engine/export' && method === 'GET') return json(res, 200, await engine.exportConfig());

  // --- serving ------------------------------------------------------------
  if (path === '/api/serving/tunnel' && method === 'GET') return json(res, 200, await cloudflare.inspect());
  if (path === '/api/serving/tunnel' && method === 'POST') {
    try { const body = await readBody(req); if (body.action === 'stop') await cloudflare.stop(); else if (body.action === 'start') await cloudflare.start(body); else if (body.action === 'prepare') await cloudflare.prepare(); else throw new Error('Unknown tunnel action.'); return json(res, 200, serving.state()); }
    catch(e) { return error(res, 400, e.message); }
  }
  if (path === '/api/monitor/snapshot' && method === 'POST') {
    try { const body = await readBody(req, 25 * 1024 * 1024); return json(res, 200, await saveSnapshot(body.data)); }
    catch(e) { return error(res, 400, e.message); }
  }
  if (path === '/api/serving/share' && method === 'POST') {
    try { const body = await readBody(req); if (body.enabled === true) await localShare.start(); else await localShare.stop(); return json(res, 200, serving.state()); }
    catch(e) { return error(res, 400, e.message); }
  }
  if (path === '/api/serving' && method === 'GET') return json(res, 200, serving.state());
  if (path === '/api/serving' && method === 'PATCH') {
    const body = await readBody(req);
    return json(res, 200, serving.patch(body));
  }
  const cancelMatch = /^\/api\/serving\/requests\/([^/]+)\/cancel$/.exec(path);
  if (cancelMatch && method === 'POST') return json(res, 200, serving.cancel(cancelMatch[1]));

  // --- monitor ------------------------------------------------------------
  if (path === '/api/monitor') { monitor.watch(); if (url.searchParams.get('drives') === '1') monitor.watchDrives(); return json(res, 200, monitor.snapshot()); }

  // --- workspace ----------------------------------------------------------
  if (path === '/api/workspace') {
    const root = url.searchParams.get('root');
    const found = root ? workspaces.find((w) => w.id === root) : null;
    // A stale id from a saved session falls back to the primary root rather than
    // erroring, so a removed folder cannot break the app.
    return json(res, 200, workspaceListing(found?.path ?? WORKSPACE));
  }

  // --- workspaces ---------------------------------------------------------
  // Read one file for the preview pane. Bounded deliberately: only inside a
  // registered workspace, only text, only up to a size that can be shown.
  if (path === '/api/workspace/file') {
    const rootId = url.searchParams.get('root');
    const rel = url.searchParams.get('path') ?? '';
    const root = (rootId ? workspaces.find((w) => w.id === rootId)?.path : null) ?? WORKSPACE;
    const target = resolve(root, rel);
    // A relative path may not escape its workspace.
    if (target !== resolve(root) && !target.startsWith(resolve(root) + '/')) {
      return error(res, 400, 'That file is outside the workspace.');
    }
    let st;
    try {
      st = statSync(target);
    } catch {
      return error(res, 404, "That file doesn't exist any more.");
    }
    if (!st.isFile()) return error(res, 400, "That's a folder, not a file.");
    const LIMIT = 200 * 1024;
    if (st.size > LIMIT) {
      return json(res, 200, { path: rel, tooLarge: true, sizeKb: st.size / 1024, text: '' });
    }
    let text = '';
    try {
      text = readFileSync(target, 'utf8');
    } catch {
      return json(res, 200, { path: rel, binary: true, sizeKb: st.size / 1024, text: '' });
    }
    // A NUL byte in the first block is the usual signal for a binary file.
    if (text.slice(0, 1024).includes('\u0000')) {
      return json(res, 200, { path: rel, binary: true, sizeKb: st.size / 1024, text: '' });
    }
    return json(res, 200, { path: rel, text, sizeKb: st.size / 1024, updatedAt: st.mtime.toISOString() });
  }

  // Strata's system prompt: the built-in text until the person saves their own. A save names the revision it read.
  if (path === '/api/system-prompt' && method === 'GET') return json(res, 200, systemPrompt.read());
  if (path === '/api/system-prompt' && method === 'PUT') {
    const body = await readBody(req);
    try { return json(res, 200, systemPrompt.write(body.text, body.revision)); } catch (e) { return error(res, e.status ?? 400, e.message, e.code ? { code: e.code } : {}); }
  }

  // The person's own rules for every answer (#5084). A save names the revision it read; another window's newer save is never overwritten.
  if (path === '/api/rules' && method === 'GET') return json(res, 200, userRules.read());
  if (path === '/api/rules' && method === 'PUT') {
    const body = await readBody(req);
    try { return json(res, 200, userRules.write(body.text, body.revision)); } catch (e) { return error(res, e.status ?? 400, e.message, e.code ? { code: e.code } : {}); }
  }

  // The folder a chat works in, and opening its files by path (notes-split-agent8.md).
  if (path === '/api/chat/folder' && method === 'GET') {
    const id = url.searchParams.get('sessionId') ?? '';
    return json(res, 200, { folder: chatFolders.info(id), default: workspaces[0]?.path ?? WORKSPACE });
  }
  if (path === '/api/chat/folder' && method === 'POST') {
    const body = await readBody(req);
    const id = String(body.sessionId ?? '');
    if (!id) return error(res, 400, 'sessionId is required');
    if (body.path === null || body.path === '') { chatFolders.clear(id); return json(res, 200, { folder: null }); }
    try { return json(res, 200, { folder: chatFolders.set(id, body.path) }); } catch (e) { return error(res, 400, e.message); }
  }
  if (path === '/api/files/open' && method === 'POST') {
    const body = await readBody(req);
    try { return json(res, 200, openFile(chatRoot(String(body.sessionId ?? '')), body.path, String(body.how ?? 'app'))); }
    catch (e) { return error(res, e.code === 'outside' ? 403 : 400, e.message); }
  }
  /* Files and pictures dropped or pasted into a chat: multipart, a JSON data address, or raw bytes. A picture comes back with an id the next message names (imageIds). */
  if (path === '/api/chat/upload' && method === 'POST') {
    const sid = url.searchParams.get('sessionId') ?? '';
    if (!sid) return error(res, 400, 'sessionId is required');
    try { const body = await readRaw(req); return json(res, 200, { files: uploads.accept(sid, { body, contentType: req.headers['content-type'], name: url.searchParams.get('name') }) }); }
    catch (e) { return error(res, e.code === 'too-big' ? 413 : 400, e.message); }
  }
  const uploadGet = /^\/api\/chat\/upload\/([0-9a-f-]{36})$/.exec(path);
  if (uploadGet && method === 'GET') {
    const img = uploads.image(uploadGet[1]);
    if (!img) return error(res, 404, 'That picture is no longer available.');
    res.writeHead(200, { 'content-type': img.type, 'content-length': img.bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(img.bytes); return undefined;
  }
  if (path === '/api/files/preview' && method === 'GET') {
    const sid = url.searchParams.get('sessionId') ?? '';
    try { return json(res, 200, previewFile(chatRoot(sid), url.searchParams.get('path'), sid)); }
    catch (e) { return error(res, e.code === 'outside' ? 403 : 400, e.message); }
  }
  if (path === '/api/files/raw' && method === 'GET') {
    try { const f = rawFile(chatRoot(url.searchParams.get('sessionId') ?? ''), url.searchParams.get('path')); res.writeHead(200, { 'content-type': f.mime, 'content-length': f.bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(f.bytes); return undefined; }
    catch (e) { return error(res, e.code === 'outside' ? 403 : 400, e.message); }
  }
  /* A message too large for the model's window, made small enough to send: its text as a file in the chat's folder, or a shortened preview (oversize.mjs). */
  if (path === '/api/chat/oversize' && method === 'POST') {
    const body = await readBody(req, 12 * 1024 * 1024);
    const text = String(body.text ?? '');
    if (!text.trim()) return error(res, 400, 'text is required');
    let instance = null;
    try { instance = native.resolveInstance(body.nativeModelId ?? native.state().defaultId); } catch { /* no local model: the length alone decides */ }
    try { return json(res, 200, await prepareOversized({ mode: body.mode === 'file' ? 'file' : 'preview', text, root: chatRoot(String(body.sessionId ?? '')), instance })); }
    catch (e) { return error(res, 400, 'The message could not be prepared. Try a shorter message.'); }
  }
  /* "Attach as context": the file is named in the next message of the chat, so the assistant reads it again. */
  if (path === '/api/chat/attachments' && method === 'GET') return json(res, 200, { files: chatAttachments.list(url.searchParams.get('sessionId') ?? '') });
  if (path === '/api/chat/attachments' && method === 'POST') {
    const body = await readBody(req); const id = String(body.sessionId ?? '');
    try { const file = resolveChatFile(chatRoot(id), body.path); return json(res, 200, { files: body.remove === true ? chatAttachments.remove(id, file) : chatAttachments.add(id, file) }); }
    catch (e) { return error(res, e.code === 'outside' ? 403 : 400, e.message); }
  }
  if (path === '/api/files/path' && method === 'GET') {
    try { const p = resolveChatFile(chatRoot(url.searchParams.get('sessionId') ?? ''), url.searchParams.get('path')); return json(res, 200, { path: p }); }
    catch (e) { return error(res, e.code === 'outside' ? 403 : 400, e.message); }
  }
  if (path === '/api/workspaces' && method === 'GET') {
    return json(res, 200, { workspaces });
  }

  if (path === '/api/workspaces' && method === 'POST') {
    const body = await readBody(req);
    const target = resolve(String(body.path ?? '').trim().replace(/^~/, store.HOME));
    if (!target) return error(res, 400, 'Choose a folder first.');
    let st;
    try {
      st = statSync(target);
    } catch {
      return error(res, 400, "That folder doesn't exist.");
    }
    if (!st.isDirectory()) return error(res, 400, "That's a file, not a folder.");
    if (workspaces.some((w) => w.path === target)) {
      return error(res, 400, 'That folder is already in your workspaces.');
    }
    const ws = {
      id: `ws_${Math.random().toString(36).slice(2, 8)}`,
      name: basename(target) || target,
      path: target,
    };
    workspaces = [...workspaces, ws];
    saveWorkspaces();
    return json(res, 200, ws);
  }

  /* A workspace's name is only what the sidebar shows; its folder stays. */
  if (path.startsWith('/api/workspaces/') && method === 'PATCH') {
    const id = path.split('/')[3];
    const body = await readBody(req);
    const name = String(body.name ?? '').trim().slice(0, 80);
    if (!name) return error(res, 400, 'Type a name for this workspace.');
    const at = workspaces.findIndex(w => w.id === id);
    if (at < 0) return error(res, 404, 'That workspace is not in your list.');
    workspaces = workspaces.map((w, i) => (i === at ? { ...w, name } : w));
    saveWorkspaces();
    return json(res, 200, workspaces[at]);
  }

  if (path.startsWith('/api/workspaces/') && method === 'DELETE') {
    const id = path.split('/')[3];
    if (id === workspaces[0]?.id) {
      return error(res, 400, 'The first workspace cannot be removed.');
    }
    workspaces = workspaces.filter((w) => w.id !== id);
    saveWorkspaces();
    return json(res, 200, { ok: true });
  }

  // A native folder chooser. Asking someone who finds computers daunting to type
  // an absolute path is not a real option, so this borrows the system dialog.
  if (path === '/api/workspaces/pick' && method === 'POST') {
    try {
      const typed = await typedFolder((await readBody(req)).path, { isAbsolute });
      const picked = typed ? { path: typed } : await chooseFolder('Choose a folder for Strata');
      if (picked.unavailable) {const u=chooserUnavailable(picked);return error(res,501,u.message,{code:u.code});};
      if (picked.cancelled) return json(res, 200, { cancelled: true });
      return json(res, 200, { path: picked.path });
    } catch (e) {
      return error(res, 400, e.message);
    }
  }

  /* The desktop shell's own choices (#3402, #3477): the port it asks for, the tray, and a desktop notification through the shell. */
  if (path === '/api/locale' && method === 'GET') return json(res, 200, systemLocale());
  if (path === '/api/shell' && method === 'GET') return json(res, 200, shellState());
  if (path === '/api/shell/prefs' && method === 'POST') {
    const b = await readBody(req);
    try { writeShellPrefs(b); } catch (e) { return error(res, 400, e.message); }
    return json(res, 200, shellState());
  }
  if (path === '/api/shell/notify' && method === 'POST') {
    const b = await readBody(req);
    if (!shellNotifier || typeof b.title !== 'string') return json(res, 200, { shown: false });
    try { return json(res, 200, await shellNotifier.notify({ title: b.title, body: String(b.body ?? '') })); } catch { return json(res, 200, { shown: false }); }
  }

  // --- chat ---------------------------------------------------------------
  if (path === '/api/chat/stream' && method === 'POST') {
    const body = await readBody(req,12*1024*1024);
    let images;try{const named=Array.isArray(body.imageIds)&&body.imageIds.length?uploads.dataUrls(typeof body.sessionId==='string'?body.sessionId:'',body.imageIds):[];images=validateChatImages([...(Array.isArray(body.images)?body.images:[]),...named]);}catch(e){return error(res,400,e.message);}
    if(images.length){let selected;try{selected=native.resolveInstance(body.nativeModelId??native.state().defaultId);}catch(e){return error(res,409,e.message);}if(!selected.vision)return error(res,409,'This model was started without picture reading. Open Models, turn on Read pictures and load it again, or choose a model that reads pictures.');}
    const message = String(body.message ?? '').trim();
    if (!message) return error(res, 400, 'message is required');
    /* Which workspace the caller is in, so a skill narrowed to one project
       does not fire in another. */
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : null;

    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    keepStreamAlive(res);   // #4878: a quiet turn stays open; the timer ends with the response
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    // A plain chat turn says what it is doing too (reading the message, thinking with a token count, writing).
    const plain = withPlainStatus(frame => { if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(frame)}\n`); });
    res.on('close', () => plain.dispose());
    await runTurn({
      message,
      history: Array.isArray(body.history) ? body.history : [],
      onFrame: plain,
      signal: controller.signal,
      req,
      client: 'Strata chat',
      workspaceId,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
      nativeModelId:body.nativeModelId,
      images,useTools:body.useTools===true,thinking:body.thinking??'high',thinkingBudget:Number.isInteger(body.thinkingBudget)&&body.thinkingBudget>0?Math.min(body.thinkingBudget,262144):0,
    });
    res.end();
    return undefined;
  }

  return error(res, 404, `No route for ${method} ${path}`);
}

/* -------------------------------------------------- OpenAI-compatible API --- */

/** The /v1 refusal of a page of another site while no API key is set (wording approved by the coordinator 11-16). */
const V1_FOREIGN_PAGE = 'Other websites can\'t use this API while no API key is set. Set an API key in Serving to allow it.';
/** `via`: the listener the request came in on: 'app' (this app's own port), 'share' (LAN sharing) or 'tunnel'. */
async function openai(req, res, path, method, via) {
  if (!serving.authorized(req)) return error(res, 401, 'Invalid API key');
  // Without an API key, a web page of another site may not use the model (serving.mjs v1OriginRefused; strata serve has the same rule).
  if (serving.v1OriginRefused(req, via)) return error(res, 403, V1_FOREIGN_PAGE);
  try {
    return await routeInference(req, res, path, method, via);
  } catch (err) {
    if (!(err instanceof InvalidJsonError)) throw err;
    if (res.headersSent) return res.end();
    const message = 'Invalid JSON in request body';
    const detail = { type: 'invalid_request_error', message };
    if (path === '/v1/messages') return json(res, 400, { type: 'error', error: detail });
    return json(res, 400, { error: { ...detail, param: null, code: 'invalid_json' } });
  }
}

async function routeInference(req, res, path, method, via) {
  if(native.state().instances.length){
    if(path==='/v1/models'&&method==='GET')return json(res,200,{object:'list',data:nativeModelEntries(native.state().instances)});
    if(method==='POST'&&['/v1/chat/completions','/v1/messages','/v1/responses'].includes(path)){if(store.get().serving?.pauseServing)return error(res,503,'New API requests are paused.');if(path==='/v1/responses'&&!native.state().capabilities.responses)return error(res,501,'Update the native Strata installation to use the Responses API.');return nativeGateway({req,res,path,body:await readBody(req,12*1024*1024),control:native,serving});}
  }
  if(path==='/v1/responses'&&method==='POST')return error(res,503,'Load a native Strata model to use the Responses API.');

  if (path === '/v1/models' && method === 'GET') {
    const runtime=runtimeState();
    return json(res,200,{object:'list',data:runtime.instances.map(i=>({id:i.apiModelId,object:'model',created:Math.floor(new Date(i.loadedAt).getTime()/1000),owned_by:'strata',meta:{label:i.family,context:i.memory.context,instanceId:i.id,gpuIds:i.gpuIds,mode:runtime.mode}}))});
  }

  if ((path === '/v1/chat/completions' || path === '/v1/messages') && method === 'POST') {
    if (store.get().serving?.pauseServing) return error(res, 503, 'New API requests are paused. Resume them in Serving.');
    const body = await readBody(req);
    const client = clientName(req);
    const anthropic = path === '/v1/messages';
    // An API client can say which workspace it is acting for; without it, a
    // skill narrowed to one project does not fire.
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : null;

    const messages = anthropic
      ? [
          ...(body.system ? [{ role: 'system', content: body.system }] : []),
          ...(body.messages ?? []),
        ]
      : (body.messages ?? []);
    const last = [...messages].reverse().find((m) => m.role === 'user');
    const text =
      typeof last?.content === 'string'
        ? last.content
        : Array.isArray(last?.content)
          ? last.content.map((c) => c.text ?? '').join(' ')
          : '';

    if (!text) return error(res, 400, 'No user message found');

    runtimeState();
    let loaded;
    try{loaded=runtimeModels.resolve(body.model);}
    catch(err){return error(res,409,err.message);}
    loaded={...loaded,id:loaded.apiModelId};

    const id = uid('chatcmpl');
    const created = Math.floor(Date.now() / 1000);
    const wantsStream = body.stream === true;
    const started = Date.now();
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    if (!wantsStream) {
      let out = '';
      let usage = { tokensIn: null, tokensOut: null };
      const result = await runTurn({
        message: text,
        runtimeModelId:loaded.apiModelId,
        history: messages.slice(0, -1),
        onFrame: (frame) => {
          if (frame.type === 'delta') out += frame.text;
          if (frame.type === 'done') usage = { tokensIn: frame.tokensIn, tokensOut: frame.tokensOut };
        },
        client,
        req,
        workspaceId,
        signal: controller.signal,
      });
      if (result?.error) return error(res, 500, result.error);
      return anthropic
        ? json(res, 200, {
            id,
            type: 'message',
            role: 'assistant',
            model: loaded.id,
            content: [{ type: 'text', text: out }],
            usage: { input_tokens: usage.tokensIn, output_tokens: usage.tokensOut },
          })
        : json(res, 200, {
            id,
            object: 'chat.completion',
            created,
            model: loaded.id,
            choices: [{ index: 0, message: { role: 'assistant', content: out }, finish_reason: 'stop' }],
            usage: { prompt_tokens: usage.tokensIn, completion_tokens: usage.tokensOut, total_tokens: Number.isFinite(usage.tokensIn) && Number.isFinite(usage.tokensOut) ? usage.tokensIn + usage.tokensOut : null },
          });
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const write = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

    if (!anthropic) {
      write({ id, object: 'chat.completion.chunk', created, model: loaded.id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    } else {
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id, role: 'assistant', model: loaded.id } })}\n\n`);
    }

    await runTurn({
      message: text,
      runtimeModelId:loaded.apiModelId,
      history: messages.slice(0, -1),
      workspaceId,
      onFrame: (frame) => {
        if (frame.type === 'delta') {
          if (anthropic) {
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: frame.text } })}\n\n`);
          } else {
            write({ id, object: 'chat.completion.chunk', created, model: loaded.id, choices: [{ index: 0, delta: { content: frame.text }, finish_reason: null }] });
          }
        }
        if (frame.type === 'done' && !anthropic) {
          write({ id, object: 'chat.completion.chunk', created, model: loaded.id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: frame.tokensIn, completion_tokens: frame.tokensOut } });
        }
        if (frame.type === 'error') {
          if (anthropic) res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: frame.message } })}\n\n`);
          else write({ error: { message: frame.message, type: 'server_error' } });
        }
      },
      signal: controller.signal,
      client,
      req,
    });

    if (anthropic) {
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    } else {
      res.write('data: [DONE]\n\n');
    }
    res.end();
    void started;
    return undefined;
  }

  return error(res, 404, `No route for ${method} ${path}`);
}

/* ---------------------------------------------------------------- static --- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
};

async function staticFile(req, res, path) {
  if (!existsSync(DIST)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Strata</title>
       <body style="font:16px/1.6 -apple-system,system-ui;background:#0e1113;color:#eef1f3;padding:48px">
       <h1 style="margin:0 0 8px">Strata host is running</h1>
       <p style="color:#8e979f">No built web app found at <code>${DIST}</code>.</p>
       <p>For development run <code>npm run dev</code> (Vite on :5199 proxies /api here).<br>
       For a single port run <code>npm run build:web &amp;&amp; npm run serve</code>.</p>
       <p style="color:#8e979f">API: <a style="color:#4ade80" href="/api/health">/api/health</a> ·
       <a style="color:#4ade80" href="/api/hardware">/api/hardware</a> ·
       <a style="color:#4ade80" href="/v1/models">/v1/models</a></p></body>`,
    );
    return;
  }

  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, safe);
  if (!file.startsWith(DIST)) return error(res, 403, 'Forbidden');

  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(path)) return error(res, 404, 'Asset not found');
    const index = join(DIST, 'index.html');
    if (!existsSync(index)) return error(res, 404, 'Not found');
    file = index;
  }

  const type = MIME[extname(file)] ?? 'application/octet-stream';
  const size=statSync(file).size;
  const page=extname(file)==='.html'?{'content-security-policy':contentSecurityPolicy(readFileSync(file,'utf8')),'permissions-policy':'microphone=(), camera=(), geolocation=()'}:{};
  const headers={...page,'x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-type':type,'cache-control':file.endsWith('index.html')?'no-store':'public, max-age=3600','accept-ranges':'bytes'};
  if(req.headers.range) {
    const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    const start=match?.[1]?Number(match[1]):match?.[2]?Math.max(0,size-Number(match[2])):NaN;
    const end=match?.[1]&&match[2]?Math.min(size-1,Number(match[2])):size-1;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start<0||start>=size){res.writeHead(416,{'content-range':`bytes */${size}`});res.end();return;}
    res.writeHead(206,{...headers,'content-range':`bytes ${start}-${end}/${size}`,'content-length':end-start+1});
    if(req.method==='HEAD')res.end();else createReadStream(file,{start,end}).pipe(res);
    return;
  }
  res.writeHead(200,{...headers,'content-length':size});
  if(req.method==='HEAD')res.end();else createReadStream(file).pipe(res);
}

/* ------------------------------------------------------------------ start --- */

server.on('error', error => {
  if (server.listening) { console.error(`[strata] ${error.message}`); return; }
  // a taken or Windows-reserved port: one plain sentence instead of a stack trace
  console.error(`[strata] ${listenProblem(error, PORT, HOST)}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  if (process.send) process.send({ type: 'strata-ready', port: PORT });
  // Engines a lost owner left behind (an earlier crash, an older version): ended after a PID + start time + command-line check.
  if (control && process.env.STRATA_PACKAGED === '1') control.cleanup().catch(() => {});
  // A9: the first read of this PC (the graphics cards, the engine, the models: a few seconds) starts now, while the window is still opening,
  // instead of when the first page asks. The first-run "Your model" step then often finds the list ready. It reads only; nothing is downloaded.
  if (control && process.env.STRATA_PACKAGED === '1') Promise.resolve(native.refresh(false)).catch(() => { /* the page's own read tells the person */ });
});

const CHAT_DRAIN_MS = Math.min(15000, Math.max(500, Number(process.env.STRATA_SHUTDOWN_CHAT_DRAIN_MS) || 5000));
let stopping=false;
const shutdown = async () => {
  if(stopping)return;stopping=true;
  clearInterval(taskTimer);tasks.close();
  const timeout=setTimeout(()=>process.exit(0),control?45000:10000);timeout.unref();   // stopping an engine through Control: drained (15 s), then ended; the shell's deadline is longer
  server.close();
  // #6661: drain any in-flight or queued chat saves to disk before tearing down sockets and exiting.
  await drainChatStore(chatStore, { inFlight: inFlightChatSaves, timeoutMs: CHAT_DRAIN_MS });
  server.closeAllConnections?.();
  await Promise.allSettled([localShare.stop(),cloudflare.stop(),native.close()]);
  await drainChatStore(chatStore, { timeoutMs: 1000 });
  process.exit(0);
};
// Every ordinary way of being told to stop takes the clean path: Ctrl+C, kill, the terminal closing (SIGHUP), Ctrl+Break.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) { try { process.on(signal, shutdown); } catch { /* not on this platform */ } }
// Started by the desktop shell: when the shell is gone (killed, crashed, logged off) stop what this app started and leave.
// POSIX re-parents us (ppid changes); Windows keeps the old ppid, so the pid is probed (signal 0 never signals).
if (process.env.STRATA_EXIT_WITH_PARENT === '1') {
  const parent = process.ppid;
  const gone = () => {
    if (process.ppid !== parent) return true;
    try { process.kill(parent, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
  };
  setInterval(() => { if (gone()) void shutdown(); }, 1000).unref();
}

export { server, VARIANTS };
