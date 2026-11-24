import { useEffect, useState } from 'react';
import { api } from '../lib/client';
import { tr } from '../lib/i18n';

/** Settings > About > Privacy > Offline mode (server/network-mode.mjs). */
export function OfflineModeSetting() {
  const [offline, setOffline] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const failed = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  useEffect(() => { api.get<{ offline: boolean }>('/api/network-mode').then(r => setOffline(r.offline), failed); }, []);
  async function toggle() {
    setError('');
    try { setOffline((await api.put<{ offline: boolean }>('/api/network-mode', { offline: !offline })).offline); }
    catch (e) { failed(e); }
  }
  return <>
    <button className="st-toggle" role="switch" disabled={offline === null} aria-checked={offline === true} aria-label={tr("Offline mode")} onClick={() => void toggle()}/>
    {error ? <p className="small" role="alert">{tr(error)}</p> : null}
  </>;
}
