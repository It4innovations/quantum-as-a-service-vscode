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

import atexit
import collections
import contextlib
import csv
import json
import os
import re
import sys
import tempfile
import traceback
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path
from typing import Any

MIN_QAAS = (1, 1, 0)  # the version the extension is built and tested with (environments.ts)
MIN_PYTHON = (3, 12)
# The bridge must start on any Python 3.8+ to report an unsuitable interpreter; datetime.UTC needs 3.11.
UTC = timezone.utc
MAX_SIM_QUBITS = 24
TERMINAL_STATES = {"FINISHED", "FAILED", "CANCELED", "CANCELLED", "DELETED"}


class BridgeError(Exception):
    """Error with a message meant for the user."""

    kind = "BridgeError"


class SignInRequired(BridgeError):
    """workflows mode without an access token from IT4I Workflows."""

    kind = "SignInRequired"


class CancelRefused(BridgeError):
    """HEAppE refused to cancel a job; ``state`` is the job's state when HEAppE names it."""

    kind = "CancelRefused"

    def __init__(self, message: str, state: str | None = None):
        super().__init__(message)
        self.state = state


class EnvironmentProblem(BridgeError):
    """The interpreter cannot run qaas (wrong Python version or missing packages)."""

    kind = "Environment"


# Running in Pyodide (the extension's WebAssembly runtime).
WASM = sys.platform == "emscripten"
QAAS_MODULES = ("qheappe_client", "qaas", "qiskit", "iqm", "py4lexis", "py4heappe")


def _pyodide_label() -> str:
    """Name of the WebAssembly runtime, used where the interpreter path is shown."""
    try:
        import pyodide

        return f"Pyodide {pyodide.__version__} (WebAssembly, bundled with the extension)"
    except Exception:
        return "Pyodide (WebAssembly, bundled with the extension)"


def _environment_problem() -> EnvironmentProblem | None:
    if sys.version_info < MIN_PYTHON:
        need = f"{MIN_PYTHON[0]}.{MIN_PYTHON[1]}"
        return EnvironmentProblem(
            f"Python {sys.version.split()[0]} at {sys.executable} cannot run qaas; it needs Python {need}. "
            f"Select or create a Python {need} environment with qaas."
        )
    return None


def _version(dist: str) -> str | None:
    try:
        return metadata.version(dist)
    except metadata.PackageNotFoundError:
        return None


def _is_outdated(version: str | None) -> bool:
    """True for qaas older than MIN_QAAS, including its pre-releases such as 1.1.0a1."""
    if version is None:
        return False
    match = re.match(r"(\d+(?:\.\d+)*)(.*)", version)
    if not match:
        return False
    release = tuple(int(x) for x in match.group(1).split("."))
    release += (0,) * (3 - len(release))
    pre = bool(re.match(r"\.?(a|b|rc|dev)", match.group(2)))
    return release < MIN_QAAS or (release == MIN_QAAS and pre)


# HEAppE job states qaas's HEAppEJobState does not name. 256 is final: HEAppE calls it "Deleted"
# (e.g. "Cannot cancel job '3751', this job is in state 'Deleted'"); failed jobs can end there too.
EXTRA_JOB_STATES = {256: "DELETED"}


def _job_state(value: Any) -> str:
    """Readable HEAppE job state (FINISHED, RUNNING, ...), including the ones qaas does not know."""
    from qheappe_client.utils import HEAppEJobState

    if isinstance(value, int) and value in EXTRA_JOB_STATES:
        return EXTRA_JOB_STATES[value]
    return HEAppEJobState.readable(value)


