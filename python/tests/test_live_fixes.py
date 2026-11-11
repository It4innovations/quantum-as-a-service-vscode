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


if __name__ == "__main__":
    unittest.main()
