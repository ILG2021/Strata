/** Shared shapes for the Strata host API. Mirrors server/types.d.ts. */

export type CheckState = 'pass' | 'warn' | 'fail';
export interface SoftwareUpdate {
  installedVersion?: string;
  status: 'available' | 'current' | 'unavailable' | 'error' | 'no-releases';
  latestVersion?: string;
  releaseUrl?: string;
  canInstall: boolean;
  message: string;
  /** The technical reason behind `message`, shown only behind the Details disclosure. */
  details?: string;
  /** Windows desktop update path / custom-launcher profile warning surfaced before updating (#6573). */
  installPathWarning?: string;
}
export interface UpdateCheckResult { checkedAt: string; strata: SoftwareUpdate; engine: SoftwareUpdate }

export interface HardwareCheck {
  id: 'gpu' | 'memory' | 'cpu' | 'storage';
  label: string;
  state: CheckState;
  detail: string;
  value?: string;
}

export interface ProcessorInfo { id:string; socket:string; model:string; cores:number; threads:number; arch:string; ghz:number; logicalIds?:number[] }
export interface CpuReading { id:string; utilizationPct:number|null }
export interface GpuReading { id:string; temperatureC:number|null; utilizationPct:number|null; memoryUsedGb:number|null; /** The engine's own total for this device (hardware.gpus[].mem_total), when it reports one. */ memoryTotalGb?:number|null; source:string; sampledAt:string; powerW?:number|null; powerLimitW?:number|null; pcieGen?:number|null; pcieGenMax?:number|null; pcieWidth?:number|null; pcieRxMbs?:number|null; fanPct?:number|null; clockMhz?:number|null }

export interface GpuInfo {
  id?: string;
  index: number;
  vendor: 'apple' | 'nvidia' | 'amd' | 'intel' | 'unknown';
  name: string;
  vramGb: number;
  freeVramGb?: number;
  unified: boolean;
  backend: 'metal' | 'cuda' | 'rocm' | 'vulkan' | 'cpu';
  driver?: string;
}

export interface Hardware {
  probedAt: string;
  host: { name: string; platform: string; release: string; arch: string; app: string };
  processors?: ProcessorInfo[];
  cpu: { topologyKnown?:boolean; model: string; cores: number; threads: number; arch: string; ghz: number };
  memory: { totalGb: number; freeGb: number; usedGb: number; pressure: 'low' | 'medium' | 'high' };
  disk: { path: string; totalGb: number; freeGb: number; modelsDir: string };
  gpus: GpuInfo[];
  accelerator: { backend: string; label: string; usableVramGb: number; unified: boolean };
  checks: HardwareCheck[];
  verdict: { ok: boolean; headline: string; detail: string };
  recommendedVariantId: string;
}

export type VariantState =
  | 'available'
  | 'downloading'
  | 'installed'
  | 'loading'
  | 'loaded'
  | 'unloading'
  | 'error';

export interface ModelVariant {
  local?: { path: string; files: { path: string; bytes: number; mtimeMs: number; ctimeMs: number }[]; architecture: string; contextLength: number; hasChatTemplate: boolean; shards: number; metadataSignature: string };
  source?: { repo: string; file: string; bytes?: number };
  downloadUrl?: string;
  kvKbPerToken?: number;
  catalog?: { family: string; version: string; purpose: string; capabilities: string[]; agentApproved: boolean; balancedRank: number; review: string };
  performance?: import('./experience').SpeedEvidence[];
  id: string;
  name: string;
  family: string;
  quant: string;
  label: string;
  params: string;
  blurb: string;
  role: 'best-fit' | 'option';
  ramClass: { minGb: number; maxGb: number; label: string };
  diskGb: number;
  downloadGb: number;
  contextMax: number;
  layerCount: number;
  experts: number;
  hasDraft: boolean;
  kvModes: string[];
  tags: string[];
  state: VariantState;
  progress?: { pct: number; mbps: number; etaSec: number; stage: string };
  error?: string;
  installedAt?: string;
}

export interface LocalModelPreview { variant: ModelVariant; files: string[]; warnings: string[] }
export interface LocalModelFolder { directory: string; parent: string | null; entries: { name: string; path: string; kind: 'folder' | 'model'; bytes?: number }[]; truncated: boolean; shortcuts: { name: string; path: string }[] }

