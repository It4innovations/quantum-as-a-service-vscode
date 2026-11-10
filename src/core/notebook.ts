/** Builds the analysis notebook written next to downloaded results. */

export interface NotebookInput {
  directory: string;
  jobId: string;
  jobName: string;
  backend: string;
  project: string;
  hasShots: boolean;
  hasCircuits: boolean;
}

type Cell = { cell_type: "markdown" | "code"; source: string };

function cell(cell_type: Cell["cell_type"], source: string): Cell {
  return { cell_type, source: source.trim() };
}

/** Python string literal for a path (JSON escaping is valid Python). */
const pyStr = (s: string) => JSON.stringify(s);

export function buildAnalysisNotebook(i: NotebookInput): string {
  const cells: Cell[] = [
    cell(
      "markdown",
      `# Job #${i.jobId}: ${i.jobName}

Backend **${i.backend}**, project **${i.project}**. Results are in \`${i.directory}\`.

Bit order follows Qiskit: in \`outcome\` the rightmost bit is classical bit \`c0\`. Columns \`c0\`, \`c1\`, … hold each bit as 0/1.
Needs \`pandas\` and \`matplotlib\` in the kernel (\`%pip install pandas matplotlib\`).`,
    ),
    cell(
      "code",
      `import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

RESULTS = Path(${pyStr(i.directory)})
job = json.loads((RESULTS / "job.json").read_text())
counts = pd.read_csv(RESULTS / "counts.csv")
counts["bitstring"] = counts["outcome"].str.strip("|⟩")
bit_cols = [c for c in counts.columns if c.startswith("c") and c[1:].isdigit()]
counts.head()`,
    ),
    cell("markdown", "## Summary per circuit\nEntropy in bits; parity is ⟨Z⊗…⊗Z⟩ = P(even) − P(odd)."),
    cell(
      "code",
      `def summary(df: pd.DataFrame) -> pd.Series:
    p = df["probability"].to_numpy()
    z = 1 - 2 * df[bit_cols].to_numpy()
    nz = p[p > 0]
    return pd.Series(
        {
            "shots": int(df["count"].sum()),
            "outcomes": len(df),
            "entropy_bits": float(-(nz * np.log2(nz)).sum()),
            "parity_Z": float((z.prod(axis=1) * p).sum()),
            "top_outcome": df.loc[df["probability"].idxmax(), "outcome"],
        }
    )


pd.DataFrame({c: summary(df) for c, df in counts.groupby("circuit")}).T`,
    ),
    cell(
      "markdown",
      "## Per-bit statistics and correlations\nConnected correlation ⟨ZᵢZⱼ⟩ − ⟨Zᵢ⟩⟨Zⱼ⟩ is 0 for independent bits.",
    ),
    cell(
      "code",
      `def per_bit(df: pd.DataFrame) -> pd.DataFrame:
    p = df["probability"].to_numpy()
    p1 = df[bit_cols].to_numpy().T @ p
    return pd.DataFrame({"P(1)": p1, "<Z>": 1 - 2 * p1}, index=bit_cols)


def connected_correlations(df: pd.DataFrame) -> pd.DataFrame:
    p = df["probability"].to_numpy()
    z = 1 - 2 * df[bit_cols].to_numpy()
    mean = z.T @ p
    zz = (z * p[:, None]).T @ z
    corr = zz - np.outer(mean, mean)
    np.fill_diagonal(corr, np.nan)  # diagonal is the variance, not a correlation
    return pd.DataFrame(corr, index=bit_cols, columns=bit_cols)


for circuit, df in counts.groupby("circuit"):
    print(f"Circuit {circuit}")
    display(per_bit(df).round(4))
    display(connected_correlations(df).round(3))`,
    ),
    cell("markdown", "## Histogram"),
    cell(
      "code",
      `for circuit, df in counts.groupby("circuit"):
    top = df.nlargest(32, "probability").sort_values("bitstring")
    ax = top.plot.bar(x="bitstring", y="probability", legend=False, figsize=(10, 3), title=f"Circuit {circuit}")
    ax.set_xlabel("outcome (c0 rightmost)")
    plt.show()`,
    ),
  ];
  if (i.hasShots) {
    cells.push(
      cell("markdown", "## Per-shot data\nThe mean of each bit column is P(1) for that bit."),
      cell(
        "code",
        `shots = pd.read_csv(RESULTS / "shots.csv")
shot_bits = [c for c in shots.columns if c.startswith("c") and c[1:].isdigit()]
display(shots.groupby("circuit")[shot_bits].mean().round(4))
shots[shot_bits].corr().round(3)`,
      ),
    );
  }
  if (i.hasCircuits) {
    cells.push(
      cell("markdown", "## Comparison with ideal simulation"),
      cell(
        "code",
        `from qiskit import qasm3
from qiskit.primitives import StatevectorSampler
from qiskit.quantum_info import hellinger_fidelity

for circuit, df in counts.groupby("circuit"):
    qc = qasm3.loads((RESULTS / "circuits" / f"circuit_{circuit}.qasm").read_text())
    ideal = StatevectorSampler().run([qc], shots=100_000).result()[0].join_data().get_counts()
    measured = dict(zip(df["bitstring"], df["count"]))
    print(f"Circuit {circuit}: Hellinger fidelity vs ideal = {hellinger_fidelity(measured, ideal):.4f}")`,
      ),
    );
  }
  const nb = {
    cells: cells.map((c) =>
      c.cell_type === "code"
        ? { cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: c.source }
        : { cell_type: "markdown", metadata: {}, source: c.source },
    ),
    metadata: {
      kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
      language_info: { name: "python" },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return `${JSON.stringify(nb, null, 1)}\n`;
}
