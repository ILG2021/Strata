import { tr } from '../lib/i18n';
import { modelFamilyIcon } from '../lib/model-icons';
import { useEffect, useRef, useState } from 'react';
import { FloatingMenu } from './FloatingMenu';
import { DictationControl } from './DictationControl';
import { Icon } from './ui';
import { MOD } from '../lib/commands';
import { pushToast, setChatPreferences, useStore } from '../lib/store';
import type { PreviewArtifact } from '../lib/artifacts';
import type { Session } from '../lib/types';
import { attachChatPhoto } from '../lib/chat-photos';
import { uploadChatFile, FILE_ACCEPT } from '../lib/chat-attach-file';
import { useNative } from '../lib/native';
import { pictureStatus } from '../lib/pictures';
import { busyDropKind } from '../lib/busy-drop';
const efforts = ['Off', 'Low', 'Medium', 'High', 'Max'];
const hy4Efforts = ['Off', 'High', 'Max'];
/** The most tokens a reply may spend thinking (the server's reasoning_budget_tokens); 0 = no limit. */
const THINKING_BUDGETS: [number, string][] = [[0, 'No limit'], [2048, '2K'], [8192, '8K'], [32768, '32K']];
const textTypes = /\.(txt|md|markdown|csv|tsx?|jsx?|py|json|css|rs|go|sh|html?|ya?ml|toml|xml|log)$/i;
const photoTypes = /\.(png|jpe?g|webp|gif|svg)$/i;
export function ComposerControls({ session, onPreview, onAttach, onError, onSlash, streaming, draft, onDraft }: {
    draft: string;
    onDraft: (text: string) => void;
    session: Session | null;
    onPreview: (a: PreviewArtifact) => void;
    streaming: boolean;
    onAttach: (name: string, text: string) => void;
    onError: (error: string) => void;
    onSlash: () => void;
}) {
    const native = useNative();
    const nativeModel = native?.instances.find(i => i.id === native.defaultId);
    const library = useStore(s => s.library);
    const loaded = library?.variants.find(v => v.id === library.loaded);
    const [menu, setMenu] = useState(false), [preferences, setPreferences] = useState<'thinking' | null>(null), [reading, setReading] = useState(false);

    const files = useRef<HTMLInputElement>(null), folder = useRef<HTMLInputElement>(null), previewFile = useRef<HTMLInputElement>(null);
    const trigger = useRef<HTMLButtonElement>(null), thinkingTrigger = useRef<HTMLButtonElement>(null);
    const attachLatest = useRef(onAttach);
    attachLatest.current = onAttach;
    const addFilesLatest = useRef<(files: File[]) => Promise<void>>(async () => { });
    const pictures = pictureStatus(native);
    const isHy4Active = !!nativeModel && /^hy4-flash/i.test(nativeModel.model);
    const isInklingActive = !!nativeModel && /^inkling-2-mini/i.test(nativeModel.model);
    const activeEfforts = isHy4Active ? hy4Efforts : efforts;
    const effort = isInklingActive ? 'Off' : (activeEfforts.includes(session?.preferences?.thinking ?? '') ? session!.preferences!.thinking! : (isHy4Active ? 'High' : 'Medium'));
    const budget = session?.preferences?.thinkingBudget ?? 0;
    const shortcut = MOD === '⌘' ? '⌘⇧A' : 'Ctrl+Shift+A';
    async function openFile(selected: File | undefined) {
        if (!selected)
            return;
        if (selected.size > 20 * 1024 * 1024) {
            onError('Choose a file smaller than 20 MB.');
            return;
        }
        const isPdf = /\.pdf$/i.test(selected.name), isImage = photoTypes.test(selected.name), isTable = /\.csv$/i.test(selected.name), isCode = /\.(tsx?|jsx?|py|json|css|rs|go|sh)$/i.test(selected.name), isHtml = /\.html?$/i.test(selected.name);
        try {
            onPreview({ id: crypto.randomUUID(), kind: isPdf ? 'pdf' : isImage ? 'image' : isTable ? 'table' : isCode || isHtml ? 'code' : 'markdown', title: selected.name, ...(isPdf || isImage ? { url: URL.createObjectURL(selected) } : { content: await selected.text() }) });
        }
        catch {
            onError('Could not read the file.');
        }
    }
    async function addFiles(selected: File[], directory = false) {
        if (!selected.length)
            return;
        setReading(true);
        onError('');
        const texts: string[] = [];
        let bytes = 0;
        let skipped = 0;
        try {
            for (const file of selected.slice(0, 64)) {
                const path = file.webkitRelativePath || file.name;
                if (directory && /(^|\/)(node_modules|\.git|\.strata)(\/|$)/.test(path)) {
                    skipped++;
                    continue;
                }
                if (!directory && photoTypes.test(file.name) && pictures.ok) {
                    await attachChatPhoto(file, session?.id);
                    continue;
                }
                if (!directory && session?.id && /\.pdf$/i.test(file.name) && file.size <= 12 * 1024 * 1024) {
                    // A PDF goes to the chat's folder and is named in the next message; "Open a file" still previews it.
                    const saved = await uploadChatFile(file, session.id);
                    pushToast('success', 'PDF added', `${saved.name} is in this chat. Ask about it in your next message.`);
                    continue;
                }
                if (!directory && (photoTypes.test(file.name) || /\.pdf$/i.test(file.name))) {
                    await openFile(file);
                    if (photoTypes.test(file.name))
                        onError(`${pictures.ok ? '' : tr(pictures.message)} ${tr('It is open in preview.')}`);
                    continue;
                }
                if (!textTypes.test(file.name) || bytes + file.size > 256 * 1024) {
                    skipped++;
                    continue;
                }
                const text = await file.text();
                if (text.includes('\u0000')) {
                    skipped++;
                    continue;
                }
                bytes += file.size;
                texts.push(`File: ${path}\n\n${text}`);
            }
            if (texts.length)
                attachLatest.current(directory ? (selected[0].webkitRelativePath.split('/')[0] || 'Folder') : selected.filter(f => textTypes.test(f.name)).map(f => f.name).join(', '), texts.join('\n\n'));
            skipped += Math.max(0, selected.length - 64);
            if (skipped)
                onError(`${skipped} file${skipped === 1 ? ' was' : 's were'} skipped. Add up to 64 text files, with 256 KB of text in total. Photos and PDFs can be opened separately.`);
        }
        catch {
            onError('Some files could not be read. Try adding them separately.');
        }
        finally {
            setReading(false);
        }
    }
    addFilesLatest.current = files => addFiles(files);
    useEffect(() => {
        folder.current?.setAttribute('webkitdirectory', '');
        const key = (e: KeyboardEvent) => {
            if (!e.defaultPrevented && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a' && !document.querySelector('.dialog-layer') && !streaming && !reading) {
                e.preventDefault();
                files.current?.click();
            }
        };
        const preview = () => previewFile.current?.click();
        const dropped = (e: Event) => {
            const incoming = (e as CustomEvent<File[]>).detail ?? [];
            if (!streaming && !reading) { void addFilesLatest.current(incoming); return; }
            // #5960: not taken while an answer is written or a file is read; it used to vanish without a word.
            const kind = busyDropKind(incoming);
            if (kind === 'picture') pushToast('warn', tr('Picture not added'), tr('Strata is still busy with this chat. Add the picture again when it is done.'));
            else if (kind === 'file') pushToast('warn', tr('The file was not added'), tr('Try dropping it again.'));
        };
        window.addEventListener('strata:drop-files', dropped);
        window.addEventListener('keydown', key);
        window.addEventListener('strata:open-preview', preview);
        return () => { window.removeEventListener('strata:drop-files', dropped); window.removeEventListener('keydown', key); window.removeEventListener('strata:open-preview', preview); };
    }, [streaming, reading]);
    return <>
    <input ref={files} type="file" multiple hidden accept={FILE_ACCEPT} onChange={e => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }}/>
    <input ref={folder} type="file" multiple hidden onChange={e => { void addFiles(Array.from(e.target.files ?? []), true); e.target.value = ''; }}/>
    <input ref={previewFile} type="file" hidden onChange={e => { void openFile(e.target.files?.[0]); e.target.value = ''; }}/>
    <button ref={trigger} className="composer-add" aria-label={tr("Add or open")} title={tr("Add or open")} disabled={reading || streaming} aria-haspopup="menu" aria-expanded={menu} onClick={() => { setPreferences(null); setMenu(v => !v); }}><Icon name="plus" size={22}/></button>
    <DictationControl draft={draft} onDraft={onDraft} sessionId={session?.id} disabled={streaming}/>
    <span className="spacer"/>
    {isInklingActive ? null : <button ref={thinkingTrigger} className="composer-choice composer-effort" aria-label={tr("Reasoning effort: {0}", [effort])} aria-haspopup="menu" aria-expanded={preferences === 'thinking'} onClick={() => { setMenu(false); setPreferences(v => v === 'thinking' ? null : 'thinking'); }}><Icon name="thinking" size={16}/><span>{tr(effort)}</span><Icon name="chevron" size={13}/></button>}
    {tr(menu ? <FloatingMenu anchor={trigger.current} title={tr("Add or open")} width={292} onClose={() => setMenu(false)}>
      <button role="menuitem" className="menu__item" onClick={() => { setMenu(false); files.current?.click(); }}><Icon name="attach"/><span>{tr("Add files or photos")}</span><kbd className="menu-shortcut">{tr(shortcut)}</kbd></button>
      <button role="menuitem" className="menu__item" onClick={() => { setMenu(false); folder.current?.click(); }}><Icon name="folder-plus"/>{tr("Add folder")}</button>
      <button role="menuitem" className="menu__item" onClick={() => { setMenu(false); onSlash(); }}><span className="slash-command-icon" aria-hidden="true">/</span>{tr("Slash commands")}</button>
    </FloatingMenu> : null)}
    {tr(preferences ? <FloatingMenu anchor={thinkingTrigger.current} title={tr('Reasoning effort')} width={280} onClose={() => setPreferences(null)}>
      <><div className="reasoning-menu-model"><Icon name={modelFamilyIcon(loaded?.family ?? nativeModel?.label)} size={18}/><strong>{tr((nativeModel && nativeModel.status === 'ready' ? nativeModel.label : null) ?? loaded?.family ?? 'No model loaded')}</strong></div><p className="composer-menu-heading">{tr("Reasoning effort")}</p>{tr(activeEfforts.map(option => <button key={option} role="menuitemradio" aria-checked={effort === option} className="menu__item" onClick={() => { setChatPreferences(session?.id, { thinking: option }); setPreferences(null); }}>{tr(option)}<span className="spacer"/>{tr(effort === option ? <Icon name="check" size={16}/> : null)}</button>))}{tr(<><p className="composer-menu-heading">{tr("Thinking budget")}</p>{tr(THINKING_BUDGETS.map(([value, label]) => <button key={value} role="menuitemradio" aria-checked={budget === value} disabled={effort === 'Off'} className="menu__item" onClick={() => { setChatPreferences(session?.id, { thinkingBudget: value }); setPreferences(null); }}>{tr(label)}<span className="spacer"/>{tr(budget === value ? <Icon name="check" size={16}/> : null)}</button>))}</>)}</>
    </FloatingMenu> : null)}

  </>;
}
