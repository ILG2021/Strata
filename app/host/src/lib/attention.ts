/**
 * Telling the person that Strata has finished (#3586). Opt-in and off by default: a short sound when an answer or task that took a while is
 * finished, or when Strata is in the background (public/strata-done-sound.wav, made for Strata from sine waves, no sample).
 */

/** An answer that came back faster than this does not chime while the person is looking at the window. */
export const QUICK_MS = 8000;
const SOUND_URL = '/strata-done-sound.wav';
const MIN_GAP_MS = 2000;
let lastPlayed = 0;

export interface DoneContext { enabled: boolean; durationMs: number; focused: boolean; now?: number }

/** Whether the finished-work sound should play now: only when asked for, only for work that took a while or when the window is not in front. */
export function shouldPlayDone({ enabled, durationMs, focused, now = Date.now() }: DoneContext): boolean {
  if (!enabled) return false;
  if (now - lastPlayed < MIN_GAP_MS) return false;
  return !focused || durationMs >= QUICK_MS;
}

export const windowInFront = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();

export function playDoneSound(make: (url: string) => { volume: number; play(): Promise<void> | void } = url => new Audio(url)): boolean {
  try {
    const audio = make(SOUND_URL);
    audio.volume = 0.6;
    lastPlayed = Date.now();
    const started = audio.play();
    if (started && typeof (started as Promise<void>).catch === 'function') (started as Promise<void>).catch(() => { /* the browser asked for a click first: no sound this time */ });
    return true;
  } catch {
    return false;
  }
}

/** Called when an answer or a task is finished. */
export function workFinished(enabled: boolean, durationMs: number): void {
  if (shouldPlayDone({ enabled, durationMs, focused: windowInFront() })) playDoneSound();
}

