import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCalibrationResult,
  CALIBRATION_RESULT_SCHEMA,
  entryStatus,
  migrateEntry,
  operatorStatus,
  operatorTemplate,
  type PulseInfo,
  parseOperator,
  parseOperatorDirectives,
  rangeOf,
  seedEntry,
  setEntryStatus,
  setLocusValues,
  upsertEntry,
} from "../../core/operators";

const info: PulseInfo = {
  backend: "VLQ",
  calibrationSetId: "new",
  nativeImplementation: "drag_crf",
  qubits: ["QB1", "QB2"],
  loci: { QB1: { duration: 4e-8, amplitude_i: 0.4 }, QB2: { duration: 4e-8, amplitude_i: 0.5 } },
  sampleRate: 2e9,
  granularity: 8,
  minSamples: 8,
  fetchedAt: "2026-11-11T00:00:00Z",
};

const file = `# my operator
schema: qaas-operator/v1
name: hann
gate: prx
waveform:
  i: { type: expression, expression: "cos(pi*t)**2" }  # keep me
  q: { type: derivative }
calibrations:
  - calibrationSetId: old
    status: calibrated
    reference: { implementation: drag_crf, loci: { QB1: { amplitude_i: 0.2 } } }
    loci:
      QB1: { duration: 4.0e-8, amplitude_i: 0.3, amplitude_q: 0.03 }
      QB2: { duration: 4.0e-8, amplitude_i: 0.35 }
`;

test("templates parse without problems", () => {
  for (const template of ["drag_gaussian", "cosine_rise_fall", "hann_drag", "expression", "samples"] as const) {
    const p = parseOperator(operatorTemplate({ name: "op", template }));
    assert.deepEqual(p.problems, [], template);
    assert.equal(p.spec?.name, "op");
  }
});

test("parser reports problems with document positions", () => {
  const p = parseOperator(file.replace("name: hann", "name: Bad-Name").replace("amplitude_i: 0.35", "amplitude_q: 1"));
  const messages = p.problems.map((x) => x.message);
  assert.ok(messages.some((m) => m.startsWith("name:")));
  assert.ok(messages.some((m) => m.includes("QB2: amplitude_i is required")));
  const [start] = rangeOf(p.doc, p.problems[0].path);
  assert.equal(file.replace("name: hann", "name: Bad-Name").slice(start, start + 8), "Bad-Name");
  assert.equal(parseOperator("a: [").syntaxErrors.length > 0, true);
});

test("status relative to the current calibration set", () => {
  const spec = parseOperator(file).spec!;
  assert.equal(operatorStatus(spec, "old"), "ready");
  assert.equal(operatorStatus(spec, "new"), "stale");
  assert.equal(operatorStatus(spec), "unknown");
  assert.equal(entryStatus(spec.calibrations![0], "new"), "stale");
});

test("migration rescales amplitudes by the native amplitude change", () => {
  const from = parseOperator(file).spec!.calibrations![0];
  const m = migrateEntry(from, info, true, new Date("2026-11-11T00:00:00Z"));
  assert.equal(m.entry.calibrationSetId, "new");
  assert.equal(m.entry.status, "draft");
  assert.equal(m.entry.migratedFrom, "old");
  assert.equal(m.factors.QB1, 2);
  assert.equal(m.entry.loci.QB1.amplitude_i, 0.6);
  assert.equal(m.entry.loci.QB1.amplitude_q, 0.06);
  assert.deepEqual(m.unscaled, ["QB2"]); // no native reference for QB2
  assert.equal(m.entry.loci.QB2.amplitude_i, 0.35);
  assert.equal(m.entry.reference?.loci?.QB1.amplitude_i, 0.4);
  const copied = migrateEntry(from, info, false);
  assert.equal(copied.entry.loci.QB1.amplitude_i, 0.3);
});

test("upserting entries keeps comments and other entries", () => {
  const seeded = seedEntry(info, ["QB1"]);
  const text = upsertEntry(file, seeded);
  assert.ok(text.includes("# keep me"));
  const spec = parseOperator(text).spec!;
  assert.equal(spec.calibrations?.length, 2);
  assert.equal(operatorStatus(spec, "new"), "draft");
  const replaced = upsertEntry(text, { ...seeded, note: "x" });
  assert.equal(parseOperator(replaced).spec?.calibrations?.length, 2);
});

test("editing a locus and marking calibrated", () => {
  let text = setLocusValues(file, "old", "QB3", { duration: 5e-8, amplitude_i: 0.1 });
  assert.equal(parseOperator(text).spec?.calibrations?.[0].loci.QB3.amplitude_i, 0.1);
  text = setEntryStatus(upsertEntry(text, seedEntry(info, ["QB1", "QB2"])), "new", "calibrated");
  const entry = parseOperator(text).spec!.calibrations![1];
  assert.equal(entry.status, "calibrated");
  assert.deepEqual(entry.verifiedLoci, ["QB1", "QB2"]);
});

test("calibration results verify loci one by one", () => {
  const draft = upsertEntry(file, seedEntry(info, ["QB1", "QB2"]));
  const result = {
    schema: CALIBRATION_RESULT_SCHEMA,
    operator: "hann",
    calibrationSetId: "new",
    locus: "QB1",
    values: { duration: 4e-8, amplitude_i: 0.61, amplitude_q: 0 },
    native: { implementation: "drag_crf", amplitude_i: 0.4 },
  };
  const once = parseOperator(applyCalibrationResult(draft, result)).spec!.calibrations![1];
  assert.equal(once.status, "draft");
  assert.equal(once.loci.QB1.amplitude_i, 0.61);
  const twice = parseOperator(
    applyCalibrationResult(applyCalibrationResult(draft, result), { ...result, locus: "QB2" }),
  ).spec!.calibrations![1];
  assert.equal(twice.status, "calibrated");
  const fresh = parseOperator(applyCalibrationResult(file, { ...result, calibrationSetId: "other" })).spec!;
  assert.equal(fresh.calibrations?.find((c) => c.calibrationSetId === "other")?.status, "calibrated");
});

test("OpenQASM operator directives", () => {
  const d = parseOperatorDirectives(
    "OPENQASM 3.0;\n// @qaas operator prx=hann_drag\nqubit q;\n//@qaas operator   prx = other\n",
  );
  assert.deepEqual(d.use, { prx: "other" });
  assert.equal(d.lines.prx, 3);
  assert.deepEqual(parseOperatorDirectives("// qaas operator prx=x").use, {});
});

import { unverifyLocus } from "../../core/operators";

test("manual edits turn a calibrated entry into a draft", () => {
  const calibrated = setEntryStatus(file, "old", "calibrated");
  const edited = parseOperator(unverifyLocus(calibrated, "old", "QB1")).spec!.calibrations![0];
  assert.equal(edited.status, "draft");
  assert.deepEqual(edited.verifiedLoci, ["QB2"]);
});
