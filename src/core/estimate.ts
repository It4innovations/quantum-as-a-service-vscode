/**
 * Billed-time models of the quantum backends whose consumption rules are published. QaaS works with
 * any backend of the LEXIS project's resource; for one without a model it shows no estimate.
 *
 * VLQ (IT4I), from https://docs.it4i.cz/en/docs/clusters/vlq/vlq-consumption-guide:
 *
 *   billed [s] = jobs × max(shots × (350 µs + circuit time), 0.9 s)
 *
 * Circuit time is at most 50 µs, so 400 µs per shot is the worst case. qaas sends every circuit
 * of a batch as its own HEAppE task, so each circuit is counted as one job (each with the 0.9 s
 * minimum). This is the conservative reading.
 */
export interface BillingModel {
  /** Backend name as LEXIS reports it. */
  backend: string;
  /** Per-shot overhead in µs, added to the circuit time. */
  postprocessingUs: number;
  /** Longest circuit time in µs (worst case of the estimate range). */
  maxCircuitUs: number;
  /** Minimum billed seconds per job. */
  minPerJobSeconds: number;
  docsUrl: string;
  docsTitle: string;
}

export const BILLING_MODELS: readonly BillingModel[] = [
  {
    backend: "VLQ",
    postprocessingUs: 350,
    maxCircuitUs: 50,
    minPerJobSeconds: 0.9,
    docsUrl: "https://docs.it4i.cz/en/docs/clusters/vlq/vlq-consumption-guide",
    docsTitle: "VLQ consumption guide",
  },
];

/** The billing model of a backend (case-insensitive), or undefined when none is known. */
export function billingModel(backend: string | undefined): BillingModel | undefined {
  const name = backend?.trim().toLowerCase();
  return name ? BILLING_MODELS.find((m) => m.backend.toLowerCase() === name) : undefined;
}

export interface EstimateInput {
  shots: number;
  /** Circuits per submission; each runs as one job. */
  circuits?: number;
  /** How many times the submission is repeated. */
  submissions?: number;
  /** Known circuit execution time in µs. Omit to get the 0–50 µs range. */
  circuitUs?: number;
}

export interface Estimate {
  /** Billed seconds assuming the shortest circuit time. */
  low: number;
  /** Billed seconds assuming the longest circuit time (use for budgeting). */
  high: number;
  jobs: number;
  shots: number;
  minimumApplies: boolean;
}

export function perJobSeconds(model: BillingModel, shots: number, circuitUs: number): number {
  return Math.max(shots * (model.postprocessingUs + circuitUs) * 1e-6, model.minPerJobSeconds);
}

export function estimate(input: EstimateInput, model: BillingModel): Estimate {
  const shots = Math.max(0, Math.floor(input.shots));
  const jobs = Math.max(1, Math.floor(input.circuits ?? 1)) * Math.max(1, Math.floor(input.submissions ?? 1));
  const clamp = (us: number) => Math.min(Math.max(us, 0), model.maxCircuitUs);
  const lowUs = clamp(input.circuitUs ?? 0);
  const highUs = clamp(input.circuitUs ?? model.maxCircuitUs);
  return {
    low: jobs * perJobSeconds(model, shots, lowUs),
    high: jobs * perJobSeconds(model, shots, highUs),
    jobs,
    shots,
    minimumApplies: shots * (model.postprocessingUs + highUs) * 1e-6 < model.minPerJobSeconds,
  };
}

/** "jobs × max(shots × (350 µs + circuit time ≤ 50 µs), 0.9 s)" for a model. */
export function formulaText(model: BillingModel): string {
  return `jobs × max(shots × (${model.postprocessingUs} µs + circuit time ≤ ${model.maxCircuitUs} µs), ${model.minPerJobSeconds} s)`;
}

export function formatSeconds(s: number): string {
  if (s < 60) {
    return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  }
  return `${(s / 3600).toFixed(2)} h`;
}

/** "0.90 s" when low and high round the same, else "0.36–0.41 s". */
export function formatRange(e: Estimate): string {
  const lo = formatSeconds(e.low);
  const hi = formatSeconds(e.high);
  return lo === hi ? hi : `${lo.replace(/ s$/, "")}–${hi}`;
}
