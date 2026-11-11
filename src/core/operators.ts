/**
 * Pulse-level operator catalog model: `.qaas/operators/<name>.yaml` files.
 * No VS Code dependencies, so it can be unit-tested.
 */
import { type Document, isMap, isSeq, parseDocument } from "yaml";

export const OPERATOR_SCHEMA = "qaas-operator/v1";
export const CALIBRATION_RESULT_SCHEMA = "qaas-calibration-result/v1";
export const OPERATOR_NAME_RE = /^[a-z][a-z0-9_]{0,47}$/;
export const SUPPORTED_GATES = ["prx"] as const;
export const BUILTIN_WAVEFORMS = [
  "Constant",
  "CosineRiseFall",
  "CosineRiseFallDerivative",
  "Gaussian",
  "GaussianDerivative",
  "GaussianSmoothedSquare",
  "TruncatedGaussian",
  "TruncatedGaussianDerivative",
  "TruncatedGaussianSmoothedSquare",
] as const;

export type LocusValues = Record<string, number>;

export interface ShapeSpec {
  type: "builtin" | "expression" | "samples" | "zero" | "derivative";
  name?: string;
  expression?: string;
  samples?: number[];
}

export interface ParameterSpec {
  default: number;
  unit?: "" | "s" | "Hz";
  description?: string;
}

/**
 * calibrated: values verified by a measurement (e.g. Rabi calibration).
 * draft: unverified values, e.g. seeded from the native gate or migrated from another calibration set.
 */
export type EntryStatus = "calibrated" | "draft";

export interface CalibrationEntry {
  calibrationSetId: string;
  backend?: string;
  status?: EntryStatus;
  updatedAt?: string;
  note?: string;
  migratedFrom?: string;
  /** Qubits whose values were measured (e.g. by a Rabi calibration). The entry is calibrated when all are. */
  verifiedLoci?: string[];
  /** Native gate calibration when this entry was made; used to rescale on migration. */
  reference?: { implementation?: string; loci?: Record<string, LocusValues> };
  loci: Record<string, LocusValues>;
}

export interface OperatorSpec {
  schema?: string;
  name: string;
  gate?: string;
  description?: string;
  parameters?: Record<string, ParameterSpec | number>;
  waveform: { i: ShapeSpec; q?: ShapeSpec };
  calibrations?: CalibrationEntry[];
}

export interface Problem {
  message: string;
  /** Path into the YAML document, for locating the problem. */
  path: (string | number)[];
  severity: "error" | "warning" | "info";
}

export interface ParsedOperator {
  spec?: OperatorSpec;
  doc: Document;
  problems: Problem[];
  /** Offsets of YAML syntax errors. */
  syntaxErrors: { message: string; offset: number }[];
}

