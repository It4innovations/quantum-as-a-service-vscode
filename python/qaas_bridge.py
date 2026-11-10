"""Bridge between the VS Code extension and the qaas Python package.

Run as ``python qaas_bridge.py serve``. The extension keeps this process alive so the
LEXIS login and HEAppE clients are reused across commands.

Protocol: one JSON object per line.
    request:  {"id": 1, "method": "check", "params": {...}}
    response: {"id": 1, "result": ...}  or  {"id": 1, "error": {"type": ..., "message": ...}}

The protocol uses private copies of stdin/stdout. Anything the libraries print goes to
stderr (shown in the "QaaS" output channel) and nothing can read the protocol stream.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import sys
import traceback
from datetime import UTC, datetime
from importlib import metadata
from pathlib import Path
from typing import Any

MIN_QAAS = (1, 0, 0)
TERMINAL_STATES = {"FINISHED", "FAILED", "CANCELED", "CANCELLED"}


class BridgeError(Exception):
    """Error with a message meant for the user."""


def _version(dist: str) -> str | None:
    try:
        return metadata.version(dist)
    except metadata.PackageNotFoundError:
        return None


def _is_outdated(version: str | None) -> bool:
    """True for qaas older than 1.0.0, including pre-releases such as 1.0.0a1."""
    if version is None:
        return False
    match = re.match(r"(\d+(?:\.\d+)*)(.*)", version)
    if not match:
        return False
    release = tuple(int(x) for x in match.group(1).split("."))
    release += (0,) * (3 - len(release))
    pre = bool(re.match(r"\.?(a|b|rc|dev)", match.group(2)))
    return release < MIN_QAAS or (release == MIN_QAAS and pre)


def _jsonable(value: Any) -> Any:
    if hasattr(value, "to_dict"):
        value = value.to_dict()
    return json.loads(json.dumps(value, default=str))


def _attr(obj: Any, dotted: str) -> Any:
    """Read a dotted attribute path; None if any part is missing or raises."""
    try:
        for part in dotted.split("."):
            obj = getattr(obj, part)
        return obj
    except Exception:
        return None


def _circuit_stats(qc) -> dict:
    two_qubit = sum(1 for inst in qc.data if inst.operation.num_qubits == 2)
    return {
        "name": qc.name,
        "numQubits": qc.num_qubits,
        "numClbits": qc.num_clbits,
        "depth": qc.depth(),
        "size": qc.size(),
        "twoQubitGates": two_qubit,
        "ops": {k: int(v) for k, v in qc.count_ops().items()},
    }


class Server:
    def __init__(self) -> None:
        self._providers: dict[tuple[str, str | None], Any] = {}
        self._backends: dict[tuple, Any] = {}

    # --- connection -------------------------------------------------------

    def _provider(self, p: dict):
        project = p.get("project")
        if not project:
            raise BridgeError("No LEXIS project configured (setting qaas.lexisProject).")
        token = p.get("token") or None
        key = (project, token)
        if key not in self._providers:
            from qheappe_client.qprovider import QProvider

            self._providers[key] = QProvider(lexis_project=project, token=token)
        return self._providers[key]

    def _backend(self, p: dict):
        key = (
            p.get("project"),
            p.get("token"),
            p.get("resource") or None,
            p.get("backend") or None,
        )
        if key not in self._backends:
            self._backends[key] = self._provider(p).get_backend(
                lexis_resource=p.get("resource") or None,
                backend_name=p.get("backend") or None,
            )
        return self._backends[key]

    def reset(self, _: dict) -> bool:
        self._providers.clear()
        self._backends.clear()
        return True

    def _job(self, p: dict):
        from qheappe_client.qiskit.qbackend import QJob

        return QJob(self._backend(p), heappe_job_id=int(p["jobId"]), shots=p.get("shots"))

    # --- methods ----------------------------------------------------------

    def check(self, _: dict) -> dict:
        packages = {
            name: _version(name)
            for name in (
                "qaas",
                "qiskit",
                "qiskit-qasm3-import",
                "iqm-client",
                "iqm-pulla",
                "py4lexis",
                "Py4HEAppE",
            )
        }
        data = {
            "python": sys.version.split()[0],
            "executable": sys.executable,
            "packages": packages,
            "qaasOutdated": _is_outdated(packages["qaas"]),
        }
        try:
            import qheappe_client.qprovider  # noqa: F401

            data["importable"] = True
        except Exception as exc:
            data["importable"] = False
            data["importError"] = f"{type(exc).__name__}: {exc}"
        return data

    def backends(self, p: dict) -> list[dict]:
        found = self._provider(p).available_backends(lexis_resource=p.get("resource") or None)

        return [
            {
                "name": name,
                "resource": _attr(meta, "lexis_resource.resource_name"),
                "host": _attr(meta, "host_entity"),
                "clusterId": _attr(meta, "cluster_id"),
                "allocatedUnits": _attr(meta, "allocated_units"),
            }
            for name, meta in found.items()
        ]

    def backendInfo(self, p: dict) -> dict:
        backend = self._backend(p)
        arch = getattr(backend, "architecture", None)
        return {
            "name": backend.name,
            "numQubits": backend.num_qubits,
            "calibrationSetId": str(getattr(arch, "calibration_set_id", "") or "") or None,
        }

    def analyze(self, p: dict) -> dict:
        """Parse OpenQASM 3; with transpile=True also transpile for the backend."""
        from qiskit import qasm3

        try:
            qc = qasm3.loads(p["source"])
        except Exception as exc:
            raise BridgeError(f"OpenQASM 3 parse error: {exc}") from exc
        out: dict[str, Any] = {"original": _circuit_stats(qc)}
        if p.get("transpile"):
            backend = self._backend(p)
            tqc = backend.transpile(qc)
            out["transpiled"] = _circuit_stats(tqc)
            out["transpiledQasm"] = qasm3.dumps(tqc)
            layout = getattr(tqc, "layout", None)
            if layout is not None:
                with contextlib.suppress(Exception):
                    out["layout"] = {
                        str(i): int(phys) for i, phys in enumerate(layout.final_index_layout())
                    }
        return out

    def submit(self, p: dict) -> dict:
        from qiskit import qasm3

        sources = p["sources"]
        circuits = []
        for src in sources:
            try:
                circuits.append(qasm3.loads(src))
            except Exception as exc:
                raise BridgeError(f"OpenQASM 3 parse error: {exc}") from exc
        backend = self._backend(p)
        transpiled = backend.transpile(circuits)
        shots = int(p["shots"])
        job = backend.run(transpiled, shots=shots, job_name=p.get("jobName") or "vscode_qasm_job")
        return {
            "jobId": str(job.job_id()),
            "shots": shots,
            "circuits": len(circuits),
            "calibrationSetId": self.backendInfo(p)["calibrationSetId"],
            "submittedAt": datetime.now(UTC).isoformat(),
        }

    def jobInfo(self, p: dict) -> dict:
        from qheappe_client.utils import HEAppEJobState

        info = self._backend(p)._qclient.get_job_info(int(p["jobId"]))
        return {
            "state": HEAppEJobState.readable(info.get("State", -1)),
            "name": info.get("Name"),
            "tasks": len(info.get("Tasks") or []),
        }

    def listJobs(self, p: dict) -> list[dict]:
        from qheappe_client.utils import HEAppEJobState

        api = self._backend(p)._qclient.job_management_api
        if api is None:
            raise BridgeError("HEAppE job management API is not available for this backend.")
        jobs = api.heappe_job_management_list_jobs_for_current_user_get(
            SessionCode="", Limit=int(p.get("limit", 50))
        )
        out = []
        for job in jobs or []:
            d = _jsonable(job)
            out.append(
                {
                    "jobId": str(d.get("Id")),
                    "name": d.get("Name"),
                    "state": HEAppEJobState.readable(d.get("State", -1)),
                    "createdAt": d.get("CreationTime") or d.get("SubmitTime"),
                    "tasks": len(d.get("Tasks") or []),
                }
            )
        return out

    def cancel(self, p: dict) -> bool:
        self._job(p).cancel()
        return True

    def download(self, p: dict) -> dict:
        """Fetch results of a finished job and write them to p['directory']."""
        state = self.jobInfo(p)["state"]
        if state != "FINISHED":
            raise BridgeError(
                f"Job {p['jobId']} is {state}; results are available once it is FINISHED."
            )
        job = self._job(p)
        with_meas = bool(p.get("withMeasurements"))
        result = job.result(qiskit_legacy=True, with_measurements=with_meas)
        counts = result.get_counts()
        counts = counts if isinstance(counts, list) else [counts]

        directory = Path(p["directory"]).expanduser()
        directory.mkdir(parents=True, exist_ok=True)
        files = {
            "counts.json": counts,
            "raw_artifacts.json": _jsonable(job._cached_raw_results),
            "job.json": {
                "jobId": p["jobId"],
                "project": p.get("project"),
                "resource": p.get("resource"),
                "backend": p.get("backend"),
                "shots": p.get("shots"),
                "withMeasurements": with_meas,
                "downloadedAt": datetime.now(UTC).isoformat(),
                "bitOrder": "Qiskit (rightmost bit = classical bit 0)",
            },
        }
        for name, content in files.items():
            (directory / name).write_text(json.dumps(content, indent=2, default=str))
        return {"directory": str(directory), "files": list(files), "counts": counts}


def serve() -> int:
    proto_in = os.fdopen(os.dup(0), "r", encoding="utf-8")
    proto_out = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)  # library prints (also from C code) go to stderr
    # input()/getpass prompts fail instead of eating requests; stays open for the process lifetime
    sys.stdin = open(os.devnull)  # noqa: SIM115

    server = Server()
    for line in proto_in:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            method = req.get("method", "")
            if method.startswith("_") or not callable(getattr(server, method, None)):
                raise BridgeError(f"Unknown method: {method}")
            result = getattr(server, method)(req.get("params") or {})
            response = {"id": req_id, "result": result}
        except BridgeError as exc:
            response = {"id": req_id, "error": {"type": "BridgeError", "message": str(exc)}}
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            response = {"id": req_id, "error": {"type": type(exc).__name__, "message": str(exc)}}
        proto_out.write(json.dumps(response, default=str) + "\n")
    return 0


if __name__ == "__main__":
    if sys.argv[1:] != ["serve"]:
        sys.stderr.write("usage: qaas_bridge.py serve\n")
        sys.exit(2)
    sys.exit(serve())
