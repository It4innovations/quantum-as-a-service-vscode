# Quantum-as-a-Service for VS Code

Run OpenQASM 3 and Qiskit circuits on the **VLQ** quantum computer from VS Code, through
[LEXIS](https://docs.lexis.tech/) and [HEAppE](https://heappe.eu/), using the
[`qaas`](https://pypi.org/project/qaas/) Python package (QHEAppE client).

## Features and roadmap

Status: ✅ available and tested · 🔶 available, not yet verified against live VLQ · 🗓️ planned

### Python environment

| Feature | Status | Notes |
| --- | --- | --- |
| Find interpreters: workspace venvs, conda / miniconda / miniforge envs, pyenv versions, Python extension environments, system Python | ✅ | `QaaS: Select Python Interpreter` shows each one's Python version and installed qaas |
| Create a Python 3.12 venv (from any 3.12 interpreter, e.g. pyenv) or a conda env, then install qaas | ✅ | `QaaS: Create Python Environment for qaas` |
| Install / upgrade `qaas[<extra>]>=1.0.0,<2` from PyPI | ✅ | Runs `python -m pip` as a VS Code task. Checks for Python 3.12 and warns outside a venv/conda env |
| Environment check (qaas, qiskit, iqm-client, iqm-pulla, py4lexis versions) | ✅ | Flags qaas older than 1.0.0 |

### Login and backends

| Feature | Status | Notes |
| --- | --- | --- |
| LEXIS browser login, kept for the whole VS Code session | 🔶 | The login URL is also offered as a notification (works on remote hosts) |
| LEXIS token in VS Code secret storage | 🔶 | `QaaS: Set LEXIS Token` / `Clear LEXIS Token and Log Out` |
| List backends and choose the default | 🔶 | Status bar shows the current backend |
| Topology view: qubit connectivity, calibration fidelities, chosen layout | 🗓️ | |
| Remaining allocation in the status bar | 🗓️ | |

### OpenQASM 3

| Feature | Status | Notes |
| --- | --- | --- |
| `.qasm` language: syntax highlighting, comments, brackets | ✅ | |
| Errors shown in the editor (Qiskit OpenQASM 3 importer, on open and save) | ✅ | No login needed |
| Transpile for VLQ: diff of original vs. transpiled QASM, depth / 2-qubit gates / layout | 🔶 | `Transpile` above the file or in the editor title |
| Run on VLQ, with shots prompt and billed-time estimate before submitting | 🔶 | Several `.qasm` files selected in the explorer are sent as one job |
| `input` parameters with value prompts and sweeps | 🗓️ | |

### Python scripts and notebooks

| Feature | Status | Notes |
| --- | --- | --- |
| Billed-time estimate above every `backend.run(...)` and `pulla.submit_playlist(...)` | ✅ | In `.py` files and `.ipynb` cells. Reads shots and circuit counts from literals and simple assignments, including earlier notebook cells |
| Run Python file on VLQ, with LEXIS settings passed as environment variables | 🔶 | Asks for confirmation with the total estimate |
| Track jobs submitted from scripts automatically | 🗓️ | For now: `Import Jobs from HEAppE` |
| Results renderer for notebook outputs | 🗓️ | |

### Job manager

| Feature | Status | Notes |
| --- | --- | --- |
| Jobs view with state, shots, estimate, calibration set and source file | ✅ | |
| Jobs survive restarts; active jobs are refreshed in the background | 🔶 | Background refresh starts only when no login prompt can appear |
| Import past jobs from HEAppE (`ListJobsForCurrentUser`) | 🔶 | |
| Cancel, copy ID, remove from list | 🔶 | |
| Notification when a job finishes; optional automatic download | 🔶 | |

### Results and analysis

| Feature | Status | Notes |
| --- | --- | --- |
| Download results to a configurable path (`qaas.resultsDirectory`) or a folder you pick | 🔶 | Writes `counts.json`, `counts.csv`, `raw_artifacts.json`, `job.json`; `shots.csv` with per-shot measurements (`qaas.downloadMeasurements`) |
| Download several selected jobs at once | 🔶 | |
| Results view: histogram, shots, distinct outcomes, entropy, most frequent outcome, parity ⟨Z…Z⟩ | ✅ | One section per circuit |
| Per-bit P(1) and ⟨Z⟩ | ✅ | |
| Pairwise correlations (connected ⟨ZᵢZⱼ⟩ − ⟨Zᵢ⟩⟨Zⱼ⟩) as a heatmap | ✅ | Up to 16 bits; larger registers in Data Wrangler or the notebook |
| Compare with the ideal simulation: Hellinger fidelity, total variation distance, overlaid histogram | ✅ | Exact statevector probabilities of the submitted OpenQASM 3 circuits (up to 24 qubits, final measurements only) |
| Compare with another downloaded job | ✅ | E.g. the same circuit on another calibration set |
| Tidy CSV export for other tools | ✅ | Outcomes as `\|0011⟩` so leading zeros survive type inference, plus one 0/1 column per bit (`c0` = rightmost) |
| Open results in [Data Wrangler](https://marketplace.visualstudio.com/items?itemName=ms-toolsai.datawrangler) | ✅ | Optional; offers to install it. Column statistics of `c0…cN` give per-bit probabilities |
| Analysis notebook (`analysis.ipynb`) next to the results | ✅ | pandas + matplotlib: summary, per-bit statistics, correlations, histogram, per-shot data, ideal comparison. Never overwritten once created |

### Billing estimate

| Feature | Status | Notes |
| --- | --- | --- |
| Estimator in the sidebar: shots, circuits, submissions, circuit time | ✅ | Also lists the submissions found in the active editor |
| Formula from the [VLQ consumption guide](https://docs.it4i.cz/en/docs/clusters/vlq/vlq-consumption-guide) | ✅ | Checked against the guide's examples in unit tests |
| Exact circuit time from the transpiled circuit and calibration data (instead of the 0–50 µs range) | 🗓️ | |

### Pulse-level operator catalog

| Feature | Status | Notes |
| --- | --- | --- |
| Operators as files (`.qaas/operators/*.yaml`): waveform, parameters, target gate, qubits | 🗓️ | Versioned in git |
| Each operator tied to the calibration set it was tuned on | 🗓️ | Jobs already record their calibration set |
| Migrate operators from an old calibration set to the current one | 🗓️ | |
| Waveform editor with live I/Q plot and hardware limit checks | 🗓️ | |
| Use custom operators from OpenQASM 3 (`defcal`) | 🗓️ | |
| Pulse schedule timeline after compilation | 🗓️ | |
| Calibration recipes (Rabi, Ramsey, T1) that write fitted values back to the operator | 🗓️ | |

## Billing estimate

```
billed [s] = VLQ jobs × max(shots × (350 µs + circuit time), 0.9 s)      circuit time ≤ 50 µs
```

qaas sends every circuit of a batch as its own HEAppE task, so the extension counts **each
circuit as one VLQ job**, each with the 0.9 s minimum. Unless the circuit time is known,
estimates are shown as a range: 350 µs per shot (low) to 400 µs per shot (worst case, use
for budgeting). Submission latency of 3–15 s is not billed.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `qaas.pythonPath` | *(empty)* | Python 3.12 with qaas. Empty uses the Python extension's selection, then `python3` |
| `qaas.condaPath` | *(empty)* | `conda` executable when it is not found automatically |
| `qaas.packageExtra` | `iqm_qiskit` | IQM extra installed with qaas |
| `qaas.lexisProject` | *(empty)* | LEXIS project identifier |
| `qaas.lexisResource` | *(empty)* | LEXIS resource; empty lets the client choose |
| `qaas.backendName` | `VLQ` | Backend name |
| `qaas.defaultShots` | `1024` | Shots for OpenQASM runs |
| `qaas.confirmSubmit` | `true` | Confirm with the estimate before submitting |
| `qaas.showEstimates` | `true` | Estimates above submissions in code |
| `qaas.validateQasm` | `true` | Check `.qasm` files on open and save |
| `qaas.jobPollSeconds` | `20` | Refresh interval for active jobs |
| `qaas.resultsDirectory` | `${workspaceFolder}/qaas-results/${jobId}-${jobName}` | Download folder. Variables: `${workspaceFolder}`, `${userHome}`, `${jobId}`, `${jobName}`, `${project}`, `${date}`, `~` |
| `qaas.downloadMeasurements` | `false` | Also download per-shot measurements |
| `qaas.autoDownloadResults` | `false` | Download when a job finishes |
| `qaas.importJobLimit` | `50` | Jobs fetched by `Import Jobs from HEAppE` |

Scripts started with **Run Python File on VLQ** get `LEXIS_PROJECT`, `LEXIS_RESOURCE`,
`QAAS_BACKEND` and, if set, `LEXIS_TOKEN` as environment variables.

## How it works

The extension does not reimplement the client. It starts
[`python/qaas_bridge.py`](python/qaas_bridge.py) once with your interpreter and talks to it
over stdin/stdout (one JSON request and response per line). The process keeps the LEXIS login
and HEAppE clients alive, and calls `qheappe_client` (`QProvider`, `QBackend`, `QJob`).
Library output goes to the **QaaS** output channel.

## Development

```bash
npm install
pip install -r requirements-dev.txt   # ruff
npm run compile        # or: npm run watch, then F5 for an Extension Development Host
npm run test:unit      # estimator and code scanner (node --test)
npm test               # integration tests in a downloaded VS Code
npm run lint           # Biome (TypeScript/JSON) + Ruff (Python)
npm run format         # format everything
npm run package        # build a .vsix
```

Formatting and linting: [Biome](https://biomejs.dev/) for TypeScript, JavaScript and JSON;
[Ruff](https://docs.astral.sh/ruff/) for Python. The workspace recommends both VS Code
extensions and formats on save.

## License

Apache-2.0
