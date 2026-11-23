/**
 * A message too large for the model's window, made small enough to send (the page decides that it is too large).
 * The person picks how, on the error card:
 *   file     the whole text is saved in the chat's folder and the message names the file; the assistant reads it in parts
 *   preview  the start and the end of the text, cut to what the window can hold
 * Nothing is sent from here: the page sends the returned message as the person's next message.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What a new chat already holds before the person's first word: the system prompt and the tool list. */
const BASE_TOKENS = 12000;
/** The least room a reply needs after the prompt: an eighth of the window, at most this. */
const REPLY_FLOOR = 4096;
const replyRoom = window => Math.max(512, Math.min(REPLY_FLOOR, Math.floor(window / 8)));

/**
 * The model server's count of a text (its tokenizer and chat template), through its Anthropic-style count endpoint.
 * Returns the number, or null when it cannot be had (an old engine, a server that is busy, a timeout): then nothing is blocked.
 */
async function countTokens({ baseUrl, key = '', model = '', text, fetchImpl = fetch, timeoutMs = 8000 }) {
  try {
    const root = String(baseUrl ?? '').replace(/\/v1\/?$/, '').replace(/\/$/, '');
    const res = await fetchImpl(`${root}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}`, 'x-api-key': key } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: String(text) }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const n = Number((await res.json())?.input_tokens);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  } catch { return null; }
}

/** A number with thousands separators, the way the page writes it. */
const grouped = n => Math.round(n).toLocaleString('en-US');

/**
 * The two ways to send a message that is too large.
 *   file     the whole text goes in a file in the chat's folder; the message names it and shows how it starts
 *   preview  the start and the end of the text, cut to what the window can hold, with the number of characters left out
 * @param {{text:string, mode:'file'|'preview', tokens:number, window:number, pressure?:number, base?:number, path?:string}} input
 * @returns {{message:string, kept:number}}
 */
export function oversizedReplacement({ text, mode, tokens, window, pressure = 0, base = BASE_TOKENS, path = '' }) {
  const t = String(text);
  const charsPerToken = tokens > 0 ? Math.max(0.8, t.length / tokens) : 3;
  if (mode === 'file') {
    const start = t.slice(0, 1200).trimEnd();
    return { kept: start.length, message: `My message was too long to send in the chat, so I saved it as a file: ${path}\n\nIt starts like this:\n\n${start}\n\n[the rest is in the file]\n\nPlease read the file in parts (it is long) and then do what my message asks.` };
  }
  const room = Math.max(1000, Math.floor((window - Math.max(pressure, base) - replyRoom(window)) * 0.7));
  const keep = Math.max(500, Math.floor(room * charsPerToken * 0.9));
  const head = Math.ceil(keep * 0.7), tail = keep - head;
  const left = Math.max(0, t.length - head - tail);
  if (!left) return { kept: t.length, message: t };
  return { kept: head + tail, message: `${t.slice(0, head)}\n\n[… ${grouped(left)} characters from the middle are left out because the message was too long to send …]\n\n${t.slice(t.length - tail)}` };
}

const stamp = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

/**
 * @param {{mode:'file'|'preview', text:string, root:string|null, instance?:{port:number, key?:string, apiModelId?:string, context?:number, metrics?:any}|null, now?:Date, fetchImpl?:typeof fetch}} input
 * @returns {Promise<{message:string, mode:string, tokens:number|null, kept:number, path?:string}>}
 */
export async function prepareOversized({ mode, text, root, instance = null, now = new Date(), fetchImpl = fetch }) {
  const window = instance?.metrics?.engine?.max_context ?? instance?.context ?? 32768;
  const tokens = instance ? await countTokens({ baseUrl: `http://127.0.0.1:${instance.port}/v1`, key: instance.key ?? '', model: instance.apiModelId ?? '', text, fetchImpl }) : null;
  const counted = tokens ?? Math.ceil(text.length / 3);   // not countable: three characters a token is on the safe side for code and logs
  if (mode === 'file') {
    if (!root) throw new Error('This chat has no folder yet. Choose one first.');
    mkdirSync(root, { recursive: true });
    const path = join(root, `pasted-message-${stamp(now)}.txt`);
    writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' });
    return { mode, tokens, path, ...oversizedReplacement({ text, mode, tokens: counted, window, path }) };
  }
  return { mode: 'preview', tokens, ...oversizedReplacement({ text, mode: 'preview', tokens: counted, window }) };
}
