import * as assert from "node:assert/strict";
import { test } from "node:test";
import { estimate, formatRange } from "../../core/estimate";
import { scanRunCalls } from "../../core/runScanner";

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("estimate matches the examples in the VLQ consumption guide", () => {
  close(estimate({ shots: 1000, circuits: 4, circuitUs: 50 }).high, 3.6);
  close(estimate({ shots: 10000, submissions: 3, circuitUs: 50 }).high, 12.0);
  close(estimate({ shots: 10000, circuitUs: 20 }).high, 3.7);
});

test("estimate gives a 0-50 us range and the 0.9 s minimum", () => {
  const e = estimate({ shots: 10000 });
  close(e.low, 3.5);
  close(e.high, 4.0);
  const small = estimate({ shots: 100 });
  close(small.high, 0.9);
  assert.equal(small.minimumApplies, true);
  assert.equal(formatRange(small), "0.90 s");
  assert.equal(formatRange(e), "3.50–4.00 s");
});

const script = `
from qheappe_client.qprovider import QProvider
SHOTS = 2_000
backend = provider.get_backend(lexis_resource=r, backend_name="VLQ")
qc = QuantumCircuit(2)
job = backend.run(backend.transpile(qc), shots=SHOTS, job_name="x")
batch = [qc1, qc2, qc3]
job2 = backend.run(batch, 500)
result = subprocess.run(["ls"])
# backend.run(qc, shots=1)
other.run(qc)
many = make_circuits()
job3 = backend.run(many, shots=SHOTS)
`;

test("scanner finds backend.run calls with shots and circuit counts", () => {
  const calls = scanRunCalls(script);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].circuits, undefined);
  assert.deepEqual(calls[0], { line: 5, kind: "run", shots: 2000, shotsKnown: true, circuits: 1 });
  assert.deepEqual(calls[1], { line: 7, kind: "run", shots: 500, shotsKnown: true, circuits: 3 });
});

test("scanner resolves names from a notebook prelude", () => {
  const prelude = "n = 4096\nbackend = provider.get_backend()\n";
  const calls = scanRunCalls("job = backend.run(\n    qc,\n    shots=n,\n)", prelude);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].line, 0);
  assert.equal(calls[0].shots, 4096);
});

test("scanner falls back to default shots and reads pulla playlists", () => {
  const calls = scanRunCalls(
    "settings.set_shots(1000)\njob = pulla.submit_playlist(run_definition, context=ctx)\nb.run(qc)",
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, "playlist");
  assert.equal(calls[0].shots, 1000);
  assert.equal(calls[1].shots, 1024);
  assert.equal(calls[1].shotsKnown, false);
});

import { countStats, countsToCsv, hellingerFidelity, totalVariationDistance } from "../../core/stats";

test("count statistics of a Bell state", () => {
  const s = countStats({ "00": 500, "11": 500 });
  assert.equal(s.shots, 1000);
  assert.equal(s.numBits, 2);
  close(s.entropy, 1);
  close(s.parity, 1);
  close(s.marginals[0].p1, 0.5);
  close(s.marginals[1].z, 0);
  close(s.correlations[0].zz, 1);
  close(s.correlations[0].connected, 1);
});

test("marginals follow Qiskit bit order and correlations vanish for product states", () => {
  // c0 always 1, c1 uniform
  const s = countStats({ "01": 250, "11": 250 });
  close(s.marginals[0].p1, 1);
  close(s.marginals[1].p1, 0.5);
  close(s.correlations[0].connected, 0);
  close(s.parity, 0);
});

test("Hellinger fidelity and TVD match their definitions", () => {
  close(hellingerFidelity({ "00": 500, "11": 500 }, { "00": 0.5, "11": 0.5 }), 1);
  close(hellingerFidelity({ "0": 1 }, { "1": 1 }), 0);
  close(hellingerFidelity({ "0": 1 }, { "0": 1, "1": 1 }), 0.5);
  close(totalVariationDistance({ "0": 1 }, { "0": 1, "1": 1 }), 0.5);
  close(totalVariationDistance({ "0 1": 2 }, { "01": 5 }), 0);
});

test("CSV keeps leading zeros and has per-bit columns", () => {
  const csv = countsToCsv("42", [{ "01": 3, "10": 1 }])
    .trim()
    .split("\n");
  assert.equal(csv[0], "job,circuit,outcome,outcome_int,count,probability,c0,c1");
  assert.equal(csv[1], "42,0,|01⟩,1,3,0.750000,1,0");
  assert.equal(csv[2], "42,0,|10⟩,2,1,0.250000,0,1");
});

import { buildAnalysisNotebook } from "../../core/notebook";

test("analysis notebook is valid nbformat and includes optional sections on demand", () => {
  const base = {
    directory: 'C:\\results\\42 "x"',
    jobId: "42",
    jobName: "bell",
    backend: "VLQ",
    project: "p",
    hasShots: false,
    hasCircuits: false,
  };
  const nb = JSON.parse(buildAnalysisNotebook(base));
  assert.equal(nb.nbformat, 4);
  const code = nb.cells
    .filter((c: { cell_type: string }) => c.cell_type === "code")
    .map((c: { source: string }) => c.source);
  assert.ok(code[0].includes('RESULTS = Path("C:\\\\results\\\\42 \\"x\\"")'), code[0]);
  assert.ok(!code.join().includes("shots.csv"));
  const full = JSON.parse(buildAnalysisNotebook({ ...base, hasShots: true, hasCircuits: true }));
  const all = full.cells.map((c: { source: string }) => c.source).join("\n");
  assert.ok(all.includes("shots.csv") && all.includes("hellinger_fidelity"));
});
