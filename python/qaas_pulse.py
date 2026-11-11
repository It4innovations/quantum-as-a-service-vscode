"""Pulse-level operator catalog: turns operator specs into IQM gate implementations.

An operator spec (from ``.qaas/operators/*.yaml``, parsed by the extension) describes a
custom ``prx`` implementation: the I and Q waveform shapes and their parameters. This module
generates Python source for the waveform and gate classes from a spec. The same source is
executed here (preview, validation, submission) and inserted into user scripts, so both
behave identically.

Every value placed into the generated source is validated: names must be identifiers,
numbers are written with ``repr(float)``, and expressions are parsed and checked against an
allowlist of operations before they are turned back into code. A catalog file therefore
cannot run arbitrary Python.
"""

from __future__ import annotations

import ast
import keyword
import math
import re
import sys
import types
from typing import Any

SCHEMA = "qaas-operator/v1"
SUPPORTED_GATES = ("prx",)
NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,47}$")
PARAM_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
RESERVED_PARAMS = {
    "n_samples",
    "duration",
    "amplitude_i",
    "amplitude_q",
    "modulation_frequency",
    "t",
}

# Functions allowed in expressions -> numpy name.
FUNCTIONS = {
    "sin": "sin",
    "cos": "cos",
    "tan": "tan",
    "arcsin": "arcsin",
    "arccos": "arccos",
    "arctan": "arctan",
    "sinh": "sinh",
    "cosh": "cosh",
    "tanh": "tanh",
    "exp": "exp",
    "log": "log",
    "sqrt": "sqrt",
    "abs": "abs",
    "sign": "sign",
    "minimum": "minimum",
    "maximum": "maximum",
    "clip": "clip",
    "where": "where",
    "heaviside": "heaviside",
}
CONSTANTS = {"pi": "np.pi", "e": "np.e"}
BIN_OPS = (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.Mod)
UNARY_OPS = (ast.UAdd, ast.USub)
COMPARE_OPS = (ast.Lt, ast.LtE, ast.Gt, ast.GtE)

# Built-in IQM waveforms usable by name. Values: (field names in order, time-like fields).
BUILTIN_WAVEFORMS = (
    "Constant",
    "CosineRiseFall",
    "CosineRiseFallDerivative",
    "Gaussian",
    "GaussianDerivative",
    "GaussianSmoothedSquare",
    "TruncatedGaussian",
    "TruncatedGaussianDerivative",
    "TruncatedGaussianSmoothedSquare",
)


class OperatorError(ValueError):
    """Invalid operator spec; the message is meant for the user."""


# --- expressions -----------------------------------------------------------


def compile_expression(expr: str, params: set[str]) -> str:
    """Validate an expression of ``t`` and parameters; return equivalent numpy source.

    ``t`` is time in units of the pulse duration, in [-1/2, 1/2]. Parameters are read
    from the waveform instance (``self.<name>``).
    """
    if not isinstance(expr, str) or not expr.strip():
        raise OperatorError("expression must be a non-empty string")
    if len(expr) > 2000:
        raise OperatorError("expression is too long")
    try:
        tree = ast.parse(expr.strip(), mode="eval")
    except SyntaxError as exc:
        raise OperatorError(f"invalid expression {expr!r}: {exc.msg}") from exc

    class Rewrite(ast.NodeTransformer):
        def generic_visit(self, node: ast.AST) -> ast.AST:
            allowed = (
                ast.Expression,
                ast.BinOp,
                ast.UnaryOp,
                ast.Constant,
                ast.Name,
                ast.Call,
                ast.Compare,
                ast.Load,
                *BIN_OPS,
                *UNARY_OPS,
                *COMPARE_OPS,
            )
            if not isinstance(node, allowed):
                raise OperatorError(f"{type(node).__name__} is not allowed in expressions ({expr!r})")
            return super().generic_visit(node)

        def visit_Constant(self, node: ast.Constant) -> ast.AST:
            if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
                raise OperatorError(f"only numbers are allowed as constants ({expr!r})")
            return node

        def visit_Name(self, node: ast.Name) -> ast.AST:
            if node.id == "t":
                return node
            if node.id in CONSTANTS:
                return ast.parse(CONSTANTS[node.id], mode="eval").body
            if node.id in params:
                return ast.Attribute(value=ast.Name("self", ast.Load()), attr=node.id, ctx=ast.Load())
            raise OperatorError(f"unknown name {node.id!r} in expression; declare it under parameters")

        def visit_Call(self, node: ast.Call) -> ast.AST:
            if not isinstance(node.func, ast.Name) or node.func.id not in FUNCTIONS:
                name = getattr(node.func, "id", "?")
                raise OperatorError(f"function {name!r} is not allowed; use one of {sorted(FUNCTIONS)}")
            if node.keywords:
                raise OperatorError("keyword arguments are not allowed in expressions")
            func = ast.Attribute(value=ast.Name("np", ast.Load()), attr=FUNCTIONS[node.func.id], ctx=ast.Load())
            return ast.Call(func=func, args=[self.visit(a) for a in node.args], keywords=[])

    body = Rewrite().visit(tree).body
    return ast.unparse(ast.fix_missing_locations(body))


