"""Without /proc (macOS) an ended child that is not reaped yet (a zombie) is not "running" (lane 8 on a real Mac: a finished strata_install read as running).
Runs on Linux too: the /proc branch is switched off, so the ps branch (the one a Mac takes) is what decides."""
from __future__ import annotations

import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
import installer_worker  # noqa: E402


@unittest.skipIf(installer_worker.WIN, "POSIX process states")
class ZombieWithoutProc(unittest.TestCase):
    def test_an_ended_unreaped_child_is_not_running(self):
        child = subprocess.Popen([sys.executable, "-c", "pass"])
        try:
            time.sleep(1.0)                              # it has ended; nobody has waited for it, so it is a zombie now
            with mock.patch.object(installer_worker, "_has_proc", return_value=False):
                self.assertIsNone(installer_worker.proc_identity(child.pid))
                self.assertFalse(installer_worker.proc_alive(child.pid, "pid"))
        finally:
            child.wait()

    def test_a_running_child_is_running_and_a_gone_one_is_not(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            with mock.patch.object(installer_worker, "_has_proc", return_value=False):
                self.assertEqual(installer_worker.proc_identity(child.pid), "pid")
        finally:
            child.kill()
            child.wait()
        with mock.patch.object(installer_worker, "_has_proc", return_value=False):
            self.assertIsNone(installer_worker.proc_identity(child.pid))

    def test_without_ps_the_old_check_stays(self):
        with mock.patch.object(installer_worker, "_has_proc", return_value=False), mock.patch.object(installer_worker, "_ps_state", return_value=None):
            self.assertEqual(installer_worker.proc_identity(installer_worker.os.getpid()), "pid")


if __name__ == "__main__":
    unittest.main()
