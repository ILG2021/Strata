/**
 * Who may talk to the host (privacy audit 2026-11-24).
 *
 * The host listens on loopback only, but a web page can still reach it: a name an attacker owns can be pointed at 127.0.0.1 (DNS rebinding), and
 * the page is then "same origin" for the browser, so a GET carries no Origin. Two rules close that:
 *   - the Host header must be an IP address or localhost. Rebinding needs a name, so an address is never an attacker's;
 *   - a request for the host's own API must come from the host's own page: its Origin is this very host and port (another program's page on
 *     another local port is not), and the browser does not call it cross-site or same-site.
 * A client that is no browser (the shell, a test, curl) sends neither header and is let through, as before.
 * The shared and tunnel listeners (local-share.mjs) do not use this: they are meant to be reached by other names and serve /v1 only.
 */
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';

const DEV_PORT = '5199';   // Vite's page (npm run dev), never accepted by the packaged app

const bare = hostname => hostname.replace(/^\[|\]$/g, '');
const loopbackName = name => name === 'localhost' || name.endsWith('.localhost') || name === '::1' || /^127\./.test(name);

/** `url` is what requestUrl made of the request (its host is the Host header). */
export function hostAllowed(url) {
  const name = bare(url.hostname.toLowerCase());
  return isIP(name) !== 0 || name === 'localhost' || name.endsWith('.localhost');
}

/** True when a request for /api/ comes from a page that is not the host's own. */
export function foreignApiRequest(req, { packaged = process.env.STRATA_PACKAGED === '1' } = {}) {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return true;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  let url;
  try { url = new URL(origin); } catch { return true; }                                  // "null", garbage
  if (url.protocol !== 'http:') return true;
  if (url.host === String(req.headers.host ?? '').toLowerCase()) return false;
  return packaged || !(loopbackName(bare(url.hostname)) && url.port === DEV_PORT);
}

/**
 * The page's content security policy: everything comes from the host itself, and nothing the page shows can load from or send to the internet.
 * Inline scripts run only when they are the ones in the built index.html (by hash). ipc: is the app window's own channel.
 */
export function contentSecurityPolicy(html) {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${createHash('sha256').update(m[1].replace(/\r\n?/g, '\n')).digest('base64')}'`);   // a browser hashes the text after it has normalised line ends
  return [
    "default-src 'self'",
    ["script-src 'self' 'wasm-unsafe-eval'", ...hashes].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self' data: blob: ipc: http://ipc.localhost",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}