/** Native calibration of the current calibration set, as returned by the bridge. */
export interface PulseInfo {
  backend: string;
  calibrationSetId: string;
  nativeImplementation: string;
  qubits: string[];
  loci: Record<string, LocusValues>;
  sampleRate: number;
  granularity: number | null;
  minSamples: number | null;
  fetchedAt: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse and check an operator file. Deep checks (waveforms, expressions) run in Python. */
export function parseOperator(text: string): ParsedOperator {
  const doc = parseDocument(text, { prettyErrors: false });
  const syntaxErrors = doc.errors.map((e) => ({ message: e.message, offset: e.pos[0] }));
  const problems: Problem[] = [];
  if (syntaxErrors.length > 0) {
    return { doc, problems, syntaxErrors };
  }
  const data = doc.toJS() as unknown;
  if (!isObj(data)) {
    problems.push({ message: "An operator file must be a mapping.", path: [], severity: "error" });
    return { doc, problems, syntaxErrors };
  }
  const err = (message: string, path: (string | number)[], severity: Problem["severity"] = "error") =>
    problems.push({ message, path, severity });

  if (data.schema !== undefined && data.schema !== OPERATOR_SCHEMA) {
    err(`Unsupported schema; expected "${OPERATOR_SCHEMA}".`, ["schema"]);
  }
  if (typeof data.name !== "string" || !OPERATOR_NAME_RE.test(data.name)) {
    err("name: lower case letters, digits and underscores, starting with a letter.", ["name"]);
  }
  if (data.gate !== undefined && !SUPPORTED_GATES.includes(data.gate as "prx")) {
    err(`gate: only ${SUPPORTED_GATES.join(", ")} is supported for now.`, ["gate"]);
  }
  const wf = data.waveform;
  if (!isObj(wf) || !isObj(wf.i)) {
    err("waveform.i is required.", ["waveform"]);
  } else {
    for (const key of ["i", "q"] as const) {
      const s = wf[key];
      if (s === undefined) {
        continue;
      }
      if (!isObj(s)) {
        err(`waveform.${key} must be a mapping.`, ["waveform", key]);
        continue;
      }
      const allowed =
        key === "i" ? ["builtin", "expression", "samples"] : ["builtin", "expression", "samples", "zero", "derivative"];
      if (!allowed.includes(String(s.type))) {
        err(`waveform.${key}.type must be one of: ${allowed.join(", ")}.`, ["waveform", key, "type"]);
      } else if (s.type === "builtin" && !BUILTIN_WAVEFORMS.includes(s.name as (typeof BUILTIN_WAVEFORMS)[number])) {
        err(`Unknown built-in waveform; use one of ${BUILTIN_WAVEFORMS.join(", ")}.`, ["waveform", key, "name"]);
      } else if (s.type === "expression" && (typeof s.expression !== "string" || !s.expression.trim())) {
        err("expression must be a non-empty string.", ["waveform", key, "expression"]);
      }
    }
  }
  const cals = data.calibrations;
  if (cals !== undefined && !Array.isArray(cals)) {
    err("calibrations must be a list.", ["calibrations"]);
  } else if (Array.isArray(cals)) {
    cals.forEach((c, i) => {
      if (!isObj(c) || typeof c.calibrationSetId !== "string" || !c.calibrationSetId) {
        err("Each calibration needs a calibrationSetId.", ["calibrations", i]);
        return;
      }
      if (cals.findIndex((x) => isObj(x) && x.calibrationSetId === c.calibrationSetId) !== i) {
        err("Duplicate calibrationSetId; keep one entry per calibration set.", ["calibrations", i, "calibrationSetId"]);
      }
      if (!isObj(c.loci)) {
        err("loci must map qubits to values.", ["calibrations", i, "loci"]);
        return;
      }
      for (const [locus, v] of Object.entries(c.loci)) {
        if (!isObj(v)) {
          err(`${locus}: values must be a mapping.`, ["calibrations", i, "loci", locus]);
          continue;
        }
        for (const req of ["duration", "amplitude_i"]) {
          if (typeof v[req] !== "number") {
            err(`${locus}: ${req} is required.`, ["calibrations", i, "loci", locus]);
          }
        }
        for (const [k, val] of Object.entries(v)) {
          if (typeof val !== "number" || !Number.isFinite(val)) {
            err(`${locus}.${k} must be a number.`, ["calibrations", i, "loci", locus, k]);
          }
        }
      }
    });
  }
  const spec = problems.some((p) => p.severity === "error") ? undefined : (data as unknown as OperatorSpec);
  return { spec, doc, problems, syntaxErrors };
}

/** [start, end] offsets of the node at `path`, or of its closest existing ancestor. */
export function rangeOf(doc: Document, path: (string | number)[]): [number, number] {
  for (let n = path.length; n >= 0; n--) {
    const node = doc.getIn(path.slice(0, n), true) as { range?: [number, number, number] } | undefined;
    if (node?.range) {
      return [node.range[0], node.range[1]];
    }
    if (n > 0) {
      // keys of maps: point at the key when the value is missing
      const parent = doc.getIn(path.slice(0, n - 1), true);
      if (isMap(parent)) {
        const pair = parent.items.find((it) => (it.key as { value?: unknown })?.value === path[n - 1]);
        const keyNode = pair?.key as { range?: [number, number, number] } | undefined;
        if (keyNode?.range) {
          return [keyNode.range[0], keyNode.range[1]];
        }
      }
    }
  }
  return [0, 0];
}

export type CurrentStatus = "current" | "draft" | "stale" | "unknown";

/** How an entry relates to the current calibration set. */
export function entryStatus(entry: CalibrationEntry, currentSetId?: string): CurrentStatus {
  if (!currentSetId) {
    return "unknown";
  }
  if (entry.calibrationSetId !== currentSetId) {
    return "stale";
  }
  return entry.status === "calibrated" ? "current" : "draft";
}

export type OperatorStatus = "ready" | "draft" | "stale" | "uncalibrated" | "unknown";

export function operatorStatus(spec: OperatorSpec, currentSetId?: string): OperatorStatus {
  const cals = spec.calibrations ?? [];
  if (cals.length === 0) {
    return "uncalibrated";
  }
  if (!currentSetId) {
    return "unknown";
  }
  const current = cals.find((c) => c.calibrationSetId === currentSetId);
  if (!current) {
    return "stale";
  }
  return current.status === "calibrated" ? "ready" : "draft";
}

/** Entry for the current set, else the most recently updated one. */
export function pickEntry(spec: OperatorSpec, currentSetId?: string): CalibrationEntry | undefined {
  const cals = spec.calibrations ?? [];
  return (
    cals.find((c) => c.calibrationSetId === currentSetId) ??
    [...cals].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0]
  );
}