export interface ModelLibrary {
  mode?: 'real' | 'simulated';
  current: string | null;
  loaded: string | null;
  variants: ModelVariant[];
  downloads: { active: number; queued: number; totalGbToday: number };
  disk: { modelsDir: string; usedGb: number; freeGb: number };
}

export type ImageModelChoice = 'off' | 'q4' | 'q5' | 'q6' | 'q8';
export interface ImageModelVariant {
  id: Exclude<ImageModelChoice, 'off'>;
  label: string;
  quant: string;
  file: string;
  bytes: number;
  downloadGb: number;
  downloadUrl: string;
  state: 'available' | 'downloading' | 'installed' | 'error';
  progress?: { pct: number; stage: string };
  error?: string;
}
export interface ImageModelLibrary {
  mode: 'real' | 'simulated';
  family: string;
  sourceUrl: string;
  revision: string;
  selected: ImageModelChoice;
  applied: ImageModelChoice;
  generationAvailable: boolean;
  variants: ImageModelVariant[];
}

export type Effort = 'fastest' | 'balanced' | 'quality' | 'max';

export interface BeginnerConfig {
  priority: 'speed' | 'balanced' | 'quality' | 'coding';
  contextLength: 'recommended' | `${number}k`;
  readImages: boolean;
  gpuIdle: 'never' | '5m' | '15m' | '1h';
}

export interface ExpertParam {
  applies?: string;
  id: string;
  group: string;
  label: string;
  effect: string;
  type: 'select' | 'number' | 'text' | 'toggle';
  options?: string[];
  value: string | number | boolean;
  recommended: string | number | boolean;
  advanced?: boolean;
}

export interface EngineConfig {
  extra?: Record<string, unknown>;
  variantId: string;
  beginner: BeginnerConfig;
  expert: ExpertParam[];
  predicted: {
    responseSpeed: string;
    memory: string;
    restartNeeded: boolean;
    notes: string[];
  };
  dirty: boolean;
  appliedAt?: string;
  engine: {
    status?: string;
    error?: string | null;
    port?: number;
    running: boolean;
    pid?: number;
    uptimeSec: number;
    version: string;
    backend: string;
    startedAt?: string;
  };
}

export interface RuntimeModel {
  id:string; apiModelId:string; variantId:string; family:string; name:string; quant:string;
  gpuIds:string[]; loadedAt:string; status:'ready'; phase:MonitorState['phase'];
  active:number; queued:number; prompt:MonitorState['prompt']; outputTps:number; promptTps:number;
  context:MonitorState['context'];
  memory:{context:number;ramGb:number;gpuGb:number;spillGb:number;reserveGb:number;totalGb:number;devices:{id:string;gb:number}[]};
}
export interface RuntimeModels {
  revision:number; mode:'real'|'simulated'; capabilities:{multipleModels:boolean;deviceAssignment:boolean}; defaultId:string|null;
  instances:RuntimeModel[];
  memory:{ramGb:number;budgetGb:number;reserveGb:number;totalGb:number;fits:boolean;devices:{id:string;name:string;usedGb:number;budgetGb:number}[]};
}

export interface ServeRequest {
  instanceId?:string;
  gpuIds?:string[];
  id: string;
  at: string;
  client: string;
  endpoint: string;
  state: 'generating' | 'queued' | 'done' | 'error';
  tokensIn: number | null;
  tokensOut: number | null;
  cancellable?: boolean;
  cancelRequested?: boolean;
  usageSource?: 'reported' | 'demo' | 'unavailable' | 'estimated';
  durationMs: number;
  error?: string;
  model: string;
  cachedTokens?: number | null;
  tps?: number | null;
  promptTps?: number | null;
  hitRate?: number | null;
  pcieShare?: number | null;
  finishReason?: string | null;
}

export interface TunnelState { status: 'idle' | 'starting' | 'connected' | 'stopping' | 'error'; mode: 'quick' | 'domain' | null; url: string | null; error: string | null; warning?: string | null; installed: boolean; originUrl: string; connector?: { path: string; version: string | null; source: string; label: string; summary: string } | null; external?: { kind: 'service' | 'process'; others: number[]; own: number[]; message: string } | null; }

