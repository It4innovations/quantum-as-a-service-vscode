"""Regressions found against live VLQ: transpiled QASM export, job import fields, cancel, pulse download."""

import sys
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

import qaas_bridge

TARGET = {"project": "p", "token": "a.b.c"}


class TranspiledQasmTests(unittest.TestCase):
    def test_gates_without_definition_are_exported_as_basis_gates(self):
        from qiskit import QuantumCircuit
        from qiskit.circuit import Gate

        qc = QuantumCircuit(2, 1)
        qc.r(0.5, 0.25, 0)
        qc.append(Gate("move", 2, []), [0, 1])  # IQM's resonator gate has no Qiskit definition
        qc.measure(0, 0)
        text = qaas_bridge._dumps_qasm3(qc)
        self.assertIn("move q[0], q[1];", text)
        self.assertIn("gate r(", text)


class FakeServer(qaas_bridge.Server):
    def __init__(self, qclient):
        super().__init__()
        self.qclient = qclient

    def _backend(self, p):
        return types.SimpleNamespace(_qclient=self.qclient)


class JobImportTests(unittest.TestCase):
    def test_snake_case_job_models(self):
        job = mock.Mock()
        job.to_dict.return_value = {
            "id": 438,
            "name": "bell",
            "state": 16,
            "creation_time": "2026-11-11 09:27:42",
            "tasks": [{"id": 438}],
        }
        api = mock.Mock()
        api.heappe_job_management_list_jobs_for_current_user_get.return_value = [job]
        jobs = FakeServer(types.SimpleNamespace(job_management_api=api)).listJobs({**TARGET, "limit": 1})
        self.assertEqual(jobs[0]["jobId"], "438")
        self.assertEqual(jobs[0]["name"], "bell")
        self.assertEqual(jobs[0]["createdAt"], "2026-11-11 09:27:42")
        self.assertEqual(jobs[0]["tasks"], 1)
        self.assertNotIn("Unknown", jobs[0]["state"])


class CancelTests(unittest.TestCase):
    def _qclient(self, accepted: bool):
        async def cancel_job(job_id):
            return accepted

        def run(coro):
            try:
                coro.send(None)
            except StopIteration as stop:
                return stop.value

        return types.SimpleNamespace(cancel_job=cancel_job, _run=run)

    def test_coroutine_is_awaited(self):
        self.assertTrue(FakeServer(self._qclient(True)).cancel({**TARGET, "jobId": "7"}))

    def test_refusal_is_reported(self):
        with self.assertRaises(qaas_bridge.BridgeError):
            FakeServer(self._qclient(False)).cancel({**TARGET, "jobId": "7"})


class PulseDownloadTests(unittest.TestCase):
    def test_unknown_pulse_job_without_sources_is_explained(self):
        server = qaas_bridge.Server()
        server.jobInfo = lambda p: {"state": "FINISHED"}
        server._pulla = lambda p: object()
        sys.modules.setdefault("iqm.station_control.client.job_trackers", types.SimpleNamespace(RunJobTracker=object))
        with self.assertRaises(qaas_bridge.BridgeError) as ctx:
            server.downloadPulse({**TARGET, "jobId": "441", "shots": 1000})
        self.assertIn("submitted elsewhere", str(ctx.exception))


class EnvironmentTests(unittest.TestCase):
    def test_old_python_is_reported_not_crashed(self):
        with mock.patch.object(qaas_bridge, "MIN_PYTHON", (99, 0)):
            problem = qaas_bridge._environment_problem()
        self.assertIsInstance(problem, qaas_bridge.EnvironmentProblem)
        self.assertEqual(problem.kind, "Environment")
        self.assertIn("99.0", str(problem))

    def test_current_python_is_fine(self):
        self.assertIsNone(qaas_bridge._environment_problem())

    def test_check_reports_python_ok(self):
        self.assertTrue(qaas_bridge.Server().check({})["pythonOk"])


class OldPythonStartupTests(unittest.TestCase):
    """The bridge must import on old Pythons (e.g. macOS's 3.9) so it can report them instead of crashing."""

    def test_source_parses_as_python_39(self):
        import ast

        source = (Path(qaas_bridge.__file__)).read_text()
        tree = ast.parse(source, feature_version=(3, 9))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "datetime":
                self.assertNotIn("UTC", [a.name for a in node.names], "datetime.UTC needs Python 3.11")


class ForbiddenJobTests(unittest.TestCase):
    def test_403_becomes_a_readable_error_with_request_id(self):
        exc = RuntimeError(
            "GET https://x/heappe/JobManagement/CurrentInfoForJob -> HTTP 403: "
            "{\"detail\":\"Logged user 'u' is not authorized to query job info '456'. (Request ID: 12042ee3)\"}"
        )
        problem = qaas_bridge._forbidden("456", exc)
        self.assertIsInstance(problem, qaas_bridge.BridgeError)
        self.assertIn("job 456", str(problem))
        self.assertIn("request ID 12042ee3", str(problem))

    def test_other_errors_pass_through(self):
        self.assertIsNone(qaas_bridge._forbidden("1", RuntimeError("HTTP 404: not found")))


if __name__ == "__main__":
    unittest.main()