export interface MigrationResult {
  entry: CalibrationEntry;
  /** Amplitude scale factor per locus (1 when copied unchanged). */
  factors: Record<string, number>;
  /** Loci copied unchanged because no native reference was available. */
  unscaled: string[];
}

/**
 * New draft entry for the current calibration set, derived from `from`.
 * With `scale`, amplitudes follow the native gate: factor = native amplitude_i now / native amplitude_i then.
 */
export function migrateEntry(
  from: CalibrationEntry,
  info: PulseInfo,
  scale: boolean,
  now = new Date(),
): MigrationResult {
  const factors: Record<string, number> = {};
  const unscaled: string[] = [];
  const loci: Record<string, LocusValues> = {};
  for (const [locus, values] of Object.entries(from.loci)) {
    const before = from.reference?.loci?.[locus]?.amplitude_i;
    const after = info.loci[locus]?.amplitude_i;
    let factor = 1;
    if (scale && typeof before === "number" && typeof after === "number" && before !== 0) {
      factor = after / before;
    } else if (scale) {
      unscaled.push(locus);
    }
    factors[locus] = factor;
    const next = { ...values };
    for (const k of ["amplitude_i", "amplitude_q"]) {
      if (typeof next[k] === "number") {
        next[k] = roundSig(next[k] * factor);
      }
    }
    loci[locus] = next;
  }
  return {
    entry: {
      calibrationSetId: info.calibrationSetId,
      backend: info.backend,
      status: "draft",
      updatedAt: now.toISOString(),
      migratedFrom: from.calibrationSetId,
      verifiedLoci: [],
      note: scale
        ? "Migrated; amplitudes rescaled by the change of the native prx amplitude. Verify before use."
        : "Migrated; values copied unchanged. Verify before use.",
      reference: referenceFrom(info, Object.keys(loci)),
      loci,
    },
    factors,
    unscaled,
  };
}

/** Draft entry seeded from the native gate: same duration, native amplitude as a starting point. */
export function seedEntry(info: PulseInfo, qubits: string[], now = new Date()): CalibrationEntry {
  const loci: Record<string, LocusValues> = {};
  for (const q of qubits) {
    const n = info.loci[q] ?? {};
    loci[q] = { duration: n.duration ?? 40e-9, amplitude_i: n.amplitude_i ?? 0.3, amplitude_q: 0 };
  }
  return {
    calibrationSetId: info.calibrationSetId,
    backend: info.backend,
    status: "draft",
    updatedAt: now.toISOString(),
    note: "Seeded from the native prx gate. Calibrate the amplitude before use.",
    verifiedLoci: [],
    reference: referenceFrom(info, qubits),
    loci,
  };
}

function referenceFrom(info: PulseInfo, qubits: string[]): CalibrationEntry["reference"] {
  const loci: Record<string, LocusValues> = {};
  for (const q of qubits) {
    const n = info.loci[q];
    if (n) {
      loci[q] = Object.fromEntries(
        Object.entries(n).filter(([k]) => ["duration", "amplitude_i", "amplitude_q", "frequency"].includes(k)),
      );
    }
  }
  return { implementation: info.nativeImplementation, loci };
}

function roundSig(x: number): number {
  return Number(x.toPrecision(8));
}

