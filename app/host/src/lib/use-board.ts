import { useEffect, useMemo, useState } from 'react';
import { api } from './client';
import { boardCards, type BoardResult } from './board';
import { liveChatIds, loopChatIds, useStore } from './store';
import type { Task } from './tasks';

/**
 * What the board and the sidebar's count read: the host's tasks (asked every few seconds, by one timer however many parts of the page use
 * them), turned into cards together with the chats in this browser.
 */
interface Shared { tasks: Task[]; ready: boolean; error: string }
let shared: Shared = { tasks: [], ready: false, error: '' };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

async function refresh() {
  if (inFlight) return;
  inFlight = true;
  try {
    const tasks = await api.get<{ tasks: Task[] }>('/api/tasks');
    shared = { tasks: tasks.tasks, ready: true, error: '' };
  } catch (e) {
    shared = { ...shared, ready: true, error: e instanceof Error ? e.message : String(e) };
  } finally {
    inFlight = false;
    listeners.forEach(l => l());
  }
}

/** Ask now (after an action), instead of waiting for the next tick. */
export function refreshBoard() { void refresh(); }

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) { void refresh(); timer = setInterval(() => void refresh(), 4000); window.addEventListener('strata:tasks', refreshBoard); }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) { clearInterval(timer); timer = null; window.removeEventListener('strata:tasks', refreshBoard); }
  };
}

export function useBoard(): { board: BoardResult; ready: boolean; error: string; tasks: Task[] } {
  const [, tick] = useState(0);
  useEffect(() => subscribe(() => tick(n => n + 1)), []);
  const sessions = useStore(s => s.sessions), activeSession = useStore(s => s.activeSession), live = useStore(s => s.liveChats);
  // The clock moves the "started 4 min ago" labels and the seven-day window on, without needing a new fetch.
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => { const t = setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 30_000); return () => clearInterval(t); }, []);
  const board = useMemo(
    () => boardCards({ tasks: shared.tasks, sessions, liveChats: liveChatIds(), loopChats: loopChatIds(), activeSession, now: Date.now() }),
    // `live` (how many chats are mid-turn) changes whenever a turn starts or ends; the shared snapshot changes by object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shared, sessions, activeSession, live, minute],
  );
  return { board, ready: shared.ready, error: shared.error, tasks: shared.tasks };
}