export interface ServingState {
  tunnel?: TunnelState;
  sharing?: { active: boolean; url: string | null; warning?: string | null };
  revision?: number;
  running: boolean;
  baseUrl: string;
  /** The address on this computer (the app's own port); baseUrl is the network address while sharing is on. */
  localUrl?: string;
  port: number;
  endpoints: { openai: string; anthropic: string; models: string };
  access: { otherDevices: boolean; apiKeySet: boolean; apiKeyHint: string | null; allowOrigin: string };
  stats: { running: number; waiting: number; completed: number; failed: number; tokensOut: number };
  requests: ServeRequest[];
  pauseServing: boolean;
  /** Origins of pages that may use /v1 without an API key besides the app's own (no UI; PATCH /api/serving). */
  trustedOrigins?: string[];
}

export interface MonitorSample {
  /** Device IDs covered by aggregate GPU history; omitted for legacy host-wide samples. */
  gpuIds?: string[];
  t: number;
  outputTps: number | null;
  promptTps: number | null;
  gpuLoad: number | null;
  vramUsedGb: number | null;
  ramUsedGb: number | null;
  gpuTempC: number | null;
  diskReadGbs: number | null;
  cpuLoad?: number | null;
  powerW?: number | null;
  pcieRxMbs?: number | null;
  gpus?: GpuReading[];
  cpus?: CpuReading[];
}

export interface MonitorState {
  telemetry?: { throughput: string; thermals: string; memory: string; system?:string; context?: string; ttftMs?: number | null };
  phase: 'idle' | 'reading' | 'thinking' | 'generating' | 'loading' | 'error';
  phaseLabel: string;
  variantId: string | null;
  prompt: { done: number; total: number; pct: number };
  generation?: { done:number|null; total:number|null };
  outputTps: number;
  promptTps: number;
  queue: { running: number; waiting: number };
  context: {
    requestId?: string;
    sessionId?: string;
    usedTokens: number;
    maxTokens: number;
    pct: number;
    parts?: { system: number; tools: number; messages: number };
  };
  expertCache: { used: number; total: number; memoryGb?:number|null; source?:string };
  hardware: {
    gpus?: GpuReading[];
    cpus?: CpuReading[];
    cpuLoad?: number | null;
    powerW?: number | null;
    powerLimitW?: number | null;
    pcieRxMbs?: number | null;
    /** CPU and SSD temperatures (only where this PC can give one) and the GPU energy used since the host started, in Wh (#3628). */
    cpuTempC?: number | null;
    ssdTempC?: number | null;
    energyWh?: number | null;
    diskReadGbs?: number | null;
    diskWriteMbs?: number | null;
    gpuLoad: number | null;
    vramUsedGb: number | null;
    vramTotalGb: number;
    ramUsedGb: number | null;
    ramTotalGb: number;
    gpuTempC: number | null;
    tempLimitC: number;
  };
  history: MonitorSample[];
  requests?: ServeRequest[];
  conversationCache?: { enabled?:boolean; parked?:number; slots?:number; memoryGb?:number; budgetGb?:number; parks?:number; restores?:number; evictions?:number; lastEvent?:string; lastAt?:number; lastTokens?:number; requests?:number;requestsReused?:number;lastPrompt?:number;lastReused?:number; source:string };
  totals: {
    promptMs?: number;
    decodeMs?: number;
    usageRequests?: number;
    latencyRequests?: number;
    tokensIn: number;
    tokensOut: number;
    requests: number;
    avgTps: number;
    since: string;
    ttftMs: number;
    cachedTokens: number;
    uncachedTokens: number;
  };
}

export interface ChatMessage {
  /** The person's message is written with Markdown (a task handover: bold headings and lists), so the bubble draws it as such. */
  markdown?: boolean;
  photos?:import('./chat-photos').ChatPhoto[];
  /** #5993: where each numbered quote of this message came from ([1], [2] ...), so the transcript can label it and jump to it. */
  quotes?: import('./quotes').QuoteSource[];
  /** A line from the app itself (for example from /loop), never sent to the model. */
  local?: boolean;
  ttftMs?: number;
  example?: boolean;
  media?: {kind: 'image' | 'video' | 'gif'; src:string; title:string; caption?:string; poster?:string}[];
  artifacts?: import('./artifacts').PreviewArtifact[];
  requestId?: string;
  model?: string;
  inputTokens?: number;
  /** What the context held after this reply (the last model request's prompt + reply). */
  contextUsed?: number;
  /** When the first reasoning arrived, and how long the model reasoned before it began the answer (for "Thought for 38s"). */
  reasoningStartedAt?: number;
  reasoningMs?: number;
  contextMax?: number;
  usageSource?: 'reported' | 'demo' | 'unavailable' | 'estimated';
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  at: string;
  streaming?: boolean;
  demo?: boolean;
  reasoning?: string;
  reasoningOpen?: boolean;
  tokens?: number;
  tps?: number;
  promptTps?: number;
  durationMs?: number;
  error?: string;
  /** What went wrong, as a code the page acts on (a context error offers its own recovery buttons). */
  errorCode?: string;
  /** The engine's own text of the error, kept behind Details. */
  errorDetail?: string;
  tools?: ToolCall[];
}