def _heappe_detail(text: str) -> str:
    """HEAppE's own message from an error such as '... -> HTTP 400: {"title": ..., "detail": "..."}'."""
    match = re.search(r'"detail"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    detail = json.loads(f'"{match.group(1)}"') if match else text
    return re.sub(r"\s*\(Request ID: \w+\)\.?$", "", detail).strip()


def _forbidden(job_id: Any, exc: Exception) -> BridgeError | None:
    """Readable error for HEAppE's 403 on a job (the signed-in HEAppE user is not its submitter)."""
    text = str(exc)
    if "HTTP 403" not in text:
        return None
    match = re.search(r"Request ID: (\w+)", text)
    request = f", request ID {match.group(1)}" if match else ""
    return BridgeError(
        f"HEAppE refuses access to job {job_id} for the signed-in user (HTTP 403{request}). HEAppE only allows "
        "the job's submitter or a project administrator. If the job was submitted with another LEXIS account or "
        "instance, sign in with that one; if it is yours, report the request ID to the HEAppE administrators."
    )


_LOCUS_PART = re.compile(r"^[A-Z][A-Z-]*\d+(?:__[A-Z][A-Z-]*\d+)*$")


def _split_metric_field(field: str) -> tuple[str, list[str]]:
    """Split an IQM observation field into (metric, locus).

    ``metrics.rb.prx.drag_crf.QB1.fidelity:par=d1`` -> (``metrics.rb.prx.drag_crf.fidelity:par=d1``, [``QB1``]);
    ``metrics.irb.cz.crf_crf.QB4__COMPR1.fidelity`` -> (``metrics.irb.cz.crf_crf.fidelity``, [``QB4``, ``COMPR1``]).
    Fields without a component part keep an empty locus."""
    parts = field.split(".")
    for i, part in enumerate(parts):
        if _LOCUS_PART.match(part):
            return ".".join(parts[:i] + parts[i + 1 :]), part.split("__")
    return field, []


def _normalize_metrics(raw: dict) -> dict:
    observations = []
    for o in raw.get("observations") or []:
        field = o.get("dut_field") or ""
        value = o.get("value")
        if not field or not isinstance(value, (int, float)) or isinstance(value, bool):
            continue
        metric, locus = _split_metric_field(field)
        observations.append(
            {
                "metric": metric,
                "locus": locus,
                "value": float(value),
                "uncertainty": float(o["uncertainty"]) if isinstance(o.get("uncertainty"), (int, float)) else None,
                "unit": o.get("unit") or "",
                "invalid": bool(o.get("invalid")),
            }
        )
    return {
        "calibrationSetId": str(raw.get("describes_id") or ""),
        "dutLabel": raw.get("dut_label"),
        "createdAt": raw.get("created_timestamp"),
        "invalid": bool(raw.get("invalid")),
        "observationSetId": raw.get("observation_set_id"),
        "observations": observations,
    }


def _field(d: dict, snake: str, pascal: str) -> Any:
    """py4heappe models serialize to snake_case; raw HEAppE JSON uses PascalCase."""
    return d.get(snake, d.get(pascal))


def _job_resource(tasks: list) -> str | None:
    """LEXIS resource / HEAppE project of a job (e.g. VLQ-EU), from its first task's node type."""
    for t in tasks:
        node = _field(t, "node_type", "NodeType") or {}
        project = _field(node, "project", "Project") or {}
        name = _field(project, "accounting_string", "AccountingString") or _field(project, "name", "Name")
        if name:
            return str(name)
    return None


def _parse_error(exc: BaseException) -> str:
    """Readable OpenQASM 3 parse error with its position.

    The openqasm3 parser stops at the first syntax error with an empty QASM3ParsingError ("parse
    failed" in some versions); the ANTLR exception it wraps knows the offending token. The editor
    reads "line N, column M" from the message."""
    text = str(exc).strip()
    seen: set[int] = set()
    todo: list = [exc]
    while todo:
        e = todo.pop()
        if e is None or id(e) in seen:
            continue
        seen.add(id(e))
        token = getattr(e, "offendingToken", None)
        if token is not None and getattr(token, "line", None) is not None:
            got = getattr(token, "text", None)
            where = f"line {token.line}, column {token.column}"
            unexpected = "unexpected end of file" if got in (None, "<EOF>") else f"unexpected {got!r}"
            return f"{where}: {unexpected}" + (f" ({text})" if text and text != "parse failed" else "")
        todo += [e.__cause__, e.__context__, *(a for a in getattr(e, "args", ()) if isinstance(a, BaseException))]
    return text or type(exc).__name__


_GATE_CALL = re.compile(r"^\s*move\b", re.M)
_GATE_DEF = re.compile(r"^\s*gate\s+move\b", re.M)
_HEADER = re.compile(r"^\s*(include\s+\"[^\"]*\"\s*;|OPENQASM\s+[\d.]+\s*;)[^\n]*$", re.M)


def _load_qasm(source: str):
    """OpenQASM 3 -> QuantumCircuit, also for IQM-native programs (e.g. a transpiled export).

    Qiskit's importer only knows stdgates.inc: IQM's ``move`` (qubit <-> resonator, e.g. on VLQ) is undefined
    there, so a program calling it fails with "gate 'move' is not defined". Until qaas handles it,
    an empty placeholder definition is added (on the include/OPENQASM line, so error line numbers
    stay right) and the placeholders are then replaced by IQM's MoveGate; ``r`` gates defined by an
    export become Qiskit's RGate again, IQM's native gate."""
    from qiskit import qasm3

    text = source
    if _GATE_CALL.search(source) and not _GATE_DEF.search(source):
        stub = " gate move _qaas_a, _qaas_b {}"
        headers = list(_HEADER.finditer(source))
        if headers:
            end = headers[-1].end()
            text = source[:end] + stub + source[end:]
        else:
            text = stub.strip() + " " + source
    return _native_gates(qasm3.loads(text))


def _native_gates(circuit):
    """Replace the ``move`` placeholders and exported ``r`` definitions by IQM's / Qiskit's gates."""
    from qiskit.circuit.library import RGate

    try:
        from iqm.qiskit_iqm.move_gate import MoveGate
    except ImportError:
        MoveGate = None
    for index, inst in enumerate(circuit.data):
        op = inst.operation
        if op.name == "move" and MoveGate is not None and op.num_qubits == 2 and not op.params:
            circuit.data[index] = inst.replace(operation=MoveGate())
        elif op.name == "r" and op.num_qubits == 1 and len(op.params) == 2 and not isinstance(op, RGate):
            circuit.data[index] = inst.replace(operation=RGate(*op.params))
    return circuit


def _dumps_qasm3(circuit) -> str:
    """OpenQASM 3 text of a transpiled circuit. Native gates without a Qiskit definition
    (IQM's ``move`` to a resonator) are declared as basis gates instead of failing."""
    from qiskit import qasm3

    builtin = {"measure", "barrier", "reset", "delay"}
    opaque = sorted(
        {i.operation.name for i in circuit.data if i.operation.definition is None and i.operation.name not in builtin}
    )
    return qasm3.dumps(circuit, basis_gates=("U", *opaque)) if opaque else qasm3.dumps(circuit)


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


_READOUT_LABEL = re.compile(r"^(?P<qubit>.+?)__(?P<creg>.+)_(?P<size>\d+)_(?P<idx>\d+)_(?P<bit>\d+)$")


class _Memory:
    """Minimal stand-in for a Qiskit Result: per-shot memory of one circuit."""

    def __init__(self, memory: list[str]):
        self._memory = memory

    def get_memory(self, _index: int = 0) -> list[str]:
        return self._memory


def _sweep_memory(sweep: dict) -> tuple[list[str], dict]:
    """Per-shot bitstrings from raw pulse-job readouts, without the compile context.

    Readout labels look like ``QB1__c_2_0_1``: qubit, classical register ``c`` of size 2 (register
    index 0), classical bit 1. Bitstrings follow Qiskit (rightmost = bit 0, registers separated by
    spaces, last register leftmost). For sweeps, the shots of all sweep points are concatenated."""
    import numpy as np

    registers: dict[str, tuple[int, int]] = {}
    columns = []
    labels: dict[str, dict] = {}
    shots = None
    for label, arrays in sweep.items():
        match = _READOUT_LABEL.match(label)
        if not match:
            raise ValueError(f"Unknown readout label {label!r}")
        parts = arrays if isinstance(arrays, (list, tuple)) else [arrays]
        values = np.concatenate([np.asarray(a, dtype=float).ravel() for a in parts])
        if shots is None:
            shots = len(values)
        elif len(values) != shots:
            raise ValueError("The readouts have different numbers of shots.")
        creg, bit = match["creg"], int(match["bit"])
        registers[creg] = (int(match["size"]), int(match["idx"]))
        bits = (values > 0.5).astype(int)
        columns.append((creg, bit, bits))
        labels[label] = {"qubit": match["qubit"], "register": creg, "bit": bit, "p1": float(bits.mean())}
    if not columns or not shots:
        raise ValueError("The job has no readout results.")
    table = {c: np.zeros((shots, size), dtype=int) for c, (size, _) in registers.items()}
    for creg, bit, bits in columns:
        table[creg][:, bit] = bits
    order = sorted(registers, key=lambda c: registers[c][1], reverse=True)
    memory = [" ".join("".join(map(str, table[c][i][::-1])) for c in order) for i in range(shots)]
    return memory, {"readouts": labels, "recordedShots": shots}


def _write_shots_csv(path: Path, job_id: str, result, circuits: int) -> None:
    """One row per shot, with the outcome in ket form and one 0/1 column per classical bit."""
    memories = [[m.replace(" ", "") for m in result.get_memory(i)] for i in range(circuits)]
    width = max((len(m) for mem in memories for m in mem), default=0)
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["job", "circuit", "shot", "outcome", *[f"c{i}" for i in range(width)]])
        for circuit, mem in enumerate(memories):
            for shot, bits in enumerate(mem):
                bits = bits.zfill(width)
                writer.writerow(
                    [
                        job_id,
                        circuit,
                        shot,
                        f"|{bits}⟩",
                        *[bits[width - 1 - i] for i in range(width)],
                    ]
                )


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


