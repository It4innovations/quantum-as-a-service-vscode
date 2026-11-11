# Changelog

## Unreleased

- Long-running Python bridge: one LEXIS login per session.
- Job manager: jobs view, persistence across restarts, background refresh, import from HEAppE, cancel, notifications.
- Result downloads to a configurable path or a chosen folder.
- Results view with statistics: entropy, parity, per-bit P(1) and ⟨Z⟩, pairwise correlations heatmap.
- Comparison with the exact ideal simulation or another job: Hellinger fidelity, total variation distance, overlaid histogram.
- Tidy `counts.csv` / `shots.csv` exports, Open in Data Wrangler, and a generated `analysis.ipynb` notebook.
- OpenQASM 3: language support, error checking, transpile diff, run on VLQ (single file or batch).
- VLQ billed-time estimates above `backend.run(...)` in Python files and notebooks, in the submit confirmation, and in a sidebar estimator.
- Python environments: discovery of venv, conda and pyenv interpreters; create a 3.12 venv or conda env; install qaas as a VS Code task.
- Pulse-level operator catalog: `.qaas/operators/*.yaml` with JSON schema, Pulse Operators view, waveform editor with live preview and hardware checks, calibration entries per calibration set, migration (native-amplitude rescaling), pulse-level OpenQASM runs (`// @qaas operator prx=<name>`), pulse jobs in the Jobs view, Python code insertion, and a Rabi calibration notebook whose result is written back.
- Tooling: Biome (TypeScript/JSON) and Ruff (Python) replace ESLint.

## 0.0.1

- Initial scaffold: environment check, qaas install, LEXIS token storage, backend listing, VLQ circuit template, run current file.
- Install qaas 1.0.0+ from PyPI; warn when the installed qaas is older than 1.0.0.
