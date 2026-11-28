"""strata_control/egress.py: what a desktop Control program may reach."""
import os
import sys
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from strata_control import egress  # noqa: E402

ALLOW = {"STRATA_EGRESS": "allowlist"}


class Egress(unittest.TestCase):
    def refused(self, url, env):
        with self.assertRaises(egress.EgressRefused, msg=url):
            egress.check(url, env)

    def test_no_variable_changes_nothing(self):
        egress.check("http://example.com/", {})

    def test_the_download_hosts(self):
        for url in ("https://github.com/a/b", "https://api.github.com/x", "https://huggingface.co/a", "https://cdn-lfs.huggingface.co/x",
                    "https://cas-bridge.xethub.hf.co/x", "https://objects.githubusercontent.com/x", "http://127.0.0.1:8/x", "http://[::1]:8/",
                    "http://localhost:9/x"):
            egress.check(url, ALLOW)

    def test_other_hosts_and_look_alikes(self):
        for url in ("https://example.com/", "https://hf-mirror.com/a", "https://evilhuggingface.co/", "https://huggingface.co.evil.com/",
                    "https://github.com@evil.com/", "http://github.com/a", "ftp://github.com/a", "https://192.168.1.1/", "https://notgithub.com/",
                    "file://server/share/x", "https://pypi.org/", "https://github.io/"):
            self.refused(url, ALLOW)

    def test_serving_and_offline_reach_this_computer_only(self):
        for env in ({**ALLOW, "STRATA_NO_ACQUIRE": "1"}, {"STRATA_EGRESS": "offline"}, {"STRATA_EGRESS": "typo"}):
            self.refused("https://github.com/a", env)
            egress.check("http://127.0.0.1:1/", env)

    def test_the_hook_sees_urllib(self):
        for env, url in ((ALLOW, "https://example.com/"), ({"STRATA_EGRESS": "offline"}, "https://github.com/")):
            with mock.patch.dict(os.environ, env):
                os.environ.pop("STRATA_NO_ACQUIRE", None)
                with self.assertRaises(egress.EgressRefused):
                    urllib.request.urlopen(url, timeout=1)

    def test_loopback_names(self):
        for host in ("127.0.0.1", "127.5.0.1", "::1", "[::1]", "::ffff:127.0.0.1", "localhost", "a.localhost"):
            self.assertTrue(egress.loopback(host), host)
        for host in ("0.0.0.0", "10.0.0.1", "::ffff:10.0.0.1", "github.com", "fe80::1%eth0", ""):
            self.assertFalse(egress.loopback(host), host)

    def test_sockets_reach_this_computer_only_when_local(self):
        # (fork hardening) a TCP connect outside this computer is refused before any packet leaves; loopback still connects
        import socket
        import threading
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        threading.Thread(target=lambda: srv.accept()[0].close(), daemon=True).start()
        try:
            for env in ({"STRATA_EGRESS": "offline"}, {**ALLOW, "STRATA_NO_ACQUIRE": "1"}):
                with mock.patch.dict(os.environ, env):
                    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s, self.assertRaises(egress.EgressRefused):
                        s.settimeout(0.5)
                        s.connect(("192.0.2.1", 443))                      # TEST-NET-1: never routed
                    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s, self.assertRaises(egress.EgressRefused):
                        s.sendto(b"x", ("192.0.2.1", 9))
                    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                        try:
                            s.connect(("10.255.255.255", 1))               # the route probe: sends nothing, so it is not refused
                        except egress.EgressRefused:
                            self.fail("a UDP connect (no packet) was refused")
                        except OSError:
                            pass                                           # no route on this machine: fine, it was not refused
            with mock.patch.dict(os.environ, {"STRATA_EGRESS": "offline"}):
                with socket.create_connection(("127.0.0.1", srv.getsockname()[1]), timeout=2):
                    pass
        finally:
            srv.close()

    def test_this_computers_own_interface_address_counts_as_local(self):
        import socket
        with mock.patch.object(egress, "_OWN", {"at": 1e18, "addresses": frozenset({"192.168.7.9"})}), \
                mock.patch.dict(os.environ, {"STRATA_EGRESS": "offline"}):
            self.assertTrue(egress.own_address("192.168.7.9"))
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.3)
                try:
                    s.connect(("192.168.7.9", 9))
                except egress.EgressRefused:
                    self.fail("this computer's own address was refused")
                except OSError:
                    pass                                               # nothing listens there: fine, it was not refused

    def test_sockets_are_not_checked_without_a_rule_or_on_a_download_step(self):
        import socket
        for env in ({}, ALLOW):
            with mock.patch.dict(os.environ, env, clear=False):
                os.environ.pop("STRATA_NO_ACQUIRE", None)
                if not env:
                    os.environ.pop("STRATA_EGRESS", None)
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                    try:
                        s.sendto(b"", ("192.0.2.1", 9))
                    except egress.EgressRefused:
                        self.fail(f"refused under {env}")
                    except OSError:
                        pass

    def test_a_redirect_to_another_host_is_refused(self):
        import http.server
        import threading

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                self.send_response(302)
                self.send_header("Location", "https://example.com/stolen")
                self.end_headers()

            def log_message(self, *a):
                pass
        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            with mock.patch.dict(os.environ, ALLOW), self.assertRaises(egress.EgressRefused):
                urllib.request.urlopen(f"http://127.0.0.1:{srv.server_port}/", timeout=5)
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
