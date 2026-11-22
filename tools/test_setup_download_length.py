"""Published size drives resume when HEAD and the range probe have no length."""
import contextlib
import hashlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from tools.test_setup_download import DATA, Server, small_pieces, setup


class PublishedDownloadLength(unittest.TestCase):
    def run_download(self, persistent=False, parallel=False):
        def faults(path, start, end, nth):
            if (start, end) == (0, 0) and (not parallel or nth == 1):
                return 'status', 405
            if start == 0 and nth == 1:
                return 'cut', 262144
            if persistent:
                return 'cut', 0

        with Server(length=False, faults=faults, delay=0) as server, tempfile.TemporaryDirectory() as tmp:
            dst = Path(tmp) / 'model.gguf'
            published = (len(DATA), hashlib.sha256(DATA).hexdigest())
            with contextlib.ExitStack() as stack:
                stack.enter_context(small_pieces(DL_MIN_PARALLEL=0 if parallel else len(DATA) + 1))
                stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                stack.enter_context(mock.patch.object(setup, 'file_pin', return_value=published))
                if persistent:
                    with self.assertRaises(SystemExit):
                        setup.download(server.url, dst)
                    self.assertFalse(dst.exists())
                    self.assertFalse(dst.with_name(dst.name + '.done').exists())
                    self.assertEqual(dst.with_name(dst.name + '.part').read_bytes(), DATA[:262144])
                else:
                    setup.download(server.url, dst)
                    self.assertEqual(dst.read_bytes(), DATA)
                    self.assertTrue(dst.with_name(dst.name + '.done').exists())
                if parallel:
                    self.assertTrue(any(start > 0 and end < len(DATA) - 1 for start, end in server.gets))
                else:
                    self.assertIn((262144, len(DATA) - 1), server.gets)

    def test_pin_size_recovers_clean_early_eof(self):
        self.run_download()

    def test_exhausted_transfer_keeps_resumable_partial(self):
        self.run_download(persistent=True)

    def test_published_size_also_drives_parallel_download(self):
        self.run_download(parallel=True)

    def test_complete_partial_is_published_without_downloading_again(self):
        def faults(path, start, end, nth):
            return ('status', 405) if (start, end) == (0, 0) else None

        with Server(length=False, faults=faults) as server, tempfile.TemporaryDirectory() as tmp:
            dst = Path(tmp) / 'model.gguf'
            dst.with_name(dst.name + '.part').write_bytes(DATA)
            published = (len(DATA), hashlib.sha256(DATA).hexdigest())
            with small_pieces(DL_MIN_PARALLEL=len(DATA) + 1), \
                    mock.patch.object(setup, 'file_pin', return_value=published), \
                    contextlib.redirect_stdout(io.StringIO()):
                setup.download(server.url, dst)
                self.assertEqual(dst.read_bytes(), DATA)
                self.assertIn(published[1], dst.with_name(dst.name + '.done').read_text())
                self.assertEqual(server.gets, [(0, 0)])
                heads = server.heads
                setup.download(server.url, dst)
                self.assertEqual(server.heads, heads)
                self.assertEqual(server.gets, [(0, 0)])

    def test_transport_size_conflict_is_still_refused_before_transfer(self):
        with Server() as server, tempfile.TemporaryDirectory() as tmp:
            dst = Path(tmp) / 'model.gguf'
            with small_pieces(), mock.patch.object(setup, 'file_pin', return_value=(len(DATA) + 1, '0' * 64)), \
                    contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
                setup.download(server.url, dst)
            self.assertEqual(server.gets, [])
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_fallback_size_does_not_bypass_hash_verification(self):
        def faults(path, start, end, nth):
            return ('status', 405) if (start, end) == (0, 0) else None

        with Server(length=False, faults=faults) as server, tempfile.TemporaryDirectory() as tmp:
            dst = Path(tmp) / 'model.gguf'
            with small_pieces(DL_MIN_PARALLEL=len(DATA) + 1), \
                    mock.patch.object(setup, 'file_pin', return_value=(len(DATA), '0' * 64)), \
                    contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
                setup.download(server.url, dst)
            self.assertFalse(dst.exists())
            self.assertFalse(dst.with_name(dst.name + '.done').exists())


if __name__ == '__main__':
    unittest.main()
