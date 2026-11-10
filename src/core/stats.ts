/**
 * Statistics of measurement counts. Bitstrings use Qiskit order: the rightmost character
 * is classical bit 0. Spaces between registers are removed.
 */

export type Counts = Record<string, number>;

export function normalizeCounts(c: Counts): Counts {
  const out: Counts = {};
  for (const [k, v] of Object.entries(c)) {
    const key = k.replace(/\s+/g, "");
    out[key] = (out[key] ?? 0) + v;
  }
  return out;
}

function total(c: Counts): number {
  return Object.values(c).reduce((a, b) => a + b, 0);
}

export function toProbabilities(c: Counts): Counts {
  const t = total(c) || 1;
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v / t]));
}

/** Value (0/1) of classical bit i in a bitstring. */
export function bit(bits: string, i: number): number {
  return bits.charCodeAt(bits.length - 1 - i) === 49 ? 1 : 0;
}

export interface Marginal {
  clbit: number;
  p1: number;
  /** ⟨Z⟩ = P(0) − P(1) */
  z: number;
}

export interface Correlation {
  i: number;
  j: number;
  zz: number;
  /** ⟨ZiZj⟩ − ⟨Zi⟩⟨Zj⟩; 0 for independent bits. */
  connected: number;
}

export interface CountStats {
  shots: number;
  outcomes: number;
  numBits: number;
  /** Shannon entropy of the outcome distribution, in bits. */
  entropy: number;
  /** Probability of the most frequent outcome. */
  topProbability: number;
  topOutcome: string;
  /** ⟨Z⊗…⊗Z⟩ over all bits: P(even parity) − P(odd parity). */
  parity: number;
  marginals: Marginal[];
  /** Pairwise correlations; empty above maxCorrelationBits. */
  correlations: Correlation[];
}

export function countStats(raw: Counts, maxCorrelationBits = 16): CountStats {
  const c = normalizeCounts(raw);
  const shots = total(c);
  const entries = Object.entries(c).filter(([, v]) => v > 0);
  const numBits = Math.max(0, ...entries.map(([k]) => k.length));
  const p = entries.map(([k, v]) => [k.padStart(numBits, "0"), shots ? v / shots : 0] as const);

  let entropy = 0;
  let parity = 0;
  let top: readonly [string, number] = ["", 0];
  const p1 = new Array<number>(numBits).fill(0);
  for (const [k, pk] of p) {
    entropy -= pk > 0 ? pk * Math.log2(pk) : 0;
    let ones = 0;
    for (let i = 0; i < numBits; i++) {
      const b = bit(k, i);
      ones += b;
      p1[i] += b * pk;
    }
    parity += ones % 2 === 0 ? pk : -pk;
    if (pk > top[1]) {
      top = [k, pk];
    }
  }
  const marginals = p1.map((x, i) => ({ clbit: i, p1: x, z: 1 - 2 * x }));

  const correlations: Correlation[] = [];
  if (numBits <= maxCorrelationBits) {
    for (let i = 0; i < numBits; i++) {
      for (let j = i + 1; j < numBits; j++) {
        let zz = 0;
        for (const [k, pk] of p) {
          zz += bit(k, i) === bit(k, j) ? pk : -pk;
        }
        correlations.push({ i, j, zz, connected: zz - marginals[i].z * marginals[j].z });
      }
    }
  }
  return {
    shots,
    outcomes: entries.length,
    numBits,
    entropy: Math.abs(entropy),
    topProbability: top[1],
    topOutcome: top[0],
    parity,
    marginals,
    correlations,
  };
}

/** Hellinger fidelity, as qiskit.quantum_info.hellinger_fidelity: (Σ √(p·q))². */
export function hellingerFidelity(a: Counts, b: Counts): number {
  const p = toProbabilities(normalizeCounts(a));
  const q = toProbabilities(normalizeCounts(b));
  let bc = 0;
  for (const k of Object.keys(p)) {
    bc += Math.sqrt(p[k] * (q[k] ?? 0));
  }
  return bc * bc;
}

/** Total variation distance ½ Σ |p − q|. */
export function totalVariationDistance(a: Counts, b: Counts): number {
  const p = toProbabilities(normalizeCounts(a));
  const q = toProbabilities(normalizeCounts(b));
  let d = 0;
  for (const k of new Set([...Object.keys(p), ...Object.keys(q)])) {
    d += Math.abs((p[k] ?? 0) - (q[k] ?? 0));
  }
  return d / 2;
}

/** Tidy CSV: one row per (circuit, outcome) with one 0/1 column per classical bit. */
export function countsToCsv(jobId: string, counts: Counts[]): string {
  const norm = counts.map(normalizeCounts);
  const numBits = Math.max(0, ...norm.flatMap((c) => Object.keys(c).map((k) => k.length)));
  const bitCols = Array.from({ length: numBits }, (_, i) => `c${i}`);
  const rows = [["job", "circuit", "outcome", "outcome_int", "count", "probability", ...bitCols].join(",")];
  norm.forEach((c, circuit) => {
    const t = total(c) || 1;
    for (const [k, v] of Object.entries(c).sort((x, y) => x[0].localeCompare(y[0]))) {
      const bits = k.padStart(numBits, "0");
      const asInt = bits ? Number.parseInt(bits, 2) : 0;
      // Ket form keeps leading zeros when tools infer column types.
      rows.push(
        [jobId, circuit, `|${bits}⟩`, asInt, v, (v / t).toPrecision(6), ...bitCols.map((_, i) => bit(bits, i))].join(
          ",",
        ),
      );
    }
  });
  return `${rows.join("\n")}\n`;
}
