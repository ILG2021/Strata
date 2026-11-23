import { useSyncExternalStore } from 'react';
import type { PreviewArtifact } from './artifacts';

/**
 * Code blocks that can be shown in the sidebar preview: Markdown. An HTML page is not run (the web page preview was removed: a page
 * could load anything from the internet), so it stays a code block. The block's id comes from the message and the code itself,
 * so two blocks in one answer are two previews, and the block's button can tell whether its own preview is the one open.
 */
const hash = (text: string) => { let h = 5381; for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

export function codePreviewKind(language: string): 'markdown' | null {
  const name = language.trim().toLowerCase();
  return name === 'markdown' || name === 'md' ? 'markdown' : null;
}

export function codePreview(base: string, language: string, code: string): PreviewArtifact | null {
  const kind = codePreviewKind(language);
  if (!kind) return null;
  return { id: `${base}-${hash(code)}`, kind, title: 'Markdown preview', content: code };
}

/** A finished answer no longer opens an HTML page in the sidebar by itself (the web page preview was removed). */
export function mainCodePreview(_base: string, _content: string): PreviewArtifact | null {
  return null;
}

let selected: string | null = null;
const listeners = new Set<() => void>();
/** The chat tells which preview is showing in the sidebar; only the code blocks' buttons listen, so no message re-renders for it. */
export function setSelectedPreviewId(id: string | null) {
  if (id === selected) return;
  selected = id;
  listeners.forEach(fn => fn());
}
export const useSelectedPreviewId = () => useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => selected, () => null);
