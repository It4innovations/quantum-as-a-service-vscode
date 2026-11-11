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
    def test_pulse_job_submitted_elsewhere_is_rebuilt_from_raw_readouts(self):
        import tempfile

        import numpy as np

        server = qaas_bridge.Server()
        server.jobInfo = lambda p: {"state": "FINISHED"}
        executor = mock.Mock()
        executor.get_artifact_sweep_results.return_value = {"QB1__c_1_0_0": [np.array([1.0, 1.0, 0.0])]}
        server._pulla = lambda p: types.SimpleNamespace(executor=executor)
        with tempfile.TemporaryDirectory() as tmp:
            out = server.downloadPulse({**TARGET, "jobId": "134", "shots": 3, "directory": tmp})
        self.assertEqual(out["counts"], [{"1": 2, "0": 1}])
        self.assertIn("raw readouts", out["note"])


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


class CalibrationMetricsTests(unittest.TestCase):
    def test_split_metric_field(self):
        split = qaas_bridge._split_metric_field
        self.assertEqual(split("characterization.model.QB14.t1_time"), ("characterization.model.t1_time", ["QB14"]))
        self.assertEqual(
            split("metrics.rb.prx.drag_crf.QB1.fidelity:par=d1"), ("metrics.rb.prx.drag_crf.fidelity:par=d1", ["QB1"])
        )
        self.assertEqual(
            split("metrics.irb.cz.crf_crf.QB4__COMPR1.fidelity"), ("metrics.irb.cz.crf_crf.fidelity", ["QB4", "COMPR1"])
        )
        self.assertEqual(split("metrics.global.value"), ("metrics.global.value", []))

    def test_normalize_skips_non_numeric(self):
        out = qaas_bridge._normalize_metrics(
            {
                "describes_id": "abc",
                "observations": [
                    {
                        "dut_field": "characterization.model.QB1.t1_time",
                        "value": 3e-5,
                        "unit": "s",
                        "uncertainty": 1e-6,
                    },
                    {"dut_field": "characterization.model.QB1.label", "value": "x"},
                ],
            }
        )
        self.assertEqual(out["calibrationSetId"], "abc")
        self.assertEqual(len(out["observations"]), 1)
        self.assertEqual(out["observations"][0]["locus"], ["QB1"])


class OwnJobsTests(unittest.TestCase):
    def _job(self, job_id, project):
        job = mock.Mock()
        job.to_dict.return_value = {
            "id": job_id,
            "name": f"job{job_id}",
            "state": 16,
            "creation_time": f"2026-11-11 10:{job_id % 60:02d}:00",
            "tasks": [{"id": job_id, "node_type": {"project": {"name": project, "accounting_string": project}}}],
        }
        return job

    def test_jobs_are_marked_own_or_foreign_with_resource(self):
        api = mock.Mock()

        def listing(**kwargs):
            if kwargs.get("UserId") == 9:
                return [self._job(455, "VLQ-EU")]
            return [self._job(456, "VLQ-CZ"), self._job(455, "VLQ-EU")]

        api.heappe_job_management_list_jobs_for_current_user_get.side_effect = listing
        server = FakeServer(types.SimpleNamespace(job_management_api=api))
        server._heappe_user_id = lambda qclient: 9
        jobs = {j["jobId"]: j for j in server.listJobs({**TARGET, "limit": 10})}
        self.assertTrue(jobs["455"]["own"])
        self.assertFalse(jobs["456"]["own"])
        self.assertEqual(jobs["456"]["resource"], "VLQ-CZ")
        self.assertEqual(jobs["455"]["resource"], "VLQ-EU")

    def test_without_user_id_everything_counts_as_own(self):
        api = mock.Mock()
        api.heappe_job_management_list_jobs_for_current_user_get.return_value = [self._job(1, "VLQ-EU")]
        server = FakeServer(types.SimpleNamespace(job_management_api=api))
        server._heappe_user_id = lambda qclient: None
        self.assertTrue(server.listJobs({**TARGET, "limit": 10})[0]["own"])


class MissingCircuitResultsTests(unittest.TestCase):
    def test_pulse_job_downloaded_as_circuit_job_is_explained(self):
        server = qaas_bridge.Server()
        server.jobInfo = lambda p: {"state": "FINISHED"}
        job = mock.Mock()
        job.result.side_effect = RuntimeError(
            "Failed to fetch task artifact 'measurement_counts': GET https://x/heappe/QScheduler/GetTaskArtifact "
            "-> HTTP 404: QSchedulerResourceNotFound"
        )
        server._job = lambda p: job
        with self.assertRaises(qaas_bridge.BridgeError) as ctx:
            server.download({**TARGET, "jobId": "134", "shots": 1000, "directory": "/tmp/x"})
        self.assertIn("pulse-level job", str(ctx.exception))


class PulseRawReadoutTests(unittest.TestCase):
    def test_readouts_become_qiskit_bitstrings(self):
        import numpy as np

        sweep = {
            "QB1__c_2_0_0": [np.array([0.0, 1.0, 1.0, 0.0])],
            "QB2__c_2_0_1": [np.array([0.0, 1.0, 0.0, 1.0])],
        }
        memory, summary = qaas_bridge._sweep_memory(sweep)
        self.assertEqual(memory, ["00", "11", "01", "10"], "c[1] is the left bit, c[0] the right one")
        self.assertEqual(summary["recordedShots"], 4)
        self.assertEqual(summary["readouts"]["QB2__c_2_0_1"]["p1"], 0.5)

    def test_sweep_note(self):
        note = qaas_bridge._pulse_raw_summary({"shots": 500}, {"recordedShots": 7500, "readouts": {}})["note"]
        self.assertIn("15 points of 500 shots", note)

    def test_job_kind_from_task_name(self):
        api = mock.Mock()
        pulse = mock.Mock()
        pulse.to_dict.return_value = {"id": 5, "state": 16, "tasks": [{"id": 5, "name": "qpulla_pulse_task"}]}
        api.heappe_job_management_list_jobs_for_current_user_get.return_value = [pulse]
        server = FakeServer(types.SimpleNamespace(job_management_api=api))
        server._heappe_user_id = lambda qclient: None
        self.assertEqual(server.listJobs({**TARGET, "limit": 5})[0]["kind"], "pulse")


if __name__ == "__main__":
    unittest.main()
