/**
 * Calibration-set quality metrics (as returned by the bridge's calibrationMetrics) arranged for
 * display: one column per metric with a value per qubit, plus metrics over several components.
 */

export interface CalObservation {
  metric: string;
  locus: string[];
  value: number;
  uncertainty: number | null;
  unit: string;
  invalid?: boolean;
}

export interface CalibrationMetrics {
  calibrationSetId: string;
  dutLabel?: string | null;
  createdAt?: string | null;
  invalid?: boolean;
  observations: CalObservation[];
  backend?: string | null;
  current?: boolean;
  fetchedAt?: string;
}

export interface MetricInfo {
  label: string;
  /** Short column header. */
  short: string;
  better: "higher" | "lower";
  /** Display unit and the factor that converts the raw value to it. */
  unit: string;
  scale: number;
  digits: number;
  group: string;
}

const PERCENT = { unit: "%", scale: 100, digits: 2 };
const MICROSECONDS = { unit: "µs", scale: 1e6, digits: 1 };

/** Known metrics, in display order. Keys are metric names without the component part. */
const KNOWN: [string, Omit<MetricInfo, "unit" | "scale" | "digits"> & { fmt: typeof PERCENT }][] = [
  [
    "characterization.model.t1_time",
    { label: "T1", short: "T1", better: "higher", group: "Coherence", fmt: MICROSECONDS },
  ],
  [
    "characterization.model.t2_time",
    { label: "T2*", short: "T2*", better: "higher", group: "Coherence", fmt: MICROSECONDS },
  ],
  [
    "characterization.model.t2_echo_time",
    { label: "T2 echo", short: "T2e", better: "higher", group: "Coherence", fmt: MICROSECONDS },
  ],
  [
    "metrics.rb.prx.drag_crf.fidelity:par=d1",
    { label: "PRX fidelity (RB)", short: "PRX", better: "higher", group: "Gates", fmt: PERCENT },
  ],
  [
    "metrics.rb.clifford.xy.fidelity",
    { label: "1-qubit Clifford fidelity (RB)", short: "Clifford", better: "higher", group: "Gates", fmt: PERCENT },
  ],
  [
    "metrics.rb.clifford.xy.fidelity:par=d1",
    { label: "1-qubit Clifford fidelity (RB, d1)", short: "Cliff d1", better: "higher", group: "Gates", fmt: PERCENT },
  ],
  [
    "metrics.irb.cz.crf_crf.fidelity",
    { label: "CZ fidelity (IRB)", short: "CZ", better: "higher", group: "Gates", fmt: PERCENT },
  ],
  [
    "metrics.irb.move.crf_crf.fidelity:n_interleaved_gates=2",
    { label: "MOVE fidelity (IRB)", short: "MOVE", better: "higher", group: "Gates", fmt: PERCENT },
  ],
  [
    "metrics.ssro.measure.constant.fidelity",
    { label: "Readout fidelity", short: "Readout", better: "higher", group: "Readout", fmt: PERCENT },
  ],
  [
    "metrics.ssro.measure.constant.error_0_to_1",
    { label: "Readout error 0→1", short: "RO 0→1", better: "lower", group: "Readout", fmt: PERCENT },
  ],
  [
    "metrics.ssro.measure.constant.error_1_to_0",
    { label: "Readout error 1→0", short: "RO 1→0", better: "lower", group: "Readout", fmt: PERCENT },
  ],
  [
    "metrics.ssro.measure_fidelity.constant.fidelity",
    { label: "Readout fidelity (measure_fidelity)", short: "RO mf", better: "higher", group: "Readout", fmt: PERCENT },
  ],
  [
    "metrics.ssro.measure_fidelity.constant.error_0_to_1",
    { label: "Readout error 0→1 (measure_fidelity)", short: "mf 0→1", better: "lower", group: "Readout", fmt: PERCENT },
  ],
  [
    "metrics.ssro.measure_fidelity.constant.error_1_to_0",
    { label: "Readout error 1→0 (measure_fidelity)", short: "mf 1→0", better: "lower", group: "Readout", fmt: PERCENT },
  ],
  [
    "metrics.qndness.measure.constant.fidelity",
    { label: "QND fidelity", short: "QND", better: "higher", group: "Readout", fmt: PERCENT },
  ],
  [
    "metrics.qndness.measure.constant.repeatability",
    { label: "Readout repeatability", short: "Repeat", better: "higher", group: "Readout", fmt: PERCENT },
  ],
  [
    "metrics.qndness.measure.constant.qndness_0",
    { label: "QND-ness |0⟩", short: "QND 0", better: "higher", group: "Readout", fmt: PERCENT },
  ],
  [
    "metrics.qndness.measure.constant.qndness_1",
    { label: "QND-ness |1⟩", short: "QND 1", better: "higher", group: "Readout", fmt: PERCENT },
  ],
  [
    "metrics.ghz_state.population",
    { label: "GHZ state population", short: "GHZ pop", better: "higher", group: "Multi-qubit", fmt: PERCENT },
  ],
  [
    "metrics.ghz_state.population_lower_bound",
    { label: "GHZ population lower bound", short: "GHZ pop ≥", better: "higher", group: "Multi-qubit", fmt: PERCENT },
  ],
  [
    "metrics.ghz_state.coherence_lower_bound",
    { label: "GHZ coherence lower bound", short: "GHZ coh ≥", better: "higher", group: "Multi-qubit", fmt: PERCENT },
  ],
];
const KNOWN_MAP = new Map(KNOWN.map(([k, v], i) => [k, { ...v, order: i }]));

