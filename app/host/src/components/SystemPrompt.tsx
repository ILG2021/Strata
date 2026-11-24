import { useState } from 'react';
import { api, ApiError } from '../lib/client';
import { localeTag, tr } from '../lib/i18n';
import { Btn, Dialog } from './ui';

/** What the host answers for /api/system-prompt (server/system-prompt.mjs). */
interface SystemPrompt { text: string; isDefault: boolean; defaultText: string; revision: string; bytes: number; maxBytes: number }

export const SYSTEM_PROMPT_MAX_BYTES = 65536;
const TOO_LONG = 'This system prompt is too long. Make it shorter than 64 KB, then save again.';
const CHANGED = 'The system prompt was changed in another window. Close this and open it again to see the newest version.';
const promptBytes = (text: string) => new TextEncoder().encode(text.replace(/\r\n?/g, '\n')).length;
const kb = (bytes: number) => `${(Math.ceil(bytes / 102.4) / 10).toLocaleString(localeTag(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;

/**
 * Settings > General > System prompt: the text every chat starts with, before the person's rules and skills. It opens with
 * the built-in prompt until the person saves their own; Restore default puts the built-in text back, and saving it removes the saved file. A save names the version it opened,
 * so a newer save from another window is never overwritten.
 */
export function SystemPromptSetting() {
  const [open, setOpen] = useState<SystemPrompt | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bytes = promptBytes(text), tooLong = bytes > SYSTEM_PROMPT_MAX_BYTES;

  const failed = (e: unknown) => setError(e instanceof ApiError && e.status === 409 ? CHANGED : e instanceof ApiError && e.status === 413 ? TOO_LONG : e instanceof Error ? e.message : String(e));

  async function start() {
    setError('');
    try { const prompt = await api.get<SystemPrompt>('/api/system-prompt'); setText(prompt.text); setOpen(prompt); }
    catch (e) { failed(e); }
  }
  async function save() {
    if (!open || tooLong) return;
    setBusy(true); setError('');
    try { await api.put<SystemPrompt>('/api/system-prompt', { text, revision: open.revision }); setOpen(null); }
    catch (e) { failed(e); }
    finally { setBusy(false); }
  }

  const unchanged = !!open && text.trim() === open.defaultText.trim();
  return <>
    <Btn size="sm" onClick={() => void start()}>{tr("Edit system prompt")}</Btn>
    {!open && error ? <p className="small" role="alert">{tr(error)}</p> : null}
    <Dialog open={!!open} title={tr("System prompt")} onClose={() => setOpen(null)} actions={<>
      <Btn disabled={busy || unchanged} onClick={() => open && setText(open.defaultText)}>{tr("Restore default")}</Btn>
      <Btn onClick={() => setOpen(null)}>{tr("Cancel")}</Btn>
      <Btn variant="primary" disabled={busy || tooLong} onClick={() => void save()}>{tr("Save system prompt")}</Btn>
    </>}>
      <label className="input-field"><span className="sr-only">{tr("System prompt")}</span><textarea className="st-input" rows={12} aria-label={tr("System prompt")} value={text} onChange={e => setText(e.target.value)} /></label>
      <p className="small muted" data-system-prompt-bytes={bytes}>{tr(unchanged ? "Built-in prompt" : "Your own prompt")} · {tr("{0} of 64 KB used", [kb(bytes)])}</p>
      {tooLong || error ? <p className="small" role="alert">{tr(tooLong ? TOO_LONG : error)}</p> : null}
    </Dialog>
  </>;
}
