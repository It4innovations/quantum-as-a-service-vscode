"""Tests for qaas_script (Run Python File in the WebAssembly runtime). Also run inside Pyodide."""

import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import qaas_script

SCRIPT = """\
import os, sys
import numpy as np
from qiskit import QuantumCircuit
from . import sibling  # relative: not checked
try:
    import not_installed_optional
except ImportError:
    pass
import helpers
import qiskit_aer
import definitely_missing_module
"""


class ImportTests(unittest.TestCase):
    def test_lists_top_level_imports_with_lines(self):
        names = dict(qaas_script.imports(SCRIPT))
        self.assertEqual(names["os"], 1)
        self.assertEqual(names["numpy"], 2)
        self.assertEqual(names["qiskit"], 3)
        self.assertNotIn("not_installed_optional", names)
        self.assertNotIn("sibling", names)

    def test_check_finds_missing_and_limited_but_not_local_modules(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "helpers.py").write_text("X = 1\n")
            script = Path(d) / "run_me.py"
            script.write_text(SCRIPT.replace("from . import sibling  # relative: not checked\n", ""))
            out = qaas_script.check(str(script))
        self.assertEqual([m["name"] for m in out["missing"]], ["definitely_missing_module"])
        self.assertEqual(out["missing"][0]["line"], 10)
        self.assertEqual([m["name"] for m in out["limited"]], ["qiskit_aer"])
        self.assertIn("StatevectorSampler", out["limited"][0]["reason"])


class RunTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        self.cwd, self.path = os.getcwd(), list(sys.path)
        self.environ, self.argv = dict(os.environ), list(sys.argv)

    def tearDown(self):
        os.chdir(self.cwd)
        sys.path[:] = self.path
        sys.argv[:] = self.argv
        os.environ.clear()
        os.environ.update(self.environ)
        self.dir.cleanup()

    def run_script(self, source: str, *args: str) -> tuple[int, str, str]:
        script = self.root / "script.py"
        script.write_text(source)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = qaas_script.run(str(script), list(args), {"LEXIS_PROJECT": "p1"}, str(self.root), str(self.root))
        return code, out.getvalue(), err.getvalue()

    def test_runs_as_main_with_env_argv_and_cwd(self):
        code, out, _ = self.run_script(
            "import os, sys\n"
            "if __name__ == '__main__':\n"
            "    print(os.environ['LEXIS_PROJECT'], sys.argv[1:], os.path.basename(os.getcwd()) == "
            f"{self.root.name!r})\n",
            "a",
        )
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "p1 ['a'] True")

    def test_exit_codes(self):
        self.assertEqual(self.run_script("raise SystemExit(3)\n")[0], 3)
        self.assertEqual(self.run_script("import sys\nsys.exit()\n")[0], 0)
        code, _, err = self.run_script("raise SystemExit('bad input')\n")
        self.assertEqual((code, err.strip()), (1, "bad input"))

    def test_traceback_shows_the_script_not_runpy(self):
        code, _, err = self.run_script("x = 1\n\ndef f():\n    return 1 / 0\n\nf()\n")
        self.assertEqual(code, 1)
        self.assertIn("ZeroDivisionError", err)
        self.assertIn('script.py", line 4', err)
        self.assertNotIn("runpy", err)

    def test_submitted_jobs_are_reported_and_the_hook_removed(self):
        try:
            from qheappe_client.qclient import QClient
        except ImportError:
            self.skipTest("qaas not installed")
        import json
        from unittest import mock

        async def fake_submit(self, tasks, job_name="quantum_job", circuit_payloads=None, backend_name=None):
            return {"Id": 3791}

        reported = []
        script = self.root / "script.py"
        script.write_text(
            "import asyncio\n"
            "from qheappe_client.qclient import QClient\n"
            "c = QClient.__new__(QClient)\n"
            "tasks = [{'Name': 'qheappe_task_0', 'EnvironmentVariables': {'RUN_SHOTS': '1024'}},\n"
            "         {'Name': 'qheappe_task_1', 'EnvironmentVariables': {'RUN_SHOTS': '1024'}}]\n"
            "print(asyncio.run(c.submit_quantum_job(tasks, job_name='vscode_bell_state')))\n"
        )
        with mock.patch.object(QClient, "submit_quantum_job", fake_submit):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = qaas_script.run(str(script), [], {}, str(self.root), str(self.root), notify_job=reported.append)
            self.assertIs(QClient.submit_quantum_job, fake_submit)  # restored after the run
        self.assertEqual(code, 0)
        self.assertIn("3791", out.getvalue())
        self.assertEqual(
            [json.loads(r) for r in reported],
            [{"jobId": "3791", "name": "vscode_bell_state", "tasks": 2, "shots": 1024, "kind": "circuit"}],
        )

    def test_plt_show_saves_figures(self):
        try:
            import matplotlib  # noqa: F401
        except ImportError:
            self.skipTest("matplotlib not installed")
        code, out, err = self.run_script(
            "import matplotlib.pyplot as plt\nplt.plot([0, 1], [1, 0])\nplt.show()\nplt.bar([0], [1])\nplt.show()\n"
        )
        self.assertEqual(code, 0, err)
        self.assertTrue((self.root / "script-1.png").exists())
        self.assertTrue((self.root / "script-2.png").exists())
        self.assertIn("[figure saved:", out)


if __name__ == "__main__":
    unittest.main()