/** Insert or replace the entry for `entry.calibrationSetId`; returns the new YAML text. */
export function upsertEntry(text: string, entry: CalibrationEntry): string {
  const doc = parseDocument(text);
  const cals = doc.get("calibrations", true);
  const node = doc.createNode(entry);
  if (!isSeq(cals)) {
    doc.set("calibrations", doc.createNode([entry]));
  } else {
    const idx = cals.items.findIndex(
      (it) => isMap(it) && (it.get("calibrationSetId") as unknown) === entry.calibrationSetId,
    );
    if (idx >= 0) {
      cals.items[idx] = node;
    } else {
      cals.items.push(node);
    }
  }
  return String(doc);
}

/** Set values of one locus in one entry, keeping comments and other content. */
export function setLocusValues(
  text: string,
  calibrationSetId: string,
  locus: string,
  values: LocusValues,
  patch: Partial<Pick<CalibrationEntry, "status" | "note">> = {},
  now = new Date(),
): string {
  const doc = parseDocument(text);
  const cals = doc.get("calibrations", true);
  if (!isSeq(cals)) {
    throw new Error("The operator has no calibrations.");
  }
  const idx = cals.items.findIndex((it) => isMap(it) && (it.get("calibrationSetId") as unknown) === calibrationSetId);
  if (idx < 0) {
    throw new Error(`No calibration entry for set ${calibrationSetId}.`);
  }
  doc.setIn(["calibrations", idx, "loci", locus], doc.createNode(values));
  doc.setIn(["calibrations", idx, "updatedAt"], now.toISOString());
  for (const [k, v] of Object.entries(patch)) {
    doc.setIn(["calibrations", idx, k], v);
  }
  return String(doc);
}

export function setEntryStatus(text: string, calibrationSetId: string, status: EntryStatus, note?: string): string {
  const doc = parseDocument(text);
  const cals = doc.get("calibrations", true);
  const idx = isSeq(cals)
    ? cals.items.findIndex((it) => isMap(it) && (it.get("calibrationSetId") as unknown) === calibrationSetId)
    : -1;
  if (idx < 0) {
    throw new Error(`No calibration entry for set ${calibrationSetId}.`);
  }
  doc.setIn(["calibrations", idx, "status"], status);
  doc.setIn(["calibrations", idx, "updatedAt"], new Date().toISOString());
  if (status === "calibrated") {
    const loci = doc.getIn(["calibrations", idx, "loci"], true);
    const names = isMap(loci) ? loci.items.map((it) => String((it.key as { value?: unknown }).value)) : [];
    doc.setIn(["calibrations", idx, "verifiedLoci"], doc.createNode(names.sort()));
  }
  if (note !== undefined) {
    doc.setIn(["calibrations", idx, "note"], note);
  }
  return String(doc);
}

/** After a manual edit: the locus is no longer verified, so a calibrated entry becomes a draft. */
export function unverifyLocus(text: string, calibrationSetId: string, locus: string): string {
  const doc = parseDocument(text);
  const cals = doc.get("calibrations", true);
  const idx = isSeq(cals)
    ? cals.items.findIndex((it) => isMap(it) && (it.get("calibrationSetId") as unknown) === calibrationSetId)
    : -1;
  if (idx < 0) {
    return text;
  }
  const verified =
    (doc.getIn(["calibrations", idx, "verifiedLoci"]) as { toJSON(): string[] } | undefined)?.toJSON?.() ?? [];
  if (verified.includes(locus) || doc.getIn(["calibrations", idx, "status"]) === "calibrated") {
    doc.setIn(["calibrations", idx, "verifiedLoci"], doc.createNode(verified.filter((l) => l !== locus)));
    doc.setIn(["calibrations", idx, "status"], "draft");
  }
  return String(doc);
}

export function removeEntry(text: string, calibrationSetId: string): string {
  const doc = parseDocument(text);
  const cals = doc.get("calibrations", true);
  if (isSeq(cals)) {
    cals.items = cals.items.filter(
      (it) => !(isMap(it) && (it.get("calibrationSetId") as unknown) === calibrationSetId),
    );
  }
  return String(doc);
}

/** Spec without calibrations, as sent to the Python bridge. */
export function shapeOnly(spec: OperatorSpec): Omit<OperatorSpec, "calibrations"> {
  const { calibrations: _ignored, ...rest } = spec;
  return rest;
}

/** `// @qaas operator prx=name` directives in OpenQASM source: {gate: operator}. */
export function parseOperatorDirectives(source: string): {
  use: Record<string, string>;
  lines: Record<string, number>;
} {
  const use: Record<string, string> = {};
  const lines: Record<string, number> = {};
  source.split("\n").forEach((line, i) => {
    const m = /^\s*\/\/\s*@qaas\s+operator\s+([a-z]+)\s*=\s*([a-z][a-z0-9_]*)\s*$/.exec(line);
    if (m) {
      use[m[1]] = m[2];
      lines[m[1]] = i;
    }
  });
  return { use, lines };
}

