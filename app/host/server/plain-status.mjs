/**
 * Live status for a plain chat turn: one small `status` frame that says what the model is doing right now (reading the message, thinking
 * with a token count, writing the answer).
 *
 * The page draws only the LATEST status, so a status must be replaced the moment it stops being true. The reporter therefore sends a
 * new frame on every change of phase or target (at most one per `gapMs`, the newest change wins), and between changes only repeats the
 * frame to refresh a counter (reasoning tokens) every `beatMs`. It never sends the same words twice in a row.
 *
 *   { type:'status', seq, phase, code, text, key?, values?, args?, tokens?, elapsedMs }
 *   `key`/`values` (only when the sentence has a name or a number in it): the catalog template ("Thinking… {0} tokens") and its values, for translation.
 */

const COUNTERS = new Set(['tokens', 'bytes']);
const keyOf = u => `${u.phase}|${u.code}|${JSON.stringify(Object.fromEntries(Object.entries(u.args ?? {}).filter(([k]) => !COUNTERS.has(k))))}`;

export class StatusReporter {
  /**
   * @param {{emit: (frame: object) => void, now?: () => number, gapMs?: number, beatMs?: number, timers?: {set: Function, clear: Function}}} options
   */
  constructor({ emit, now = Date.now, gapMs = 300, beatMs = 2000, timers = { set: setTimeout, clear: clearTimeout } }) {
    Object.assign(this, { emitFrame: emit, now, gapMs, beatMs, timers });
    this.seq = 0;
    this.current = null;      // what the page was last told
    this.wanted = null;       // the newest thing that is true now
    this.phaseStartedAt = 0;
    this.lastEmitAt = -Infinity;
    this.timer = null;
    this.closed = false;
  }

  /** Say what is true now. `{phase, code, text, args?, tokens?}`. */
  set(update) {
    if (this.closed) return;
    const next = { ...update, args: update.args ? { ...update.args } : undefined };
    const changed = !this.wanted || keyOf(next) !== keyOf(this.wanted);
    if (changed) this.phaseStartedAt = this.now();
    this.wanted = next;
    const sinceEmit = this.now() - this.lastEmitAt;
    const due = changed ? this.gapMs : this.beatMs;
    // a rare line marked `urgent` is always heard at once
    if (!this.current || sinceEmit >= due || update.urgent === true) this.#flush();
    else if (this.#differs()) this.#arm(due - sinceEmit);
  }

  /** Nothing is happening any more: tell the page to drop the line. */
  clear() {
    if (this.closed) return;
    if (this.current && this.current.phase !== 'idle') { this.wanted = { phase: 'idle', code: 'idle', text: '' }; this.#flush(); }
    this.dispose();
  }

  dispose() { this.closed = true; if (this.timer) this.timers.clear(this.timer); this.timer = null; }

  #differs() {
    const a = this.wanted, b = this.current;
    return !b || a.text !== b.text || a.tokens !== b.tokens;
  }

  #arm(ms) {
    if (this.timer || this.closed) return;
    this.timer = this.timers.set(() => { this.timer = null; if (!this.closed && this.#differs()) this.#flush(); }, Math.max(0, ms));
    this.timer.unref?.();
  }

  #flush() {
    if (this.timer) { this.timers.clear(this.timer); this.timer = null; }
    const w = this.wanted;
    if (!w || (this.current && this.current.text === w.text && this.current.phase === w.phase && this.current.tokens === w.tokens)) return;
    this.current = w;
    this.lastEmitAt = this.now();
    this.emitFrame({
      type: 'status', seq: ++this.seq, phase: w.phase, code: w.code, text: w.text,
      ...(w.key && w.key !== w.text ? { key: w.key, values: w.values ?? [] } : {}),
      ...(w.args ? { args: w.args } : {}), ...(w.tokens !== undefined ? { tokens: w.tokens } : {}),
      elapsedMs: Math.max(0, this.now() - this.phaseStartedAt),
    });
  }
}

/** Counts streamed tokens: one per chunk, or characters / 4 when a server batches many characters into a chunk. */
export class TokenCount {
  constructor() { this.chunks = 0; this.chars = 0; }
  add(text) { this.chunks += 1; this.chars += String(text).length; }
  get tokens() { return this.chars / Math.max(1, this.chunks) < 8 ? this.chunks : Math.ceil(this.chars / 4); }
}

export const fmtTokens = n => Number(n).toLocaleString('en-US');

/**
 * The status line for a plain chat turn: the request is being read, the model is thinking (tokens), the model is writing.
 * Wraps the function that writes frames to the client; the returned function has `dispose()` for a client that left early.
 */
export function withPlainStatus(write, options = {}) {
  const reporter = new StatusReporter({ emit: write, ...options });
  const reasoning = new TokenCount();
  reporter.set({ phase: 'starting', code: 'starting', text: 'Starting…' });
  const frame = f => {
    switch (f.type) {
      case 'start': reporter.set({ phase: 'waiting', code: 'reading-prompt', text: 'Reading your message…' }); break;
      case 'reasoning': reasoning.add(f.text ?? ''); reporter.set({ phase: 'thinking', code: 'thinking', text: `Thinking… ${fmtTokens(reasoning.tokens)} tokens`, key: 'Thinking… {0} tokens', values: [fmtTokens(reasoning.tokens)], tokens: reasoning.tokens, args: { tokens: reasoning.tokens } }); break;
      case 'delta': reporter.set({ phase: 'answering', code: 'answering', text: 'Writing the answer…' }); break;
      // 0.2.16 (owner): a local model's server runs one of its own tools (strata_mcp): the line names it, then waits for the model again
      case 'native-tool': {
        const name = String(f.event?.name ?? '').replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '') || String(f.event?.name ?? '');
        if (f.event?.event === 'call' && name) reporter.set({ phase: 'tool', code: 'tool', text: `Running ${name}…`, key: 'Running {0}…', values: [name], args: { tool: name } });
        else if (f.event?.event !== 'call') reporter.set({ phase: 'waiting', code: 'model-working', text: 'Waiting for the model…' });
        break;
      }
      case 'done': case 'error': reporter.clear(); break;
      default: break;
    }
    write(f);
  };
  frame.dispose = () => reporter.dispose();
  return frame;
}
