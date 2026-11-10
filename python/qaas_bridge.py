"""Bridge between the VS Code extension and the qaas Python package.

The extension runs this script with the user's interpreter. Each command
prints exactly one JSON object on the last line of stdout:
    {"ok": true, "data": ...}  or  {"ok": false, "error": "..."}

Authentication: LEXIS_TOKEN env var if set, otherwise QProvider falls back
to the interactive py4lexis browser login.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from importlib import metadata


def _emit(payload: dict) -> None:
    sys.stdout.write("\n" + json.dumps(payload) + "\n")
    sys.stdout.flush()


def _version(dist: str) -> str | None:
    try:
        return metadata.version(dist)
    except metadata.PackageNotFoundError:
        return None


def cmd_check(_: argparse.Namespace) -> dict:
    data = {
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "packages": {
            name: _version(name)
            for name in ("qaas", "qiskit", "iqm-client", "py4lexis", "Py4HEAppE")
        },
    }
    try:
        import qheappe_client.qprovider  # noqa: F401

        data["importable"] = True
    except Exception as exc:  # report, don't crash
        data["importable"] = False
        data["importError"] = f"{type(exc).__name__}: {exc}"
    return data


def _provider(project: str):
    from qheappe_client.qprovider import QProvider

    return QProvider(lexis_project=project, token=os.environ.get("LEXIS_TOKEN") or None)


def cmd_backends(args: argparse.Namespace) -> list[dict]:
    provider = _provider(args.project)
    backends = provider.available_backends(lexis_resource=args.resource or None)
    result = []
    for name, meta in backends.items():
        result.append(
            {
                "name": name,
                "resource": getattr(meta.lexis_resource, "resource_name", None),
                "host": _safe(lambda: meta.host_entity),
                "clusterId": _safe(lambda: meta.cluster_id),
                "allocatedUnits": _safe(lambda: meta.allocated_units),
            }
        )
    return result


def _safe(fn):
    try:
        return fn()
    except Exception:
        return None


def main() -> int:
    parser = argparse.ArgumentParser(prog="qaas_bridge")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check").set_defaults(func=cmd_check)
    p = sub.add_parser("backends")
    p.add_argument("--project", required=True)
    p.add_argument("--resource", default="")
    p.set_defaults(func=cmd_backends)

    args = parser.parse_args()
    try:
        _emit({"ok": True, "data": args.func(args)})
        return 0
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        _emit({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