def _jwt_claims(token: str) -> dict:
    """Unverified JWT payload, or {} for tokens that are not JWTs."""
    import base64

    try:
        payload = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except Exception:
        return {}


def token_kind(token: str | None) -> str:
    """'login' (no token), 'refresh' (refresh/offline token) or 'access'."""
    if not token:
        return "login"
    return "refresh" if str(_jwt_claims(token).get("typ", "")).lower() in ("refresh", "offline") else "access"


def _instance(p: dict) -> tuple[str | None, str | None, str | None]:
    """(aai_url, api_url, realm) of the LEXIS instance; None means the production default."""
    i = p.get("instance") or {}
    return (
        (i.get("aaiUrl") or "").rstrip("/") or None,
        (i.get("apiUrl") or "").rstrip("/") or None,
        i.get("realm") or None,
    )


LEXIS_LOG = Path(os.environ.get("QAAS_LEXIS_LOG") or Path(tempfile.gettempdir()) / "qaas-vscode-lexis.log")


def _private_log(path: Path) -> Path:
    """Create the py4lexis log readable by the user only, refusing a planted symlink.

    py4lexis opens it with logging.basicConfig (default permissions, follows symlinks); creating
    it first means basicConfig appends to this file and its 0600 mode is kept.
    """
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        os.fchmod(fd, 0o600)  # also tightens a log created by an older version
    except (AttributeError, OSError):  # Windows has no fchmod; ACLs apply there
        pass
    finally:
        os.close(fd)
    return path


def _new_session(token: str | None, aai: str | None, api: str | None, realm: str | None):
    from py4lexis.session import LexisSession

    kwargs: dict[str, Any] = {
        "aai_url": aai,
        "api_url": api,
        "realm": realm,
        "log_file": str(_private_log(LEXIS_LOG)),
        "reraise_exceptions": True,
        "suppress_welcome": True,
    }
    if token:
        kwargs.update(login_method="token", refresh_token=token)
    return LexisSession(**kwargs)