# --- spec validation --------------------------------------------------------


def _number(value: Any, what: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise OperatorError(f"{what} must be a finite number, got {value!r}")
    return float(value)


def _builtin_fields(name: str) -> tuple[list[tuple[str, Any]], dict[str, str]]:
    """(fields except n_samples with defaults or MISSING, non-timelike units) of an IQM waveform."""
    import dataclasses

    import iqm.models.playlist.waveforms as waveforms

    if name not in BUILTIN_WAVEFORMS:
        raise OperatorError(f"unknown built-in waveform {name!r}; use one of {list(BUILTIN_WAVEFORMS)}")
    cls = getattr(waveforms, name)
    fields = []
    for f in dataclasses.fields(cls):
        if f.name == "n_samples":
            continue
        default = f.default if f.default is not dataclasses.MISSING else None
        fields.append((f.name, default))
    return fields, dict(cls.non_timelike_attributes())


def normalize_spec(spec: dict) -> dict:
    """Validate a spec and return it with all shape parameters resolved.

    Returns a dict with: name, gate, class_name, params {name: {default, unit}}, i, q.
    """
    if not isinstance(spec, dict):
        raise OperatorError("operator spec must be a mapping")
    if spec.get("schema", SCHEMA) != SCHEMA:
        raise OperatorError(f"unsupported schema {spec.get('schema')!r}; expected {SCHEMA!r}")
    name = spec.get("name")
    if not isinstance(name, str) or not NAME_RE.match(name) or keyword.iskeyword(name):
        raise OperatorError(f"name must match {NAME_RE.pattern} (lower case, digits, underscores), got {name!r}")
    gate = spec.get("gate", "prx")
    if gate not in SUPPORTED_GATES:
        raise OperatorError(f"gate {gate!r} is not supported yet; supported: {list(SUPPORTED_GATES)}")

    params: dict[str, dict[str, Any]] = {}
    for pname, pdef in (spec.get("parameters") or {}).items():
        if (
            not isinstance(pname, str)
            or not PARAM_RE.match(pname)
            or pname in RESERVED_PARAMS
            or keyword.iskeyword(pname)
        ):
            raise OperatorError(f"invalid parameter name {pname!r}")
        pdef = pdef if isinstance(pdef, dict) else {"default": pdef}
        unit = pdef.get("unit", "")
        if unit not in ("", "s", "Hz"):
            raise OperatorError(f"parameter {pname!r}: unit must be '', 's' or 'Hz'")
        params[pname] = {
            "default": _number(pdef.get("default", 0.0), f"default of {pname!r}"),
            "unit": unit,
        }

    waveform = spec.get("waveform") or {}
    if not isinstance(waveform, dict) or "i" not in waveform:
        raise OperatorError("waveform.i is required")

    def shape(key: str) -> dict:
        w = waveform.get(key) or ({"type": "zero"} if key == "q" else None)
        if not isinstance(w, dict) or "type" not in w:
            raise OperatorError(f"waveform.{key} needs a type")
        kind = w["type"]
        if kind == "builtin":
            fields, nta = _builtin_fields(w.get("name", ""))
            for fname, default in fields:
                unit = nta.get(fname, "s")
                if fname in params:
                    if params[fname]["unit"] != unit:
                        raise OperatorError(
                            f"parameter {fname!r} of {w['name']} has unit {unit!r}; declare it with unit {unit!r}"
                        )
                elif default is None:
                    raise OperatorError(
                        f"waveform.{key}: {w['name']} needs parameter {fname!r} (unit {unit!r}); "
                        "add it under parameters"
                    )
                else:
                    params[fname] = {"default": float(default), "unit": unit}
            return {"type": "builtin", "name": w["name"], "fields": [f for f, _ in fields]}
        if kind == "expression":
            return {"type": "expression", "expression": w.get("expression", "")}
        if kind == "samples":
            samples = w.get("samples")
            if not isinstance(samples, list) or not 2 <= len(samples) <= 10000:
                raise OperatorError(f"waveform.{key}.samples must be a list of 2 to 10000 numbers")
            values = [_number(v, f"waveform.{key}.samples item") for v in samples]
            if max(abs(v) for v in values) > 1.0:
                raise OperatorError(f"waveform.{key}.samples must lie in [-1, 1]")
            return {"type": "samples", "samples": values}
        if key == "q" and kind in ("zero", "derivative"):
            return {"type": kind}
        allowed = "builtin, expression, samples" + (", zero, derivative" if key == "q" else "")
        raise OperatorError(f"waveform.{key}.type must be one of: {allowed}")

    i_shape = shape("i")
    q_shape = shape("q")
    names = set(params)
    for s in (i_shape, q_shape):
        if s["type"] == "expression":
            s["code"] = compile_expression(s["expression"], names)
    class_name = "".join(part.capitalize() for part in name.split("_")) or "Operator"
    return {
        "name": name,
        "gate": gate,
        "class_name": class_name,
        "params": params,
        "i": i_shape,
        "q": q_shape,
    }


# --- code generation --------------------------------------------------------

HEADER = """\
import numpy as np
from dataclasses import dataclass

import iqm.models.playlist.waveforms as iqm_waveforms
from iqm.models.playlist.waveforms import Waveform
from iqm.pulse.gates.prx import PRX_CustomWaveforms
"""


def _sample_body(shape: dict, i_class: str) -> list[str]:
    kind = shape["type"]
    if kind == "builtin":
        args = ", ".join(f"{f}=self.{f}" for f in shape["fields"])
        return [f"return iqm_waveforms.{shape['name']}(n_samples=self.n_samples, {args})._sample(t)"]
    if kind == "expression":
        return [f"return np.broadcast_to(np.asarray({shape['code']}, dtype=float), t.shape).copy()"]
    if kind == "samples":
        values = ", ".join(repr(v) for v in shape["samples"])
        return [
            f"points = np.array([{values}])",
            "return np.interp(t, np.linspace(-0.5, 0.5, len(points)), points)",
        ]
    if kind == "zero":
        return ["return np.zeros_like(t)"]
    if kind == "derivative":
        return [
            f"values = np.gradient({i_class}._sample(self, t), t) if len(t) > 1 else np.zeros_like(t)",
            "peak = np.max(np.abs(values))",
            "return values / peak if peak > 0 else values",
        ]
    raise OperatorError(f"unknown waveform type {kind!r}")


def generate_code(specs: list[dict], include_header: bool = True) -> str:
    """Python source defining the waveform and gate classes of the given operators."""
    out = [HEADER] if include_header else []
    for spec in specs:
        s = normalize_spec(spec)
        cn = s["class_name"]
        fields = [f"    {p}: float = {d['default']!r}" for p, d in s["params"].items()]
        nta = {p: d["unit"] for p, d in s["params"].items() if d["unit"] != "s"}
        for suffix, shape in (("I", s["i"]), ("Q", s["q"])):
            body = _sample_body(shape, f"{cn}_I")
            out.append(
                "\n".join(
                    [
                        "",
                        "@dataclass(frozen=True)",
                        f"class {cn}_{suffix}(Waveform):",
                        f'    """{suffix} channel of operator {s["name"]!r} (t in pulse durations, [-1/2, 1/2])."""',
                        "",
                        *fields,
                        "",
                        "    @staticmethod",
                        "    def non_timelike_attributes():",
                        f"        return {nta!r}",
                        "",
                        "    def _sample(self, t):",
                        *[f"        {line}" for line in body],
                        "",
                    ]
                )
            )
        out.append(
            "\n".join(
                [
                    "",
                    f"class {cn}PRX(PRX_CustomWaveforms, wave_i={cn}_I, wave_q={cn}_Q, dependent_waves=True):",
                    f'    """Custom prx implementation {s["name"]!r} from the QaaS operator catalog."""',
                    "",
                ]
            )
        )
    return "\n".join(out)


def build_classes(specs: list[dict]) -> dict[str, dict[str, type]]:
    """Execute generated code; return {operator name: {"I", "Q", "gate"} classes}."""
    module = types.ModuleType(f"qaas_operators_{abs(hash(tuple(s.get('name', '') for s in specs)))}")
    sys.modules[module.__name__] = module
    exec(compile(generate_code(specs), module.__name__, "exec"), module.__dict__)
    result = {}
    for spec in specs:
        cn = normalize_spec(spec)["class_name"]
        result[spec["name"]] = {
            "I": getattr(module, f"{cn}_I"),
            "Q": getattr(module, f"{cn}_Q"),
            "gate": getattr(module, f"{cn}PRX"),
        }
    return result


# --- sampling (preview) -----------------------------------------------------


def sample(spec: dict, values: dict, sample_rate: float) -> dict:
    """Sample I and Q (scaled by the amplitudes) for one locus' calibration values."""
    import numpy as np

    s = normalize_spec(spec)
    classes = build_classes([spec])[s["name"]]
    duration = _number(values.get("duration"), "duration")
    if duration <= 0:
        raise OperatorError("duration must be positive")
    n_samples = round(duration * sample_rate)
    if not 2 <= n_samples <= 100000:
        raise OperatorError(f"{n_samples} samples at {sample_rate:g} S/s; check duration and sample rate")
    kwargs = {}
    for p, d in s["params"].items():
        v = _number(values.get(p, d["default"]), p)
        # Waveforms take time-like values in pulse durations and frequencies in 1/duration.
        kwargs[p] = v / duration if d["unit"] == "s" else v * duration if d["unit"] == "Hz" else v
    amp_i = _number(values.get("amplitude_i", 0.0), "amplitude_i")
    amp_q = _number(values.get("amplitude_q", 0.0), "amplitude_q")
    i = np.asarray(classes["I"](n_samples=n_samples, **kwargs).sample(), dtype=float)
    q = np.asarray(classes["Q"](n_samples=n_samples, **kwargs).sample(), dtype=float)
    scaled_i, scaled_q = amp_i * i, amp_q * q
    peak = float(np.max(np.hypot(scaled_i, scaled_q)))
    return {
        "nSamples": n_samples,
        "timeNs": (np.arange(n_samples) / sample_rate * 1e9).round(4).tolist(),
        "i": scaled_i.round(6).tolist(),
        "q": scaled_q.round(6).tolist(),
        "shapeI": i.round(6).tolist(),
        "shapeQ": q.round(6).tolist(),
        "peak": peak,
        "shapePeakI": float(np.max(np.abs(i))),
        "shapePeakQ": float(np.max(np.abs(q))),
    }


# --- compiler integration ---------------------------------------------------


def register(compiler: Any, operators: list[dict]) -> None:
    """Register operators with an IQM compiler (``add_implementation``)."""
    classes = build_classes([op["spec"] for op in operators])
    for op in operators:
        spec = op["spec"]
        compiler.add_implementation(
            spec.get("gate", "prx"), spec["name"], classes[spec["name"]]["gate"], overwrite=True
        )


def apply_settings(settings: Any, operators: list[dict], use: dict[str, str]) -> None:
    """Write per-locus calibration values into compiler settings and select defaults.

    Args:
        operators: [{"spec": ..., "loci": {locus: {duration, amplitude_i, amplitude_q, ...}}}]
        use: {gate: operator name} to make the default implementation
    """
    for op in operators:
        spec = op["spec"]
        gate = spec.get("gate", "prx")
        node = settings.gates[gate][spec["name"]]
        for locus, values in (op.get("loci") or {}).items():
            node[locus].set_from_dict({k: float(v) for k, v in values.items()})
    for gate, name in use.items():
        settings.gate_definitions[gate].default_implementation = name


LOCUS_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,31}$")


