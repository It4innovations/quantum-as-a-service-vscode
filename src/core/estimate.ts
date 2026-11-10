/**
 * VLQ billing model, from https://docs.it4i.cz/en/docs/clusters/vlq/vlq-consumption-guide
 *
 *   billed [s] = VLQ jobs × max(shots × (350 µs + circuit time), 0.9 s)
 *
 * Circuit time is at most 50 µs, so 400 µs per shot is the worst case.
 * qaas sends every circuit of a batch as its own HEAppE task, so each circuit is
 * counted here as one VLQ job (each with the 0.9 s minimum). This is the conservative reading.
 */
export const VLQ_BILLING = {
  postprocessingUs: 350,
  maxCircuitUs: 50,
  minPerJobSeconds: 0.9,
  docsUrl: "https://docs.it4i.cz/en/docs/clusters/vlq/vlq-consumption-guide",
} as const;

export interface EstimateInput {
  shots: number;
  /** Circuits per submission; each runs as one VLQ job. */
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
  vlqJobs: number;
  shots: number;
  minimumApplies: boolean;
}

export function perJobSeconds(shots: number, circuitUs: number): number {
  return Math.max(shots * (VLQ_BILLING.postprocessingUs + circuitUs) * 1e-6, VLQ_BILLING.minPerJobSeconds);
}

export function estimate(input: EstimateInput): Estimate {
  const shots = Math.max(0, Math.floor(input.shots));
  const vlqJobs = Math.max(1, Math.floor(input.circuits ?? 1)) * Math.max(1, Math.floor(input.submissions ?? 1));
  const clamp = (us: number) => Math.min(Math.max(us, 0), VLQ_BILLING.maxCircuitUs);
  const lowUs = clamp(input.circuitUs ?? 0);
  const highUs = clamp(input.circuitUs ?? VLQ_BILLING.maxCircuitUs);
  return {
    low: vlqJobs * perJobSeconds(shots, lowUs),
    high: vlqJobs * perJobSeconds(shots, highUs),
    vlqJobs,
    shots,
    minimumApplies: shots * (VLQ_BILLING.postprocessingUs + highUs) * 1e-6 < VLQ_BILLING.minPerJobSeconds,
  };
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