class Server:
    def __init__(self) -> None:
        self._sessions: dict[tuple, Any] = {}
        self._issued: dict[tuple, str] = {}
        self._providers: dict[tuple, Any] = {}
        self._backends: dict[tuple, Any] = {}
        self._pullas: dict[tuple, Any] = {}
        self._pulse_runs: dict[str, tuple[Any, Any]] = {}

    # --- connection -------------------------------------------------------

    def _access_token(self, p: dict) -> str:
        """Access token for the request. Access tokens are used as they are; refresh tokens and the
        browser login go through a py4lexis session that renews the access token when it expires."""
        token = p.get("token") or None
        if token_kind(token) == "access":
            if p.get("auth") == "workflows":
                # A new token from IT4I Workflows every few minutes: drop the clients built with the old one.
                key = ("workflows", *_instance(p))
                old = self._issued.get(key)
                if old and old != token:
                    self._forget(old)
                self._issued[key] = token
            return token
        if p.get("auth") == "workflows":
            # The sign-in belongs to IT4I Workflows; py4lexis is never used in this mode.
            raise SignInRequired("Sign in with IT4I Workflows first (setting qaas.workflowsIntegration is on).")
        aai, api, realm = _instance(p)
        key = (token, aai, api, realm)
        session = self._sessions.get(key)
        if session is None:
            session = _new_session(token, aai, api, realm)
            self._sessions[key] = session
        access = session.get_access_token()
        old = self._issued.get(key)
        if old and old != access:
            self._forget(old)
        self._issued[key] = access
        return access

    def logout(self, p: dict) -> dict:
        """Revoke refresh tokens on the server: every session of this process (including browser
        logins) and the tokens passed in (`tokens`: [{token, instance}]). Access tokens cannot be
        revoked and expire on their own. Local state is cleared even when revoking fails."""
        revoked, skipped, failed = 0, 0, []
        done: set[str] = set()
        for (token, aai, _api, _realm), session in list(self._sessions.items()):
            try:
                session.logout()
                revoked += 1
                if token:
                    done.add(token)
            except Exception as exc:
                failed.append(f"{aai or 'production'}: {exc}")
        for t in p.get("tokens") or []:
            token = t.get("token")
            if not token or token in done:
                continue
            if token_kind(token) == "access":
                skipped += 1
                continue
            aai, api, realm = _instance(t)
            try:
                _new_session(token, aai, api, realm).logout()
                revoked += 1
                done.add(token)
            except Exception as exc:
                failed.append(f"{aai or 'production'}: {exc}")
        for cache in (self._sessions, self._issued, self._providers, self._backends, self._pullas):
            cache.clear()
        return {"revoked": revoked, "skipped": skipped, "failed": failed}

    def _forget(self, access_token: str) -> None:
        """Drop clients built with an access token that has been renewed."""
        for cache in (self._providers, self._backends, self._pullas):
            for k in [k for k in cache if access_token in k]:
                del cache[k]

    def _context(self, p: dict) -> tuple[str, str, str | None]:
        project = p.get("project")
        if not project:
            raise BridgeError("No LEXIS project configured (setting qaas.lexisProject).")
        return project, self._access_token(p), _instance(p)[1]

    def _provider(self, p: dict):
        key = self._context(p)
        if key not in self._providers:
            from qheappe_client.qprovider import QProvider

            project, token, api = key
            kwargs = {"lexis_api_url": api} if api else {}
            self._providers[key] = QProvider(lexis_project=project, token=token, **kwargs)
        return self._providers[key]

    def _backend(self, p: dict):
        key = (*self._context(p), p.get("resource") or None, p.get("backend") or None)
        if key not in self._backends:
            self._backends[key] = self._provider(p).get_backend(
                lexis_resource=p.get("resource") or None,
                backend_name=p.get("backend") or None,
            )
        return self._backends[key]

    def _pulla(self, p: dict):
        key = (*self._context(p), p.get("resource") or None, p.get("backend") or None)
        if key not in self._pullas:
            try:
                self._pullas[key] = self._provider(p).get_pulla(
                    lexis_resource=p.get("resource") or None,
                    backend_name=p.get("backend") or None,
                    job_name=p.get("jobName") or "vscode_pulse_job",
                )
            except NotImplementedError as exc:
                raise BridgeError(str(exc)) from exc
        return self._pullas[key]

    def accessToken(self, p: dict) -> dict:
        """Short-lived access token for a script started from VS Code. Never the refresh token:
        the script's environment is readable by everything it starts."""
        access = self._access_token(p)
        exp = _jwt_claims(access).get("exp")
        return {"token": access, "expiresAt": datetime.fromtimestamp(exp, UTC).isoformat() if exp else None}

    def whoami(self, p: dict) -> dict:
        """Log in (if needed) and describe the connection, without touching HEAppE."""
        aai, api, realm = _instance(p)
        token = p.get("token") or None
        claims = _jwt_claims(self._access_token(p))
        exp = claims.get("exp")
        return {
            "user": claims.get("preferred_username") or claims.get("sub"),
            "issuer": claims.get("iss"),
            "expiresAt": datetime.fromtimestamp(exp, UTC).isoformat() if exp else None,
            "tokenKind": token_kind(token),
            "aaiUrl": aai,
            "apiUrl": api,
            "realm": realm,
        }

    def reset(self, _: dict) -> bool:
        self._sessions.clear()
        self._issued.clear()
        self._providers.clear()
        self._backends.clear()
        self._pullas.clear()
        return True

    def _job(self, p: dict, memory: bool = False):
        from qheappe_client.qiskit.qbackend import QJob

        # qaas >= 1.1: per-shot results are a property of the job (memory=True), result() takes no arguments.
        return QJob(self._backend(p), heappe_job_id=int(p["jobId"]), shots=p.get("shots"), memory=memory)

    # --- methods ----------------------------------------------------------

    def check(self, p: dict) -> dict:
        names = ["qaas", "qiskit", "qiskit-qasm3-import", "iqm-client", "iqm-pulla", "py4lexis", "Py4HEAppE"]
        if p.get("auth") == "workflows":
            names.remove("py4lexis")  # not used: IT4I Workflows signs in
        packages = {name: _version(name) for name in names}
        data = {
            "runtime": "wasm" if WASM else "python",
            "pythonOk": sys.version_info >= MIN_PYTHON,
            "python": sys.version.split()[0],
            "executable": _pyodide_label() if WASM else sys.executable,
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

        try:
            qc = _load_qasm(p["source"])
        except Exception as exc:
            raise BridgeError(f"OpenQASM 3 parse error: {_parse_error(exc)}") from exc
        out: dict[str, Any] = {"original": _circuit_stats(qc)}
        if p.get("transpile"):
            backend = self._backend(p)
            tqc = backend.transpile(qc)
            out["transpiled"] = _circuit_stats(tqc)
            out["transpiledQasm"] = _dumps_qasm3(tqc)
            layout = getattr(tqc, "layout", None)
            if layout is not None:
                with contextlib.suppress(Exception):
                    out["layout"] = {str(i): int(phys) for i, phys in enumerate(layout.final_index_layout())}
        return out

    def submit(self, p: dict) -> dict:

        sources = p["sources"]
        circuits = []
        for src in sources:
            try:
                circuits.append(_load_qasm(src))
            except Exception as exc:
                raise BridgeError(f"OpenQASM 3 parse error: {_parse_error(exc)}") from exc
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

        try:
            info = self._backend(p)._qclient.get_job_info(int(p["jobId"]))
        except Exception as exc:
            if problem := _forbidden(p["jobId"], exc):
                raise problem from exc
            raise
        return {
            "state": _job_state(info.get("State", -1)),
            "name": info.get("Name"),
            "tasks": len(info.get("Tasks") or []),
        }

    def _heappe_user_id(self, qclient) -> int | None:
        """HEAppE id of the signed-in user (CurrentUserInfo), or None if it cannot be read."""
        try:
            from py4heappe.heappe_v6.core.api.user_and_limitation_management_api import (
                UserAndLimitationManagementApi,
            )

            info = UserAndLimitationManagementApi(
                qclient.heappe_client
            ).heappe_user_and_limitation_management_current_user_info_get(SessionCode="")
            d = _jsonable(info)
            user_id = d.get("id", d.get("Id"))
            return int(user_id) if user_id is not None else None
        except Exception as exc:
            print(f"[bridge] could not read the HEAppE user id: {exc}", file=sys.stderr)
            return None

    def listJobs(self, p: dict) -> list[dict]:
        """Jobs HEAppE lists for the signed-in user, each marked ``own`` or not.

        ListJobsForCurrentUser returns every user's jobs when the user is a Manager or Administrator
        in any HEAppE group, but only the submitter (or a project Administrator) can read them. Own
        jobs are those returned with ``UserId`` = the signed-in HEAppE user."""

        qclient = self._backend(p)._qclient
        api = qclient.job_management_api
        if api is None:
            raise BridgeError("HEAppE job management API is not available for this backend.")
        limit = int(p.get("limit", 50))
        listed = api.heappe_job_management_list_jobs_for_current_user_get(SessionCode="", Limit=limit)
        user_id = self._heappe_user_id(qclient)
        own_ids: set[str] | None = None
        mine = []
        if user_id is not None:
            mine = api.heappe_job_management_list_jobs_for_current_user_get(SessionCode="", Limit=limit, UserId=user_id)
            own_ids = {str(_field(_jsonable(j), "id", "Id")) for j in mine or []}
        jobs: dict[str, dict] = {}
        for job in [*(listed or []), *(mine or [])]:
            d = _jsonable(job)
            job_id = str(_field(d, "id", "Id"))
            if job_id in jobs:
                continue
            state = _field(d, "state", "State")
            tasks = _field(d, "tasks", "Tasks") or []
            jobs[job_id] = {
                "jobId": job_id,
                "name": _field(d, "name", "Name"),
                "state": _job_state(state if state is not None else -1),
                "createdAt": _field(d, "creation_time", "CreationTime") or _field(d, "submit_time", "SubmitTime"),
                "tasks": len(tasks),
                "resource": _job_resource(tasks),
                "kind": "pulse" if any("pulse" in str(_field(t, "name", "Name") or "") for t in tasks) else "circuit",
                # without the user id, keep the old behaviour and treat every listed job as own
                "own": own_ids is None or job_id in own_ids,
            }
        return sorted(jobs.values(), key=lambda j: j["createdAt"] or "", reverse=True)

    def cancel(self, p: dict) -> bool:
        # QJob.cancel() in qaas 1.0.0 calls the coroutine QClient.cancel_job without awaiting it,
        # so the request is never sent. Run it on the client's loop instead.
        import inspect
        import logging

        qclient = self._backend(p)._qclient
        # qaas logs HEAppE's refusal and returns False; keep the logged reason for the user.
        errors: list[str] = []
        handler = logging.Handler(logging.ERROR)
        handler.emit = lambda record: errors.append(record.getMessage())  # type: ignore[method-assign]
        # qheappe_client.qclient builds its logger from the Logger class, outside the logging
        # hierarchy (nothing propagates to "qheappe_client"): attach to that object itself.
        loggers = {logging.getLogger("qheappe_client")}
        module_log = getattr(sys.modules.get("qheappe_client.qclient"), "log", None)
        if isinstance(module_log, logging.Logger):
            loggers.add(module_log)
        for logger in loggers:
            logger.addHandler(handler)
        try:
            result = qclient.cancel_job(int(p["jobId"]))
            if inspect.iscoroutine(result):
                result = qclient._run(result)
        finally:
            for logger in loggers:
                logger.removeHandler(handler)
        if result is False:
            reason = _heappe_detail(errors[-1]) if errors else ""
            state = re.search(r"in state '(\w+)'", reason)
            raise CancelRefused(
                f"HEAppE did not accept cancelling job {p['jobId']}"
                + (f": {reason}" if reason else "; the reason is in the QaaS output channel."),
                state.group(1).upper() if state else None,
            )
        return True

    def download(self, p: dict) -> dict:
        """Fetch results of a finished job and write them to p['directory']."""
        state = self.jobInfo(p)["state"]
        if state != "FINISHED":
            raise BridgeError(f"Job {p['jobId']} is {state}; results are available once it is FINISHED.")
        with_meas = bool(p.get("withMeasurements"))
        job = self._job(p, memory=with_meas)
        try:
            result = job.result()
        except Exception as exc:
            if problem := _forbidden(p["jobId"], exc):
                raise problem from exc
            text = str(exc)
            if "measurement_counts" in text and "404" in text:
                raise BridgeError(
                    f"HEAppE has no circuit results (measurement counts) for job {p['jobId']}. It is probably a "
                    "pulse-level job (QPulla, e.g. named qpulla_job): its raw results can only be turned into counts "
                    "with the circuits and settings it was compiled with, which are known only to the session that "
                    "submitted it."
                ) from exc
            raise
        counts = result.get_counts()
        counts = counts if isinstance(counts, list) else [counts]

        return _write_results(p, counts, result, _jsonable(job._cached_raw_results), with_meas)

    def simulate(self, p: dict) -> list[dict[str, float]]:
        """Exact outcome probabilities of OpenQASM 3 circuits (ideal, noiseless).

        Supports unitary circuits with final measurements. Keys use Qiskit bit order
        (rightmost = classical bit 0); unmeasured classical bits are 0.
        """
        from qiskit import QuantumCircuit
        from qiskit.quantum_info import Statevector

        out = []
        for index, src in enumerate(p["sources"]):
            try:
                qc = _load_qasm(src)
            except Exception as exc:
                raise BridgeError(f"Circuit {index}: OpenQASM 3 parse error: {_parse_error(exc)}") from exc
            if qc.num_qubits > MAX_SIM_QUBITS:
                raise BridgeError(
                    f"Circuit {index} has {qc.num_qubits} qubits; ideal simulation is limited to {MAX_SIM_QUBITS}."
                )
            if qc.num_parameters:
                raise BridgeError(f"Circuit {index} has unbound parameters.")
            body = QuantumCircuit(qc.num_qubits)
            measured: dict[int, int] = {}  # clbit -> qubit
            for inst in qc.data:
                name = inst.operation.name
                qubits = [qc.find_bit(q).index for q in inst.qubits]
                if name == "measure":
                    measured[qc.find_bit(inst.clbits[0]).index] = qubits[0]
                elif name == "barrier":
                    continue
                elif inst.clbits or name == "reset" or set(qubits) & set(measured.values()):
                    raise BridgeError(
                        f"Circuit {index}: ideal simulation supports only unitary circuits with "
                        f"final measurements (found '{name}' after or with classical bits)."
                    )
                else:
                    body.append(inst.operation, qubits)
            clbits = sorted(measured)
            probs = Statevector(body).probabilities_dict(qargs=[measured[c] for c in clbits])
            dist: dict[str, float] = {}
            for key, prob in probs.items():
                if prob < 1e-12:
                    continue
                bits = ["0"] * qc.num_clbits  # index = classical bit
                for k, c in enumerate(clbits):
                    bits[c] = key[len(key) - 1 - k]
                outcome = "".join(reversed(bits))
                dist[outcome] = dist.get(outcome, 0.0) + float(prob)
            out.append(dist)
        return out

    # --- pulse level ------------------------------------------------------

    def pulseSample(self, p: dict) -> dict:
        import qaas_pulse

        try:
            return qaas_pulse.sample(p["spec"], p.get("values") or {}, float(p.get("sampleRate") or 2e9))
        except qaas_pulse.OperatorError as exc:
            raise BridgeError(str(exc)) from exc

    def pulseValidate(self, p: dict) -> list[dict]:
        import qaas_pulse

        try:
            return qaas_pulse.validate(p["spec"], p.get("loci") or {}, float(p.get("sampleRate") or 2e9))
        except qaas_pulse.OperatorError as exc:
            raise BridgeError(str(exc)) from exc

    def pulseCode(self, p: dict) -> str:
        import qaas_pulse

        try:
            return qaas_pulse.generate_usage_code(p["operators"], p.get("use") or {}, p.get("note") or "")
        except qaas_pulse.OperatorError as exc:
            raise BridgeError(str(exc)) from exc

    def calibrationMetrics(self, p: dict) -> dict:
        """Quality metrics of a calibration set (current one when p['calibrationSetId'] is empty)."""
        cal = p.get("calibrationSetId") or None
        qclient = self._backend(p)._qclient
        try:
            raw = qclient.get_machine_metrics(calibration_set_id=cal)
        except Exception as exc:
            if "calibration_set_not_found" in str(exc):
                raise BridgeError(
                    f"Calibration set {cal} is not available on {p.get('backend') or 'this backend'}; "
                    "the quantum computer no longer serves it."
                ) from exc
            raise
        if not isinstance(raw, dict):
            raise BridgeError("The backend returned no calibration metrics.")
        out = _normalize_metrics(raw)
        out["backend"] = p.get("backend")
        out["current"] = cal is None
        out["fetchedAt"] = datetime.now(UTC).isoformat()
        return out

    def pulseInfo(self, p: dict) -> dict:
        """Current calibration set, native prx calibration per qubit and drive channel limits."""
        from qiskit import QuantumCircuit

        pulla = self._pulla(p)
        compiler = pulla.get_qiskit_compiler()
        settings = compiler.get_settings(circuits=[QuantumCircuit(1, 1)])
        native = str(settings.gate_definitions.prx.default_implementation.value)
        qubits = list(pulla.get_chip_topology().qubits_sorted)
        loci = {}
        for q in qubits:
            entry: dict[str, Any] = {}
            with contextlib.suppress(Exception):
                node = settings.gates.prx[native][q]
                for key in ("duration", "amplitude_i", "amplitude_q"):
                    with contextlib.suppress(Exception):
                        entry[key] = float(getattr(node, key).value)
            with contextlib.suppress(Exception):
                entry["frequency"] = float(settings.controllers[q].drive.frequency.value)
            loci[q] = entry
        sample_rate, granularity, minimum = 2e9, None, None
        with contextlib.suppress(Exception):
            props = pulla._executor.get_channel_properties()
            drive = next(v for k, v in props.items() if "drive" in k.lower())
            sample_rate = float(drive.sample_rate)
            granularity = int(drive.instruction_duration_granularity)
            minimum = int(drive.instruction_duration_min)
        return {
            "backend": pulla.quantum_computer_name,
            "calibrationSetId": str(pulla.backend.architecture.calibration_set_id),
            "nativeImplementation": native,
            "qubits": qubits,
            "loci": loci,
            "sampleRate": sample_rate,
            "granularity": granularity,
            "minSamples": minimum,
            "fetchedAt": datetime.now(UTC).isoformat(),
        }

    def _compile_pulse(self, p: dict):
        """Compile OpenQASM 3 circuits with catalog operators. Returns (pulla, run_definition, context, n)."""
        import qaas_pulse

        circuits_q = []
        for index, src in enumerate(p.get("sources") or []):
            try:
                circuits_q.append(_load_qasm(src))
            except Exception as exc:
                raise BridgeError(f"Circuit {index}: OpenQASM 3 parse error: {_parse_error(exc)}") from exc
        if not circuits_q:
            raise BridgeError("No OpenQASM 3 sources for this pulse job.")
        operators, use = p.get("operators") or [], p.get("use") or {}
        pulla = self._pulla(p)
        circuits, compiler = pulla.qiskit_to_iqm(pulla.backend.transpile(circuits_q))
        try:
            qaas_pulse.register(compiler, operators)
        except qaas_pulse.OperatorError as exc:
            raise BridgeError(str(exc)) from exc
        _check_loci(circuits, operators, use)
        settings = compiler.get_settings(circuits=circuits)
        qaas_pulse.apply_settings(settings, operators, use)
        settings.set_shots(int(p["shots"]))
        run_definition, context = compiler.compile(circuits, settings=settings)
        return pulla, run_definition, context, len(circuits)

    def submitPulse(self, p: dict) -> dict:
        """Compile OpenQASM 3 circuits with catalog operators and submit them as a pulse-level job."""
        pulla, run_definition, context, n = self._compile_pulse(p)
        job = pulla.submit_playlist(run_definition, context=context)
        job_id = str(job.job_id.int)
        # The compile context maps readout results to classical bits; HEAppE does not keep it.
        self._pulse_runs[job_id] = (run_definition, context)
        return {
            "jobId": job_id,
            "shots": int(p["shots"]),
            "circuits": n,
            "calibrationSetId": str(pulla.backend.architecture.calibration_set_id),
            "submittedAt": datetime.now(UTC).isoformat(),
        }

    def _download_pulse_raw(self, p: dict, pulla) -> dict:
        """Counts of a pulse job submitted elsewhere, rebuilt from its raw readouts."""
        from uuid import UUID

        sweep = pulla.executor.get_artifact_sweep_results(UUID(int=int(p["jobId"])))
        try:
            memory, summary = _sweep_memory(sweep)
        except ValueError as exc:
            raise BridgeError(f"Pulse job {p['jobId']}: {exc}") from exc
        counts = [dict(collections.Counter(memory))]
        raw = _pulse_raw_summary(p, summary)
        with_meas = bool(p.get("withMeasurements"))
        out = _write_results(p, counts, _Memory(memory), raw, with_meas)
        out["note"] = raw["note"]
        return out

    def downloadPulse(self, p: dict) -> dict:
        """Results of a finished pulse-level job, as counts (same files as circuit jobs).

        Converting raw sweep results to counts needs the compile context. It is kept for jobs
        submitted by this bridge process; otherwise the job is recompiled from the stored
        sources and operators (p['sources'], p['operators'], p['use'])."""
        from uuid import UUID

        from iqm.station_control.client.job_trackers import RunJobTracker

        state = self.jobInfo(p)["state"]
        if state != "FINISHED":
            raise BridgeError(f"Job {p['jobId']} is {state}; results are available once it is FINISHED.")
        shots = int(p.get("shots") or 0)
        job_id = str(p["jobId"])
        if not shots and job_id not in self._pulse_runs and not p.get("sources"):
            return self._download_pulse_raw(p, self._pulla(p))
        if not shots:
            raise BridgeError("The number of shots of this pulse job is unknown.")
        run = self._pulse_runs.get(job_id)
        pulla = self._pulla(p)
        if run is None:
            if not p.get("sources"):
                return self._download_pulse_raw(p, pulla)
            pulla, run_definition, context, _ = self._compile_pulse({**p, "shots": shots})
            run = (run_definition, context)
            self._pulse_runs[job_id] = run
        uuid = UUID(int=int(job_id))
        executor = pulla.executor
        tracker = RunJobTracker(job_data=executor.get_job(uuid), _executor=executor, _context=run[1], _payload=run[0])
        result = pulla.sweep_job_to_qiskit(tracker, shots=shots)
        counts = result.get_counts()
        counts = counts if isinstance(counts, list) else [counts]
        return _write_results(p, counts, result, None, bool(p.get("withMeasurements")))


def _pulse_raw_summary(p: dict, summary: dict) -> dict:
    shots = int(p.get("shots") or 0)
    recorded = summary["recordedShots"]
    note = f"Counts rebuilt from the raw readouts ({recorded} recorded shots)."
    if shots and recorded > shots and recorded % shots == 0:
        note += f" The job swept {recorded // shots} points of {shots} shots; their shots are combined."
    elif not shots:
        note += " If the job was a parameter sweep, the shots of all sweep points are combined."
    return {**summary, "note": note}


def _check_loci(circuits, operators: list[dict], use: dict[str, str]) -> None:
    """Every qubit a selected operator acts on needs calibration values."""
    by_name = {op["spec"]["name"]: op for op in operators}
    for gate, name in use.items():
        calibrated = set((by_name.get(name, {}).get("loci") or {}).keys())
        used = set()
        with contextlib.suppress(AttributeError, TypeError):
            for circuit in circuits:
                for inst in circuit.instructions:
                    if inst.name == gate:
                        used.update(inst.locus)
        missing = sorted(used - calibrated)
        if missing:
            raise BridgeError(
                f"Operator {name!r} has no calibration for {', '.join(missing)}, used by the circuit. "
                f"Calibrated: {', '.join(sorted(calibrated)) or 'none'}."
            )


def _write_results(p: dict, counts: list, result, raw, with_meas: bool) -> dict:
    directory = Path(p["directory"]).expanduser()
    directory.mkdir(parents=True, exist_ok=True)
    files = {
        "counts.json": counts,
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
    if raw is not None:
        files["raw_artifacts.json"] = raw
    for name, content in files.items():
        (directory / name).write_text(json.dumps(content, indent=2, default=str))
    written = list(files)
    if with_meas:
        try:
            _write_shots_csv(directory / "shots.csv", p["jobId"], result, len(counts))
            written.append("shots.csv")
        except Exception as exc:  # per-shot data is optional
            print(f"[download] no per-shot measurements: {exc}", file=sys.stderr)
    return {"directory": str(directory), "files": written, "counts": counts}


def _close_heappe_clients() -> None:
    """Close py4heappe ApiClient thread pools while the interpreter is still intact.

    ApiClient.__del__ closes its ThreadPool; run during interpreter shutdown it fails with
    "'NoneType' object has no attribute ..." tracebacks. Closing them first, and making
    __del__ tolerant, keeps the output channel clean."""
    import gc

    for name, module in list(sys.modules.items()):
        if not (name.startswith("py4heappe.") and name.endswith(".api_client")):
            continue
        cls = getattr(module, "ApiClient", None)
        if cls is None or getattr(cls, "_qaas_quiet", False):
            continue
        original = cls.__del__

        def quiet_del(self, _original=original):
            with contextlib.suppress(Exception):
                _original(self)

        cls.__del__ = quiet_del
        cls._qaas_quiet = True
        for obj in gc.get_objects():
            if isinstance(obj, cls):
                with contextlib.suppress(Exception):
                    obj.pool.close()
                    obj.pool.join()


def handle(server: Server, line: str) -> str | None:
    """Answer one JSON request line; None for a blank line. Shared by `serve` and the
    WebAssembly runtime, which calls it from a Node worker thread instead of a pipe."""
    line = line.strip()
    if not line:
        return None
    req_id = None
    try:
        req = json.loads(line)
        req_id = req.get("id")
        method = req.get("method", "")
        if method.startswith("_") or not callable(getattr(server, method, None)):
            raise BridgeError(f"Unknown method: {method}")
        if method != "check" and (problem := _environment_problem()):
            raise problem
        try:
            result = getattr(server, method)(req.get("params") or {})
        except ModuleNotFoundError as exc:
            if (exc.name or "").split(".")[0] not in QAAS_MODULES:
                raise
            raise EnvironmentProblem(
                f"{exc.name} is not installed in {sys.executable}. Install qaas into this environment "
                "or select another interpreter."
            ) from exc
        response = {"id": req_id, "result": result}
    except BridgeError as exc:
        error = {"type": exc.kind, "message": str(exc)}
        if getattr(exc, "state", None):
            error["state"] = exc.state  # CancelRefused: the job's state as HEAppE names it
        response = {"id": req_id, "error": error}
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        response = {"id": req_id, "error": {"type": type(exc).__name__, "message": str(exc)}}
    return json.dumps(response, default=str)


def serve() -> int:
    proto_in = os.fdopen(os.dup(0), "r", encoding="utf-8")
    proto_out = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)  # library prints (also from C code) go to stderr
    # input()/getpass prompts fail instead of eating requests; stays open for the process lifetime
    sys.stdin = open(os.devnull)  # noqa: SIM115

    server = Server()
    for line in proto_in:
        response = handle(server, line)
        if response is not None:
            proto_out.write(response + "\n")
    _close_heappe_clients()
    return 0


if __name__ == "__main__":
    if sys.argv[1:] != ["serve"]:
        sys.stderr.write("usage: qaas_bridge.py serve\n")
        sys.exit(2)
    atexit.register(_close_heappe_clients)
    sys.exit(serve())
