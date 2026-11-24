/**
 * Strata's own system prompt, the first block of every plain chat, shown and editable in Settings > General > System prompt.
 *
 * With no saved file the built-in text is used, so an update that improves the built-in prompt reaches everyone who never changed it.
 * A save stores the text in `<data>/system-prompt.md`; saving the built-in text again (what Restore default does) removes the file. An empty
 * save is kept as empty: the chat then starts with only the person's rules and skills.
 *
 * Writes carry the revision the editor read: a save over a file another window changed since is refused (409), never merged silently.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_SYSTEM_PROMPT = `You are Strata, a local inference assistant running entirely on this computer.
Answer plainly and briefly. Use only tools actually offered to you. Ask for file content when no file tool is available.
Say when you do not know. Never claim to have done something you have not done.`;

/** The largest system prompt, in UTF-8 bytes; the editor keeps to it. */
export const SYSTEM_PROMPT_MAX_BYTES = 65536;

export class SystemPromptError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

export function systemPromptFile(dataDir) { return join(dataDir, 'system-prompt.md'); }

export function createSystemPrompt({ file, builtIn = DEFAULT_SYSTEM_PROMPT }) {
  let cache = null; // { mtimeMs, size, text }

  /** The saved text, or null when nothing is saved (the built-in prompt applies). */
  function saved() {
    let st;
    try { st = statSync(file); } catch { cache = null; return null; }
    if (cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.text;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { cache = null; return null; }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    text = text.replace(/\r\n?/g, '\n');
    cache = { mtimeMs: st.mtimeMs, size: st.size, text };
    return text;
  }

  /** The text every chat starts with ('' when the person emptied it). */
  function current() {
    const text = saved();
    return text === null ? builtIn : text.trim();
  }

  const revisionOf = text => createHash('sha256').update(text === null ? '\u0000default' : `=${text}`, 'utf8').digest('hex').slice(0, 16);

  /** What the editor shows, and the revision a save must name. */
  function read() {
    const own = saved();
    const text = own === null ? builtIn : own;
    return { text, isDefault: own === null, defaultText: builtIn, revision: revisionOf(own), bytes: Buffer.byteLength(text, 'utf8'), maxBytes: SYSTEM_PROMPT_MAX_BYTES, path: file };
  }

  function checkRevision(revision) {
    if (revision !== revisionOf(saved())) throw new SystemPromptError('The system prompt was changed in another window. Close this and open it again to see the newest version.', 409, 'changed');
  }

  /** Save the editor's text. The built-in text itself is not stored, so the prompt keeps following updates. */
  function write(text, revision) {
    if (typeof text !== 'string') throw new SystemPromptError('The system prompt must be text.', 400, 'bad-text');
    const normalized = text.replace(/\r\n?/g, '\n');
    if (Buffer.byteLength(normalized, 'utf8') > SYSTEM_PROMPT_MAX_BYTES) throw new SystemPromptError('This system prompt is too long. Make it shorter than 64 KB, then save again.', 413, 'too-long');
    checkRevision(revision);
    if (normalized.trim() === builtIn.trim()) { rmSync(file, { force: true }); cache = null; return read(); }
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, normalized, 'utf8');
    renameSync(tmp, file);
    cache = null;
    return read();
  }

  return { read, write, current, file };
}
