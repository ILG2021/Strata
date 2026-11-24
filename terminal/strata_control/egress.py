"""What a Strata program of the desktop app may reach (privacy audit, 2026-11-24).

The app's host starts every Control program with STRATA_EGRESS:

* ``allowlist``: an explicit download step reaches GitHub and Hugging Face (and the hosts they redirect files to), over https, and
  nothing else. A program that may not acquire (STRATA_NO_ACQUIRE, every start and every serve) reaches this computer only.
* ``offline``: this computer only, whatever the step is (Settings > Privacy > Offline mode).
* not set (a Terminal or source checkout, the tests): nothing changes.

It is a Python audit hook, installed when strata_control is imported, so it sees every urllib request of the process - each redirect is a
request of its own - also when a system proxy carries it, and cannot be taken out again. It is a guard for Strata's own code, not a
sandbox: a raw socket or another program is not seen here (a firewall rule is the answer to those).
"""

from __future__ import annotations

import errno
import ipaddress
import os
import sys
from urllib.parse import urlsplit

ENV = "STRATA_EGRESS"
ALLOWED = ("github.com", "api.github.com", "codeload.github.com", "huggingface.co", "hf.co")
ALLOWED_UNDER = (".githubusercontent.com", ".huggingface.co", ".hf.co")


class EgressRefused(OSError):
    """An address outside this computer (or outside the allowed hosts) was asked for."""


def loopback(host: str) -> bool:
    host = (host or "").strip("[]").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def mode(environ=None) -> str:
    """'' (no rule), 'local' (this computer only) or 'allowlist'. An unknown value is the strict one."""
    environ = os.environ if environ is None else environ
    value = environ.get(ENV, "").strip().lower()
    if not value:
        return ""
    if value != "allowlist":
        return "local"
    return "local" if environ.get("STRATA_NO_ACQUIRE", "").strip().lower() in ("1", "true", "yes", "on") else "allowlist"


def check(url: str, environ=None) -> None:
    """Raise EgressRefused when this process may not ask for `url`."""
    rule = mode(environ)
    if not rule:
        return
    try:
        parts = urlsplit(str(url))
        scheme, host = parts.scheme.lower(), (parts.hostname or "").lower().rstrip(".")
    except ValueError:
        raise EgressRefused(errno.EACCES, "Strata does not open an address it cannot read") from None
    if scheme in ("data", "file") and not host or loopback(host):
        return
    if rule == "local":
        # ENETUNREACH: the callers' own "no internet connection" path (netpolicy.kind) answers it, without waiting or trying again
        raise EgressRefused(errno.ENETUNREACH, f"Strata may not connect to {host or scheme} now (offline mode, or a step that never downloads)")
    if scheme == "https" and (host in ALLOWED or host.endswith(ALLOWED_UNDER)):
        return
    raise EgressRefused(errno.EACCES, f"Strata downloads from GitHub and Hugging Face only, not from {scheme}://{host}")


def _hook(event: str, args: tuple) -> None:
    if event == "urllib.Request":
        check(args[0])
    elif event == "http.client.connect" and mode() == "local" and not loopback(str(args[1])):
        raise EgressRefused(errno.ENETUNREACH, f"Strata may not connect to {args[1]} now (offline mode, or a step that never downloads)")


_installed = False


def install() -> None:
    global _installed
    if not _installed:
        _installed = True
        sys.addaudithook(_hook)
