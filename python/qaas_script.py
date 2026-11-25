"""Run a user's Python script in the WebAssembly runtime (``Run Python File on QPU``).

Used inside Pyodide by ``src/wasm/worker.ts`` (script mode); kept free of Pyodide imports so the
tests run on CPython too. A script runs like ``python script.py``: ``__name__ == "__main__"``, its
folder first on ``sys.path``, the given environment and working directory. ``plt.show()`` saves
the open figures as PNG files, which the extension opens.
"""

from __future__ import annotations

import ast
import importlib.util
import json
import os
import sys
import traceback
from collections.abc import Callable
from pathlib import Path

# Importable in the bundle, but limited there; the extension also lists these (src/scriptRunner.ts).
LIMITED = {
    "qiskit_aer": "Qiskit Aer is not in the WebAssembly runtime (import-only stub): AerSimulator raises. "
    "Use qiskit.primitives.StatevectorSampler or qiskit.quantum_info.Statevector.",
    "multiprocessing": "the WebAssembly runtime cannot start processes; process pools fail.",
    "subprocess": "the WebAssembly runtime cannot start processes.",
    "threading": "the WebAssembly runtime has no threads; starting a thread fails.",
    "concurrent": "the WebAssembly runtime has no threads: ThreadPoolExecutor runs tasks one after another, "
    "ProcessPoolExecutor fails.",
}


def imports(source: str) -> list[tuple[str, int]]:
    """Top-level modules a script imports, with the first line each appears on.

    Relative imports and imports inside ``try:`` (optional imports) are left out."""
    tree = ast.parse(source)
    optional: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Try):
            for child in node.body:
                optional.update(id(n) for n in ast.walk(child))
    found: dict[str, int] = {}
    for node in ast.walk(tree):
        if id(node) in optional:
            continue
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names = [node.module]
        else:
            continue
        for name in names:
            top = name.split(".")[0]
            if top not in found or node.lineno < found[top]:
                found[top] = node.lineno
    return sorted(found.items(), key=lambda item: item[1])


def check(path: str) -> dict:
    """{"missing": [{name, line}], "limited": [{name, line, reason}]} for the script at ``path``."""
    script = Path(path)
    source = script.read_text(encoding="utf-8")
    sys.path.insert(0, str(script.parent))
    try:
        missing, limited = [], []
        for name, line in imports(source):
            if name in LIMITED:
                limited.append({"name": name, "line": line, "reason": LIMITED[name]})
            elif importlib.util.find_spec(name) is None:
                missing.append({"name": name, "line": line})
        return {"missing": missing, "limited": limited}
    finally:
        sys.path.remove(str(script.parent))


def _figure_saver(figures_dir: str, stem: str, notify: Callable[[str], None]) -> Callable[..., None]:
    count = 0

    def show(*_args, **_kwargs) -> None:
        nonlocal count
        import matplotlib.pyplot as plt

        os.makedirs(figures_dir, exist_ok=True)
        for number in plt.get_fignums():
            count += 1
            target = os.path.join(figures_dir, f"{stem}-{count}.png")
            plt.figure(number).savefig(target, dpi=110, bbox_inches="tight")
            print(f"[figure saved: {target}]")
            notify(target)
        plt.close("all")

    return show


def _prepare_matplotlib(figures_dir: str, stem: str, notify: Callable[[str], None]) -> None:
    """Agg backend (no display in a worker); plt.show() saves and reports the figures."""
    os.environ["MPLBACKEND"] = "Agg"
    try:
        import matplotlib
    except ImportError:
        return
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.show = _figure_saver(figures_dir, stem, notify)


def _watch_submissions(notify_job: Callable[[str], None]) -> Callable[[], None]:
    """Report every job the script submits (circuit or pulse-level) while it runs.

    All qaas submissions go through ``QClient.submit_quantum_job``; it is wrapped for the run and
    restored afterwards. ``notify_job`` gets JSON: jobId, name, tasks, shots, kind."""
    try:
        from qheappe_client.qclient import QClient
    except ImportError:
        return lambda: None
    original = QClient.submit_quantum_job

    async def submit(self, tasks, *args, **kwargs):
        job = await original(self, tasks, *args, **kwargs)
        try:
            job_name = kwargs.get("job_name", args[0] if args else "quantum_job")
            names = [str(t.get("Name", "")) for t in tasks]
            shots = next(
                (int(v) for t in tasks if (v := (t.get("EnvironmentVariables") or {}).get("RUN_SHOTS"))),
                None,
            )
            notify_job(
                json.dumps(
                    {
                        "jobId": str(job.get("Id") if isinstance(job, dict) else job),
                        "name": job_name,
                        "tasks": len(tasks),
                        "shots": shots,
                        "kind": "pulse" if any(n.startswith("qpulla") for n in names) else "circuit",
                    }
                )
            )
        except Exception as exc:  # reporting must never break the script
            print(f"[QaaS: job not reported: {exc}]", file=sys.stderr)
        return job

    QClient.submit_quantum_job = submit
    return lambda: setattr(QClient, "submit_quantum_job", original)


def run(
    path: str,
    args: list[str],
    env: dict[str, str],
    cwd: str,
    figures_dir: str,
    notify_figure: Callable[[str], None] = lambda _p: None,
    notify_job: Callable[[str], None] | None = None,
) -> int:
    """Run the script as ``__main__``; returns its exit code. Tracebacks go to stderr."""
    import runpy

    script = str(Path(path))
    os.environ.update(env)
    os.chdir(cwd)
    sys.argv = [script, *args]
    sys.path.insert(0, str(Path(script).parent))
    _prepare_matplotlib(figures_dir, Path(script).stem, notify_figure)
    unwatch = _watch_submissions(notify_job) if notify_job else (lambda: None)
    try:
        runpy.run_path(script, run_name="__main__")
        return 0
    except SystemExit as exc:
        if exc.code is None or isinstance(exc.code, int):
            return exc.code or 0
        print(exc.code, file=sys.stderr)
        return 1
    except BaseException as exc:
        # Show the script's frames, not runpy's.
        tb = exc.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != script:
            tb = tb.tb_next
        traceback.print_exception(type(exc), exc, tb or exc.__traceback__, file=sys.stderr)
        return 1
    finally:
        unwatch()
        sys.stdout.flush()
        sys.stderr.flush()
