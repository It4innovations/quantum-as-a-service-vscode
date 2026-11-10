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