/** Display info for a metric; unknown metrics get a readable label from their name. */
export function metricInfo(metric: string, unit = ""): MetricInfo {
  const known = KNOWN_MAP.get(metric);
  if (known) {
    const { fmt, order: _order, ...rest } = known;
    return { ...rest, ...fmt };
  }
  const [name, modifier] = metric.split(":");
  const parts = name.split(".");
  const last = parts.slice(-2).join(" ").replace(/_/g, " ");
  const label = `${last}${modifier ? ` (${modifier})` : ""}`;
  const lower = /error|infidelity|leakage/i.test(name);
  const fmt =
    unit === "s" ? MICROSECONDS : /fidelity|error|population|repeatability|qndness/i.test(name) ? PERCENT : null;
  return {
    label,
    short: label.length > 12 ? `${label.slice(0, 11)}…` : label,
    better: lower ? "lower" : "higher",
    unit: fmt?.unit ?? unit,
    scale: fmt?.scale ?? 1,
    digits: fmt?.digits ?? 3,
    group: parts[0] === "characterization" ? "Characterization" : "Other",
  };
}

function metricOrder(metric: string): number {
  return KNOWN_MAP.get(metric)?.order ?? 1000;
}

/** QB2 < QB10 */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

const isQubit = (c: string) => /^QB\d+$/.test(c);

export interface QubitColumn {
  /** metric, or metric@component for qubit–resonator metrics (e.g. CZ through COMPR1). */
  id: string;
  metric: string;
  partner?: string;
  info: MetricInfo;
  values: Record<string, { value: number; uncertainty: number | null }>;
}

export interface MultiRow {
  metric: string;
  info: MetricInfo;
  locus: string[];
  value: number;
  uncertainty: number | null;
}

export interface CalibrationTable {
  qubits: string[];
  /** Components that are not qubits (e.g. the resonator COMPR1). */
  others: string[];
  columns: QubitColumn[];
  /** Metrics of non-qubit components alone (e.g. resonator T1). */
  otherRows: MultiRow[];
  multi: MultiRow[];
}

