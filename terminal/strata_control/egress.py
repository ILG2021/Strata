"""What a Strata program of the desktop app may reach (privacy audit, 2026-11-24).

The app's host starts every Control program with STRATA_EGRESS:

* ``allowlist``: an explicit download step reaches GitHub and Hugging Face (and the hosts they redirect files to), over https, and
  nothing else. A program that may not acquire (STRATA_NO_ACQUIRE, every start and every serve) reaches this computer only.
* ``offline``: this computer only, whatever the step is (Settings > Privacy > Offline mode).
* not set (a Terminal or source checkout, the tests): nothing changes.

It is a Python audit hook, installed when strata_control is imported, so it sees every urllib request of the process - each redirect is a
request of its own - also when a system proxy carries it, and cannot be taken out again. It is a guard for Strata's own code, not a
sandbox: another program is not seen here (a firewall rule is the answer to those).

Fork hardening (2026-11-27): where the rule is "this computer only" (offline mode, and every start and serve), the hook also sees the
sockets themselves - socket.connect of a TCP socket and socket.sendto of a UDP one to an address outside this computer are refused - so
a library that does not go through urllib (requests / urllib3, a raw socket) cannot reach out either. A UDP socket's connect() is let
through: it sends nothing (it only picks the route, which lan_addresses() reads), and its sendto() is the one that would. This computer's
own interface addresses (a LAN listen address) count as this computer. Left: send()
on a UDP socket connected that way (Python raises no audit event for it), and the name lookup itself.
"""

from __future__ import annotations

import errno
import ipaddress
import os
import socket
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
        address = ipaddress.ip_address(host.split("%", 1)[0])     # an IPv6 scope (fe80::1%eth0) is not part of the address
    except ValueError:
        return False
    mapped = getattr(address, "ipv4_mapped", None)                # ::ffff:127.0.0.1
    return address.is_loopback or (mapped is not None and mapped.is_loopback)


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


def _inet_host(sock, address) -> str | None:
    """The host of an AF_INET / AF_INET6 socket address, else None (a Unix socket's path, another family)."""
    if getattr(sock, "family", None) not in (socket.AF_INET, socket.AF_INET6):
        return None
    if isinstance(address, tuple) and address:
        return str(address[0])
    return None


_OWN = {"at": 0.0, "addresses": frozenset()}


def own_address(host: str) -> bool:
    """Whether `host` is an address of this computer's own network interfaces (a LAN listen address: the launch's busy-port check
    connects to it, and the connection never leaves the computer). Read from psutil (bundled) or the host name, once a minute."""
    import time
    host = (host or "").strip("[]").split("%", 1)[0].lower()
    now = time.monotonic()
    if now - _OWN["at"] > 60.0:
        found = set()
        try:
            import psutil
            for infos in psutil.net_if_addrs().values():
                for info in infos:
                    if info.family in (socket.AF_INET, socket.AF_INET6):
                        found.add(str(info.address).split("%", 1)[0].lower())
        except Exception:  # noqa: BLE001 - no psutil, or it cannot read the interfaces: the host name's addresses below
            pass
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None):
                found.add(str(info[4][0]).split("%", 1)[0].lower())
        except OSError:
            pass
        _OWN.update(at=now, addresses=frozenset(found))
    return host in _OWN["addresses"]


def _local_refusal(host) -> EgressRefused:
    return EgressRefused(errno.ENETUNREACH, f"Strata may not connect to {host} now (offline mode, or a step that never downloads)")


def _hook(event: str, args: tuple) -> None:
    if event == "urllib.Request":
        check(args[0])
    elif event == "http.client.connect" and mode() == "local" and not loopback(str(args[1])):
        raise _local_refusal(args[1])
    elif event in ("socket.connect", "socket.sendto") and mode() == "local":
        sock, address = args[0], args[1]
        host = _inet_host(sock, address)
        if host is None or loopback(host) or own_address(host):
            return
        if event == "socket.connect" and getattr(sock, "type", None) == socket.SOCK_DGRAM:
            return                                  # a UDP connect sends nothing (the route probe); its sendto is checked
        raise _local_refusal(host)


_installed = False


def install() -> None:
    global _installed
    if not _installed:
        _installed = True
        sys.addaudithook(_hook)
