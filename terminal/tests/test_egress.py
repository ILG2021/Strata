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
