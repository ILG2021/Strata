/**
 * Offline mode is retired in the fork (owner, 2026-11-28). It only stopped downloads and update checks the person asks for by a click, which
 * reach GitHub and Hugging Face only, while everything Strata runs on its own (loading, serving) already reaches this computer alone
 * (STRATA_NO_ACQUIRE, terminal/strata_control/egress.py). There is no setting any more, and a network-mode.json an older version wrote is
 * ignored, so nobody is left in a mode the screens can no longer turn off. readOffline stays for its callers and always says no.
 */
export const OFFLINE_ON = 'Offline mode is on. Turn it off in Settings > About > Privacy, then try again.';

export function readOffline() {
  return false;
}
