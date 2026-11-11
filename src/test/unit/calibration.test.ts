import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTable,
  type CalibrationMetrics,
  calibrationCsv,
  columnStats,
  formatValue,
  goodness,
  improvement,
  metricInfo,
} from "../../core/calibration";

const obs = (metric: string, locus: string[], value: number, unit = "") => ({
  metric,
  locus,
  value,
  uncertainty: null,
  unit,
});

const SET: CalibrationMetrics = {
  calibrationSetId: "set-1",
  observations: [
    obs("characterization.model.t1_time", ["QB10"], 40e-6, "s"),
    obs("characterization.model.t1_time", ["QB2"], 20e-6, "s"),
    obs("characterization.model.t1_time", ["COMPR1"], 30e-6, "s"),
    obs("metrics.ssro.measure.constant.error_0_to_1", ["QB2"], 0.01),
    obs("metrics.ssro.measure.constant.error_0_to_1", ["QB10"], 0.05),
    obs("metrics.irb.cz.crf_crf.fidelity", ["QB2", "COMPR1"], 0.99),
    obs("metrics.ghz_state.population", ["QB2", "QB10"], 0.7),
    obs("metrics.something.new.QBX_metric", ["QB2"], 3),
  ],
};

test("buildTable sorts qubits naturally and separates resonators and multi-qubit metrics", () => {
  const t = buildTable(SET);
  assert.deepEqual(t.qubits, ["QB2", "QB10"]);
  assert.deepEqual(t.others, ["COMPR1"]);
  assert.equal(t.otherRows.length, 1);
  assert.equal(t.otherRows[0].locus[0], "COMPR1");
  assert.equal(t.multi.length, 1);
  assert.equal(t.multi[0].metric, "metrics.ghz_state.population");
  const ids = t.columns.map((c) => c.id);
  assert.equal(ids[0], "characterization.model.t1_time", "known metrics first, in display order");
  const cz = t.columns.find((c) => c.partner === "COMPR1");
  assert.ok(cz);
  assert.equal(cz.id, "metrics.irb.cz.crf_crf.fidelity@COMPR1");
  assert.match(cz.info.label, /with COMPR1/);
  assert.deepEqual(Object.keys(cz.values), ["QB2"]);
});

test("stats rank qubits from worst to best by the metric's direction", () => {
  const t = buildTable(SET);
  const t1 = t.columns.find((c) => c.metric === "characterization.model.t1_time");
  const err = t.columns.find((c) => c.metric.endsWith("error_0_to_1"));
  assert.ok(t1 && err);
  assert.deepEqual(columnStats(t1)?.ranking, ["QB2", "QB10"], "shorter T1 is worse");
  assert.deepEqual(columnStats(err)?.ranking, ["QB10", "QB2"], "higher readout error is worse");
  assert.equal(goodness(err.info, 0.01, 0.01, 0.05), 1);
  assert.equal(goodness(t1.info, 20e-6, 20e-6, 40e-6), 0);
});

test("display units and improvements", () => {
  const t1 = metricInfo("characterization.model.t1_time", "s");
  assert.equal(formatValue(t1, 36.04e-6), "36.0");
  assert.equal(t1.unit, "µs");
  const err = metricInfo("metrics.ssro.measure.constant.error_0_to_1");
  assert.equal(formatValue(err, 0.0123), "1.23");
  assert.ok(improvement(err, 0.02, 0.01) > 0, "a lower error is an improvement");
  assert.ok(improvement(t1, 30e-6, 20e-6) < 0, "a shorter T1 is a regression");
  const unknown = metricInfo("metrics.foo.leakage_rate");
  assert.equal(unknown.better, "lower");
});

test("calibration CSV has one row per observation with raw and display values", () => {
  const csv = calibrationCsv(SET).trim().split("\n");
  assert.equal(csv.length, SET.observations.length + 1);
  assert.equal(csv[0], "calibration_set_id,component,metric,label,value,unit,uncertainty,display_value,display_unit");
  assert.ok(csv.some((l) => l.startsWith("set-1,QB2__COMPR1,metrics.irb.cz.crf_crf.fidelity,")));
});