export type ToolState = 'proposed' | 'approved' | 'running' | 'done' | 'denied' | 'error';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  preview: string;
  effect: string;
  scope: 'read' | 'write' | 'shell' | 'connected';
  /** The card's headline in plain words for its current state ("Wrote a file"); the host sends it, the UI translates it. */
  verb?: string;
  /** What the action is on: a file path, the command, a web address. */
  target?: string;
  state: ToolState;
  result?: string;
  durationMs?: number;
}

/** A folder the model may read, and that sessions are grouped under. */
export interface Workspace {
  id: string;
  name: string;
  path: string;
  /** Earlier folders whose chats belong here (the first workspace moved off the app's own folder). */
  aliases?: string[];
}

/**
 * What the board needs to know about a /loop after the window closes: loops live in memory, so the chat keeps a small record of the
 * last one (running, or how it ended). A record that says `running` with no loop behind it is a loop the window closed on.
 */
export interface LoopRecord {
  prompt: string;
  everyMs: number;
  startedAt: number;
  state: 'running' | 'ended';
  answers: number;
  maxRuns?: number;
  /** When the next answer is due (ms), while running. */
  nextAt?: number;
  endedAt?: number;
  /** count, said-done, time, failures, cap; `stopped` when the person typed /loop stop; `closed` when the window closed on it. */
  endedWhy?: 'count' | 'said-done' | 'time' | 'failures' | 'cap' | 'stopped' | 'closed';
  /** The last answer's first words, for the card. */
  lastText?: string;
}

export interface Session {
  /** The person dismissed this chat's (or its loop's) card on the board at this time. A later problem brings it back. */
  ackedAt?: string;
  loop?: LoopRecord;
  showcase?: boolean;
  previewOpen?: string;
  closedPreviews?: string[];
  preferences?: { thinking?: string; thinkingBudget?: number; };
  /** A branch does not have retained per-turn input usage. */
  statsAvailable?: boolean;
  id: string;
  title: string;
  defaultTitle?: boolean;
  updatedAt: string;
  createdAt: string;
  messages: ChatMessage[];
  workspace: string;
  tokensIn: number;
  tokensOut: number;
  pinned?: boolean;
  /** Put away without deleting. Archiving is for "done with this for now" —
   *  deleting is for "never want to see it again", and conflating the two makes
   *  people keep things they are finished with. */
  archived?: boolean;
  /** When this conversation was last on screen. A session is unread when it has
   *  been updated since — which is the only way to tell, with more than a
   *  handful of conversations, which ones have something new in them. */
  lastReadAt?: string;
}


export interface WorkspaceFile {
  path: string;
  kind: 'file' | 'dir';
  sizeKb?: number;
  updatedAt?: string;
}

export interface SetupState {
  flowVersion?: number;
  dismissed?: boolean;
  choices?: { onboarding?: { step:number; family?:string; size?:string; context?:number; vision?:boolean; directory?:string; profile?:'work'|'performance'; installJobId?:string; tuneJobId?:string; calibrate?:boolean; manual?:boolean }; variantId?: string; contextLength?: BeginnerConfig["contextLength"]; profile?: import("./experience").Profile; batch?: number; batchAuto?: boolean };
  complete: boolean;
  step: number;
  completedAt?: string;
  history: { step: number; at: string }[];
  app: { version: string; modelsDir: string; dataDir: string; modelsDirNotice?: string };
}

export interface EngineEvent {
  type: 'engine' | 'monitor' | 'models' | 'serving' | 'download' | 'log';
  at: string;
  payload: unknown;
}
