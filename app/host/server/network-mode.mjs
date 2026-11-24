/**
 * Offline mode (Settings > Privacy): Strata's own programs reach nothing outside this computer - no downloads, no update checks.
 * One small file beside the app's settings, read at each use, so a change counts for the next program the host starts. Control and the installer
 * get it as STRATA_EGRESS=offline and enforce it themselves (terminal/strata_control/egress.py).
 * Sharing on the network and the Cloudflare tunnel are the person's own choice and are not touched by it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const OFFLINE_ON = 'Offline mode is on. Turn it off in Settings > About > Privacy, then try again.';

export const networkModeFile = components => join(dirname(components), 'network-mode.json');

/** A file that is there but cannot be read counts as on: a damaged privacy choice must not open the network. */
export function readOffline(components) {
  if (!components) return false;
  let text;
  try { text = readFileSync(networkModeFile(components), 'utf8'); } catch (e) { return e.code !== 'ENOENT' && e.code !== 'ENOTDIR'; }
  try { return JSON.parse(text).offline !== false; } catch { return true; }
}

export function writeOffline(components, offline) {
  const file = networkModeFile(components);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ offline: offline === true }) + '\n');
  renameSync(temporary, file);
  return offline === true;
}
