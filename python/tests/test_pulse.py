"""Tests for qaas_pulse. Run: python -m unittest discover -s python/tests (needs qaas[iqm_qiskit])."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import qaas_pulse as qp

HANN = {
    "schema": "qaas-operator/v1",
    "name": "hann_drag",
    "gate": "prx",
    "parameters": {"beta": {"default": 1.0}},
    "waveform": {
        "i": {"type": "expression", "expression": "beta * cos(pi * t) ** 2"},
        "q": {"type": "derivative"},
    },
}
GAUSS = {
    "name": "gauss_drag",
    "parameters": {"sigma": {"default": 8e-9, "unit": "s"}},
    "waveform": {
        "i": {"type": "builtin", "name": "Gaussian"},
        "q": {"type": "builtin", "name": "GaussianDerivative"},
    },
}


class ExpressionTests(unittest.TestCase):
    def test_translates_to_numpy(self):
        self.assertEqual(qp.compile_expression("cos(pi*t)**2", set()), "np.cos(np.pi * t) ** 2")
        self.assertEqual(qp.compile_expression("a*exp(-t)", {"a"}), "self.a * np.exp(-t)")

    def test_rejects_code(self):
        for bad in [
            "__import__('os').system('x')",
            "t.__class__",
            "open('f')",
            "(lambda: 1)()",
            "[t for t in t]",
            "np.cos(t)",
            "'x'",
            "unknown * t",
        ]:
            with self.subTest(bad=bad), self.assertRaises(qp.OperatorError):
                qp.compile_expression(bad, set())


class SpecTests(unittest.TestCase):
    def test_builtin_fields_become_parameters(self):
        s = qp.normalize_spec(GAUSS)
        self.assertEqual(s["params"]["sigma"]["unit"], "s")
        self.assertIn("center_offset", s["params"])

    def test_missing_builtin_parameter(self):
        spec = {**GAUSS, "parameters": {}}
        with self.assertRaisesRegex(qp.OperatorError, "sigma"):
            qp.normalize_spec(spec)

    def test_rejects_bad_names_and_gates(self):
        for spec in [
            {**HANN, "name": "Bad-Name"},
            {**HANN, "gate": "cz"},
            {**HANN, "parameters": {"duration": 1}},
        ]:
            with self.subTest(spec=spec), self.assertRaises(qp.OperatorError):
                qp.normalize_spec(spec)


class SamplingTests(unittest.TestCase):
    def test_expression_and_derivative(self):
        r = qp.sample(HANN, {"duration": 40e-9, "amplitude_i": 0.5, "amplitude_q": 0.1}, 2e9)
        self.assertEqual(r["nSamples"], 80)
        self.assertAlmostEqual(max(r["shapeI"]), 1.0, places=2)
        self.assertAlmostEqual(r["shapePeakQ"], 1.0, places=6)  # derivative normalized
        self.assertAlmostEqual(max(r["i"]), 0.5, places=2)

    def test_builtin_matches_iqm_waveform(self):
        import iqm.models.playlist.waveforms as w

        r = qp.sample(GAUSS, {"duration": 40e-9, "amplitude_i": 1.0, "amplitude_q": 0.0}, 2e9)
        expected = w.Gaussian(n_samples=80, sigma=8e-9 / 40e-9).sample()
        np.testing.assert_allclose(r["shapeI"], expected, atol=1e-6)

    def test_samples_are_interpolated(self):
        spec = {"name": "tri", "waveform": {"i": {"type": "samples", "samples": [0, 1, 0]}}}
        r = qp.sample(spec, {"duration": 10e-9, "amplitude_i": 1.0}, 1e9)
        self.assertEqual(r["nSamples"], 10)
        self.assertAlmostEqual(max(r["shapeI"]), 0.9, places=6)
        self.assertEqual(r["shapePeakQ"], 0.0)


class GateClassTests(unittest.TestCase):
    def test_gate_class_parameters(self):
        classes = qp.build_classes([HANN, GAUSS])
        params = classes["hann_drag"]["gate"].parameters
        for key in ("duration", "amplitude_i", "amplitude_q", "beta"):
            self.assertIn(key, params)
        self.assertIn("sigma", classes["gauss_drag"]["gate"].parameters)

    def test_generated_code_is_self_contained(self):
        code = qp.generate_code([HANN])
        ns: dict = {}
        exec(compile(code, "snippet", "exec"), ns)
        self.assertIn("HannDragPRX", ns)

    def test_iqm_calibration_conversion_and_pulse(self):
        """Runs IQM's own calibration-data conversion and pulse construction on generated classes."""
        from iqm.pulse.playlist.channel import ChannelProperties

        props = ChannelProperties(
            sample_rate=2e9,
            instruction_duration_granularity=8,
            instruction_duration_min=8,
            is_iq=True,
        )
        for spec, extra in ((HANN, {"beta": 0.5}), (GAUSS, {"sigma": 6e-9, "center_offset": 0.0})):
            with self.subTest(op=spec["name"]):
                gate = qp.build_classes([spec])[spec["name"]]["gate"]
                data = {
                    "duration": 40e-9,
                    "amplitude_i": 0.4,
                    "amplitude_q": 0.05,
                    "modulation_frequency": 0.0,
                    **extra,
                }
                converted = gate.convert_calibration_data(data, gate.parameters, props)
                self.assertEqual(converted["n_samples"], 80)
                self.assertNotIn("duration", converted)
                pulse = gate._get_pulse(**converted)
                self.assertEqual(pulse.duration, 80)
                self.assertAlmostEqual(pulse.scale_i, 0.4)
                self.assertAlmostEqual(pulse.scale_q, 0.05)
                if spec is GAUSS:  # time-like parameter converted to pulse durations
                    self.assertAlmostEqual(pulse.wave_i.sigma, 6e-9 / 40e-9)


if __name__ == "__main__":
    unittest.main()