def _calibration_values(operators: list[dict]) -> dict[str, dict[str, dict[str, float]]]:
    out: dict[str, dict[str, dict[str, float]]] = {}
    for op in operators:
        name = normalize_spec(op["spec"])["name"]
        loci = {}
        for locus, values in (op.get("loci") or {}).items():
            if not isinstance(locus, str) or not LOCUS_RE.match(locus):
                raise OperatorError(f"invalid locus name {locus!r}")
            loci[locus] = {}
            for key, value in values.items():
                if not isinstance(key, str) or not PARAM_RE.match(key):
                    raise OperatorError(f"invalid calibration key {key!r} for {locus}")
                loci[locus][key] = _number(value, f"{name}.{locus}.{key}")
        out[name] = loci
    return out


def generate_usage_code(operators: list[dict], use: dict[str, str], note: str = "") -> str:
    """Self-contained code: classes, calibration values and register/apply helpers.

    ``use`` maps a gate to the operator that becomes its default implementation.
    """
    specs = [op["spec"] for op in operators]
    calibration = _calibration_values(operators)
    for gate, name in use.items():
        if gate not in SUPPORTED_GATES or name not in calibration:
            raise OperatorError(f"cannot use {name!r} for {gate!r}")
    gates = {normalize_spec(s)["name"]: (normalize_spec(s)["gate"], normalize_spec(s)["class_name"]) for s in specs}
    lines = [
        "# QaaS pulse-level operators, generated from the workspace catalog (.qaas/operators).",
        *(f"# {line}" for line in note.splitlines() if line),
        "# Usage with QPulla:",
        "#   circuits, compiler = pulla.qiskit_to_iqm(pulla.backend.transpile(qc))",
        "#   register_qaas_operators(compiler)",
        "#   settings = compiler.get_settings(circuits=circuits)",
        "#   apply_qaas_operators(settings)",
        "#   settings.set_shots(1000)",
        "#   run_definition, context = compiler.compile(circuits, settings=settings)",
        "#   job = pulla.submit_playlist(run_definition, context=context)",
        generate_code(specs),
        "",
        f"QAAS_OPERATOR_CALIBRATION = {calibration!r}",
        f"QAAS_OPERATOR_DEFAULTS = {dict(use)!r}",
        "",
        "",
        "def register_qaas_operators(compiler):",
        '    """Make the catalog operators available to an IQM compiler."""',
        *(
            f"    compiler.add_implementation({gate!r}, {name!r}, {cn}PRX, overwrite=True)"
            for name, (gate, cn) in gates.items()
        ),
        "",
        "",
        "def apply_qaas_operators(settings, use_defaults=True):",
        '    """Write the per-qubit calibration into compiler settings; optionally select the defaults."""',
        "    gate_of = " + repr({name: gate for name, (gate, _) in gates.items()}),
        "    for name, loci in QAAS_OPERATOR_CALIBRATION.items():",
        "        for locus, values in loci.items():",
        "            settings.gates[gate_of[name]][name][locus].set_from_dict(values)",
        "    if use_defaults:",
        "        for gate, name in QAAS_OPERATOR_DEFAULTS.items():",
        "            settings.gate_definitions[gate].default_implementation = name",
        "",
    ]
    return "\n".join(lines)


def validate(spec: dict, loci: dict, sample_rate: float) -> list[dict]:
    """Sample every locus; returns [{locus, nSamples, peak, error}]."""
    normalize_spec(spec)
    results = []
    for locus, values in (loci or {}).items():
        try:
            r = sample(spec, values, sample_rate)
            results.append({"locus": locus, "nSamples": r["nSamples"], "peak": r["peak"], "error": None})
        except OperatorError as exc:
            results.append({"locus": locus, "nSamples": 0, "peak": 0.0, "error": str(exc)})
    return results