/** Arrange observations into per-qubit columns and multi-component rows. */
export function buildTable(m: CalibrationMetrics): CalibrationTable {
  const qubits = new Set<string>();
  const others = new Set<string>();
  const columns = new Map<string, QubitColumn>();
  const otherRows: MultiRow[] = [];
  const multi: MultiRow[] = [];
  for (const o of m.observations) {
    for (const c of o.locus) {
      (isQubit(c) ? qubits : others).add(c);
    }
    const info = metricInfo(o.metric, o.unit);
    const q = o.locus.filter(isQubit);
    const rest = o.locus.filter((c) => !isQubit(c));
    if (q.length === 1 && rest.length <= 1) {
      const partner = rest[0];
      const id = partner ? `${o.metric}@${partner}` : o.metric;
      let col = columns.get(id);
      if (!col) {
        col = {
          id,
          metric: o.metric,
          partner,
          info: partner ? { ...info, label: `${info.label} with ${partner}` } : info,
          values: {},
        };
        columns.set(id, col);
      }
      col.values[q[0]] = { value: o.value, uncertainty: o.uncertainty };
    } else if (q.length === 0 && o.locus.length === 1) {
      otherRows.push({ metric: o.metric, info, locus: o.locus, value: o.value, uncertainty: o.uncertainty });
    } else {
      multi.push({ metric: o.metric, info, locus: o.locus, value: o.value, uncertainty: o.uncertainty });
    }
  }
  const sortedColumns = [...columns.values()].sort(
    (a, b) => metricOrder(a.metric) - metricOrder(b.metric) || a.id.localeCompare(b.id),
  );
  const byLocus = (a: MultiRow, b: MultiRow) =>
    metricOrder(a.metric) - metricOrder(b.metric) ||
    a.metric.localeCompare(b.metric) ||
    naturalCompare(a.locus.join(" "), b.locus.join(" "));
  return {
    qubits: [...qubits].sort(naturalCompare),
    others: [...others].sort(naturalCompare),
    columns: sortedColumns,
    otherRows: otherRows.sort(byLocus),
    multi: multi.sort(byLocus),
  };
}

export interface ColumnStats {
  count: number;
  min: number;
  max: number;
  median: number;
  /** Qubits from worst to best. */
  ranking: string[];
}

export function columnStats(col: QubitColumn): ColumnStats | undefined {
  const entries = Object.entries(col.values);
  if (entries.length === 0) {
    return undefined;
  }
  const vals = entries.map(([, v]) => v.value).sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  const median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  const sign = col.info.better === "higher" ? 1 : -1;
  const ranking = entries.sort((a, b) => sign * (a[1].value - b[1].value)).map(([q]) => q);
  return { count: vals.length, min: vals[0], max: vals[vals.length - 1], median, ranking };
}

/** 0 = worst, 1 = best within [min, max]. */
export function goodness(info: MetricInfo, value: number, min: number, max: number): number {
  if (max === min) {
    return 1;
  }
  const t = (value - min) / (max - min);
  return info.better === "higher" ? t : 1 - t;
}

export function formatValue(info: MetricInfo, value: number): string {
  return (value * info.scale).toFixed(info.digits);
}

/** Change from `before` to `after` in display units, positive when it improved. */
export function improvement(info: MetricInfo, before: number, after: number): number {
  const d = (after - before) * info.scale;
  return info.better === "higher" ? d : -d;
}

const csvCell = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Tidy CSV: one row per observation, raw SI values plus the display value. */
export function calibrationCsv(m: CalibrationMetrics): string {
  const header = [
    "calibration_set_id",
    "component",
    "metric",
    "label",
    "value",
    "unit",
    "uncertainty",
    "display_value",
    "display_unit",
  ];
  const rows = [...m.observations]
    .sort(
      (a, b) => metricOrder(a.metric) - metricOrder(b.metric) || naturalCompare(a.locus.join("__"), b.locus.join("__")),
    )
    .map((o) => {
      const info = metricInfo(o.metric, o.unit);
      return [
        m.calibrationSetId,
        o.locus.join("__"),
        o.metric,
        info.label,
        o.value,
        o.unit,
        o.uncertainty,
        formatValue(info, o.value),
        info.unit,
      ]
        .map(csvCell)
        .join(",");
    });
  return `${[header.join(","), ...rows].join("\n")}\n`;
}