export interface CalibrationResult {
  schema: string;
  operator: string;
  calibrationSetId: string;
  backend?: string;
  locus: string;
  values: LocusValues;
  /** Native gate at calibration time: implementation name plus numeric values. */
  native?: Record<string, number | string>;
  note?: string;
  createdAt?: string;
}

export function isCalibrationResult(v: unknown): v is CalibrationResult {
  return (
    isObj(v) &&
    v.schema === CALIBRATION_RESULT_SCHEMA &&
    typeof v.operator === "string" &&
    typeof v.calibrationSetId === "string" &&
    typeof v.locus === "string" &&
    isObj(v.values)
  );
}

/** Apply a calibration result (from the Rabi notebook) to an operator file. */
export function applyCalibrationResult(text: string, result: CalibrationResult): string {
  const parsed = parseOperator(text);
  const existing = parsed.spec?.calibrations?.find((c) => c.calibrationSetId === result.calibrationSetId);
  const native = result.native ?? {};
  const implementation = typeof native.implementation === "string" ? native.implementation : undefined;
  const nativeValues: LocusValues = Object.fromEntries(
    Object.entries(native).filter((kv): kv is [string, number] => typeof kv[1] === "number"),
  );
  const entry: CalibrationEntry = existing
    ? structuredClone(existing)
    : { calibrationSetId: result.calibrationSetId, backend: result.backend, loci: {} };
  entry.loci = { ...entry.loci, [result.locus]: result.values };
  entry.reference = {
    implementation: implementation ?? entry.reference?.implementation,
    loci: { ...(entry.reference?.loci ?? {}), [result.locus]: nativeValues },
  };
  const verified = new Set([...(entry.verifiedLoci ?? []), result.locus]);
  entry.verifiedLoci = [...verified].sort();
  entry.status = Object.keys(entry.loci).every((l) => verified.has(l)) ? "calibrated" : "draft";
  entry.updatedAt = result.createdAt ?? new Date().toISOString();
  entry.note = result.note ?? entry.note;
  return upsertEntry(text, entry);
}

export interface TemplateOptions {
  name: string;
  template: "drag_gaussian" | "cosine_rise_fall" | "hann_drag" | "expression" | "samples";
  description?: string;
}

/** Text of a new operator file. */
export function operatorTemplate(o: TemplateOptions): string {
  const header = `# QaaS pulse-level operator: a custom implementation of the prx gate.
# Times are in seconds, t in expressions runs over the pulse window [-1/2, 1/2].
# Waveforms are normalized; amplitude_i / amplitude_q in the calibrations scale them.
schema: ${OPERATOR_SCHEMA}
name: ${o.name}
gate: prx
description: ${JSON.stringify(o.description ?? "")}
`;
  const bodies: Record<TemplateOptions["template"], string> = {
    drag_gaussian: `parameters:
  sigma: { default: 1.0e-8, unit: s, description: Gaussian width }
waveform:
  i: { type: builtin, name: Gaussian }
  q: { type: builtin, name: GaussianDerivative }  # DRAG: amplitude_q scales the derivative
`,
    cosine_rise_fall: `parameters:
  full_width: { default: 4.0e-8, unit: s }
  rise_time: { default: 1.0e-8, unit: s }
waveform:
  i: { type: builtin, name: CosineRiseFall }
  q: { type: builtin, name: CosineRiseFallDerivative }
`,
    hann_drag: `waveform:
  i: { type: expression, expression: "cos(pi * t) ** 2" }  # Hann window
  q: { type: derivative }  # normalized derivative of I, for DRAG
`,
    expression: `parameters:
  width: { default: 0.2, description: relative width (dimensionless) }
waveform:
  i: { type: expression, expression: "exp(-0.5 * (t / width) ** 2)" }
  q: { type: zero }
`,
    samples: `waveform:
  i: { type: samples, samples: [0.0, 0.3, 0.8, 1.0, 0.8, 0.3, 0.0] }  # interpolated over the pulse
  q: { type: zero }
`,
  };
  return `${header}${bodies[o.template]}calibrations: []
`;
}
