# Quantum-as-a-Service for VS Code

Run OpenQASM 3 and Qiskit circuits from VS Code on the quantum computers (QPUs) your LEXIS
project has access to through its resource, via [LEXIS](https://docs.lexis.tech/) and
[HEAppE](https://heappe.eu/), using the [`qaas`](https://pypi.org/project/qaas/) Python package
(QHEAppE client). The backend is the one of the LEXIS resource, or the one chosen with
`QaaS: Choose Backend` (`qaas.backendName`).

No Python installation is needed: qaas, qiskit and the IQM stack come with the extension, compiled
to WebAssembly (see [WebAssembly runtime](#webassembly-runtime)). A local Python with qaas is
optional, for calibration notebooks, scripts that need other libraries, or a different qaas version.

## Features and roadmap

Status: ✅ available and tested (live items verified on IT4I's VLQ, 2026-11-11) · 🔶 available, not yet verified against a live QPU · ⚠️ available, blocked by a server-side issue · 🗓️ planned

### qaas runtime and Python environment

| Feature | Status | Notes |
| --- | --- | --- |
| Find interpreters: workspace venvs, conda / miniconda / miniforge envs, pyenv versions, Python extension environments, system Python | ✅ | `QaaS: Select Python Interpreter` shows each one's Python version and installed qaas |
| Create a Python 3.12 venv (from any 3.12 interpreter, e.g. pyenv) or a conda env, then install qaas | ✅ | `QaaS: Create Python Environment for qaas` |
| Install / upgrade `qaas[<extra>]==1.1.0` (PyPI, with IT4I's package index for py4lexis) | ✅ | Runs `python -m pip` as a VS Code task. Checks for Python 3.12 and warns outside a venv/conda env |
| qaas in WebAssembly, bundled with the extension: no local Python needed (default, `qaas.runtime: wasm`) | 🔶 | See [WebAssembly runtime](#webassembly-runtime). Same bridge code and the same sign-in methods; its Python tests pass in Pyodide, and requests reach LEXIS and its login. Not yet verified against a live QPU. The rows below are optional, for a local Python |
| Environment check (qaas, qiskit, iqm-client, iqm-pulla, py4lexis versions) | ✅ | Flags qaas older than 1.1.0. Runs before LEXIS commands: an unsuitable interpreter (e.g. macOS's Python 3.9) gets Select Interpreter / Create Environment / Install qaas instead of a crash |

### Login and backends

| Feature | Status | Notes |
| --- | --- | --- |
| **Synchronize with LEXIS Platform**: sign in, check the backend, import jobs from HEAppE, refresh active jobs and the calibration set | 🔶 | Jobs view title bar and welcome screen. Each step is verified on VLQ; the combined flow is new |
| Sign-in prompt before any LEXIS command when not signed in: browser login, paste a refresh/access token, or a dev connection file | 🔶 | `QaaS: Sign in to LEXIS…` switches account or method. In `workflows` mode it shows the IT4I Workflows sign-in instead |
| Sign in through the IT4I Workflows extension (`qaas.workflowsIntegration` on), without py4lexis | 🔶 | See [Sign in through IT4I Workflows](#sign-in-through-it4i-workflows). Not yet verified against a live QPU |
| LEXIS browser login, kept for the whole VS Code session | 🔶 | The login URL is also offered as a notification (works on remote hosts) |
| LEXIS token in VS Code secret storage | ✅ | `QaaS: Set LEXIS Token` / `Log Out of LEXIS` (also in the Jobs view's ⋯ menu). A refresh/offline token is renewed automatically; an access token is used as is. Tokens are stored per LEXIS instance and only sent to that instance. Log out revokes the refresh tokens on the server (stored ones and this session's browser logins) and clears them; a token in the dev file or `QAAS_LEXIS_TOKEN` is revoked only if you confirm, since other tools may share it. Verified with both on production and the test instance |
| Other LEXIS instances (test instance) via settings or a git-ignored dev connection file | ✅ | See [Testing against the LEXIS test instance](#testing-against-the-lexis-test-instance). Status bar shows `LEXIS test`; jobs remember their instance |
| `QaaS: Test LEXIS Connection` | ✅ | Logs in, shows the user and token expiry, lists backends |
| List backends and choose the default | ✅ | Status bar shows the current backend |
| Topology view: qubit connectivity, calibration fidelities, chosen layout | 🗓️ | |
| Remaining allocation in the status bar | 🗓️ | |

### OpenQASM 3

| Feature | Status | Notes |
| --- | --- | --- |
| `.qasm` language: syntax highlighting, comments, brackets | ✅ | |
| Errors shown in the editor (Qiskit OpenQASM 3 importer, on open and save) | ✅ | No login needed |
| Transpile for the backend: diff of original vs. transpiled QASM, depth / 2-qubit gates / layout | ✅ | `Transpile` above the file or in the editor title. Shows the backend's native gates (e.g. IQM's `r`, `cz` and `move` to a resonator) |
| Run on the QPU, with shots prompt and billed-time estimate (backends with a billing model) before submitting | ✅ | Several `.qasm` files selected in the explorer are sent as one job |
| `input` parameters with value prompts and sweeps | 🗓️ | |

### Python scripts and notebooks

| Feature | Status | Notes |
| --- | --- | --- |
| Billed-time estimate above every `backend.run(...)` and `pulla.submit_playlist(...)` | ✅ | In `.py` files and `.ipynb` cells. Reads shots and circuit counts from literals and simple assignments, including earlier notebook cells |
| Run Python file on the QPU, with LEXIS settings passed as environment variables | ✅ | Asks for confirmation with the total estimate |
| Run Python files in the WebAssembly runtime, no local Python needed (default) | 🔶 | See [Python scripts in the WebAssembly runtime](#python-scripts-in-the-webassembly-runtime). Output, `input()` and Ctrl+C in the terminal, plots open in VS Code. Imports the bundle lacks are found before the run, with your local Python offered instead |
| Script run panel: every job the script submits (circuit or pulse-level), with live state and results | 🔶 | Opens with the script's first job; the jobs are also added to the Jobs view at once. Finished jobs' results are fetched into the results folder and summarised (top outcomes); Results and Cancel per job. WebAssembly runtime only; jobs from a local Python appear after an import |
| Hints on imports of QPU scripts the WebAssembly runtime does not have, and `QaaS: Show Bundled Python Libraries` | 🔶 | Information hints in the editor, linked to the library overview |
| Track jobs submitted from scripts automatically | 🗓️ | For now: `Import Jobs from HEAppE` |
| Results renderer for notebook outputs | 🗓️ | |

### Job manager

| Feature | Status | Notes |
| --- | --- | --- |
| Jobs view with state, shots, estimate, calibration set and source file | ✅ | |
| Jobs survive restarts; active jobs are refreshed in the background | ✅ | Background refresh starts only when no login prompt can appear |
| Automatic refresh of active jobs on or off: eye button in the Jobs view title bar: open eye on, closed eye off (`qaas.autoRefreshJobs`) | 🔶 | Off: states change only with Refresh or Synchronize. HEAppE state 256 (deleted, also for some failed jobs) counts as final |
| Import past jobs from HEAppE (`ListJobsForCurrentUser`) | ✅ | |
| Jobs grouped into **Own and accessible** and **Other users' jobs (no access)**, labelled by LEXIS resource (e.g. `VLQ-EU`) | 🔶 | HEAppE lists every user's jobs to Managers/Administrators but only lets the submitter read them. The no-access group (by resource) has no actions and is never polled; a 403 moves an imported job there. Ownership and resources verified on VLQ |
| Cancel, copy ID, remove from list | ⚠️ | Copy ID and remove work. Cancel reaches HEAppE, but HEAppE sends QScheduler `session:X:task:Y` minus the prefix as a session ID, which QScheduler rejects (HTTP 502); reported to HEAppE. The extension reports the refusal |
| Notification when a job finishes; optional automatic download | ✅ | |

### Results and analysis

| Feature | Status | Notes |
| --- | --- | --- |
| Download results to a configurable path (`qaas.resultsDirectory`) or a folder you pick | ✅ | Writes `counts.json`, `counts.csv`, `raw_artifacts.json`, `job.json`; `shots.csv` with per-shot measurements (`qaas.downloadMeasurements`) |
| Download several selected jobs at once | ✅ | |
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
| Billing models per backend (published consumption rules); no estimate for a backend without one | ✅ | See [Billing estimate](#billing-estimate). The VLQ model is checked against its consumption guide's examples in unit tests |
| Exact circuit time from the transpiled circuit and calibration data (instead of the 0–50 µs range) | 🗓️ | |

### Calibrations

| Feature | Status | Notes |
| --- | --- | --- |
| Calibrations view: the current calibration set and every set seen on jobs, in operator files or in earlier refreshes | ✅ | HEAppE/QScheduler cannot list calibration sets, so the view lists known IDs; `Open Calibration Set by ID…` adds others. A new current set is announced with **Compare** |
| Fetch quality metrics of the current set or one by ID, cached locally | ✅ | `calibrationMetrics` via QScheduler `MachineCalibration` (metrics). Sets IQM no longer serves are reported clearly. Verified on VLQ |
| Calibration panel: median tiles with the worst qubit, per-qubit dot plot with uncertainties, chip diagram (qubits around the resonator) coloured by any metric, table of all metrics per qubit with ⚠ on the two worst | 🔶 | T1, T2*, T2 echo, PRX / Clifford / CZ / MOVE fidelity, readout fidelity and errors, QND; resonator T1/T2 and GHZ population in a separate table. Rendered with real VLQ data, not yet clicked through in VS Code |
| Compare two calibration sets: paired points, change per tile, table of changes (blue better / red worse) | 🔶 | |
| Export a calibration set as tidy CSV (raw SI value, display value, uncertainty), optionally in Data Wrangler | ✅ | |
| Calibration history over time (trend per qubit) | 🗓️ | Needs IQM/QScheduler to list past calibration sets |

### Pulse-level operator catalog

| Feature | Status | Notes |
| --- | --- | --- |
| Operators as files (`.qaas/operators/*.yaml`, also `.yml`/`.json`) for custom `prx` pulses | ✅ | Versioned with your code. JSON schema gives completion and checks (with the YAML extension) |
| Shapes: built-in IQM waveforms, expressions of `t`, sample points; Q channel zero, derivative of I (DRAG) or its own shape | ✅ | One Python code generator for preview, submission and inserted code. Matches IQM's own waveforms sample for sample |
| Safe expressions | ✅ | Parsed and allowlisted (arithmetic, `pi`, `e`, numpy math functions); a shared catalog cannot run arbitrary code |
| Pulse Operators view: operators, calibration entries per calibration set, values per qubit | ✅ | Status: calibrated, draft, needs migration |
| Errors in operator files: YAML, schema, duplicate names, unknown waveforms, expressions, peak amplitude > 1 | ✅ | Deep checks run in Python on save, no login needed |
| Waveform editor: live I/Q plot, values per qubit, checks against the hardware limits | ✅ | Peak amplitude, sample count, duration granularity, comparison with the native gate |
| Calibration entries tied to the calibration set they were tuned on | ✅ | Older entries are marked; a calibration set change is reported |
| Current calibration set and native `prx` values from the backend | ✅ | `Refresh Current Calibration Set`; cached, re-read before pulse runs after `qaas.calibrationMaxAgeMinutes` |
| Migrate an operator to the current calibration set | ✅ | Rescale amplitudes by the native gate's change (default) or copy. Result is a draft until verified |
| Start a draft from the native gate (duration, amplitude) | ✅ | For new operators or new calibration sets |
| Run OpenQASM 3 at pulse level with operators | ✅ | `// @qaas operator prx=<name>` in the file, or `Run with operator…`. Asks before using draft or older values |
| Pulse jobs in the Jobs view, with operators and calibration set; result download | ✅ | Same results view, CSV exports and notebook as circuit jobs. Also after a restart: the job is recompiled from its stored sources and operators to map results to bits |
| Pulse-level jobs marked in the Jobs view (pulse icon, `pulse-level`), including imported ones (HEAppE task `qpulla_pulse_task`) | ✅ | Imported pulse jobs (notebooks, scripts) are downloaded by rebuilding counts from their raw per-qubit readouts (`QB1__c_2_0_1` = qubit, register, bit); identical to the exact conversion on VLQ. For parameter sweeps the shots of all sweep points are combined |
| Jobs whose results could not be fetched: warning icon, orange label, reason in the tooltip | ✅ | Cleared by the next successful download |
| Insert Python code for an operator (classes, calibration, `register_qaas_operators` / `apply_qaas_operators`) | ✅ | For scripts and notebooks using `QPulla` |
| Rabi amplitude calibration notebook that writes the result back | ✅ | Generated per operator and qubit; 7 jobs, estimate shown before creating. Fits the Rabi curve to all rounds (weighted by shots). Uses `LEXIS_TOKEN` when set, otherwise the browser login. The result file is offered for saving into the operator |
| `defcal` in OpenQASM 3 | 🗓️ | Qiskit's OpenQASM 3 importer does not support `defcal` yet; the comment directive is used instead |
| Pulse schedule timeline after compilation | 🗓️ | |
| Ramsey and T1 calibration recipes | 🗓️ | |
| Operators for other gates (`cz`, `measure`, `move`) | 🗓️ | Only `prx` (`PRX_CustomWaveforms`) for now |

## Platform support

Developed and tested on **macOS** (Apple silicon, VS Code 1.145). **Compatibility with Windows and Linux
still has to be checked.** Areas that differ per platform and need testing there:

| Area | What to check |
| --- | --- |
| Interpreter discovery | venv layout (`Scripts\python.exe` on Windows), conda / miniconda / miniforge locations, pyenv vs. pyenv-win, the Microsoft Store Python stub |
| Environment creation and qaas install | `python -m venv`, `conda create`, pip as a VS Code task in PowerShell / cmd |
| Run Python File on QPU | Terminal quoting and environment variables in PowerShell and cmd |
| Python bridge | Process start and the JSON-lines protocol on Windows (stdin/stdout duplication, line endings), browser-login notification |
| Paths | `qaas.resultsDirectory` variables, `~` expansion, `.qaas/` files, downloads with backslashes |
| Webviews and Data Wrangler | Results and calibration panels, waveform editor, `openWith` for Data Wrangler |

| Platform | Status |
| --- | --- |
| macOS | ✅ |
| Linux | 🗓️ to be checked |
| Windows | 🗓️ to be checked |

## Operator files

```yaml
# .qaas/operators/hann_drag.yaml
schema: qaas-operator/v1
name: hann_drag                 # implementation name for the IQM compiler
gate: prx
description: Hann pulse with DRAG
parameters:                     # shared by I and Q; unit s = seconds, Hz, or dimensionless
  width: { default: 0.2 }
waveform:
  i: { type: expression, expression: "cos(pi * t) ** 2" }   # t in [-1/2, 1/2] of the pulse
  q: { type: derivative }                                    # or zero / builtin / expression / samples
calibrations:
  - calibrationSetId: 7f3c…      # calibration set the values were tuned on
    backend: VLQ
    status: calibrated          # or draft (seeded / migrated, not verified)
    verifiedLoci: [QB1]
    reference: { implementation: drag_crf, loci: { QB1: { duration: 4.0e-8, amplitude_i: 0.31 } } }
    loci:
      QB1: { duration: 4.0e-8, amplitude_i: 0.42, amplitude_q: 0.02 }
```

- **Built-in shapes**: `{ type: builtin, name: Gaussian }` and other waveforms from `iqm.models.playlist.waveforms`.
  Their fields become parameters (time-like ones in seconds).
- **Expressions**: arithmetic, `**`, `%`, `pi`, `e`, comparisons inside `where`, and `sin cos tan arcsin arccos
  arctan sinh cosh tanh exp log sqrt abs sign minimum maximum clip where heaviside`.
- **Samples**: values in [-1, 1], linearly interpolated over the pulse.
- **Values per qubit**: `duration`, `amplitude_i`, `amplitude_q`, and any parameter to override for that qubit.
- **OpenQASM 3**: add `// @qaas operator prx=hann_drag` to run the file at pulse level with the operator.
- **Calibration results** from the Rabi notebook are written to `.qaas/calibrations/*.json`.

## Billing estimate

| Feature | Status | Notes |
| --- | --- | --- |
| Estimator in the sidebar: shots, circuits, submissions, circuit time | ✅ | Also lists the submissions found in the active editor |
| Billing models per backend (published consumption rules); no estimate for a backend without one | ✅ | See [Billing estimate](#billing-estimate). The VLQ model is checked against its consumption guide's examples in unit tests |
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

Billed time depends on the QPU's consumption rules. QaaS estimates it for backends whose rules it
knows (`BILLING_MODELS` in [src/core/estimate.ts](src/core/estimate.ts)); for any other backend
(e.g. EQE at LRZ) it shows the submissions it finds and says that the cost cannot be estimated,
instead of guessing. The billing model follows the backend in use: `qaas.backendName`, or the
backend LEXIS reports for the resource.

Known models:

| Backend | Billed time | Source |
| --- | --- | --- |
| VLQ (IT4I) | `jobs × max(shots × (350 µs + circuit time), 0.9 s)`, circuit time ≤ 50 µs | [VLQ consumption guide](https://docs.it4i.cz/en/docs/clusters/vlq/vlq-consumption-guide) |

qaas sends every circuit of a batch as its own HEAppE task, so the extension counts **each
circuit as one job**, each with the per-job minimum. Unless the circuit time is known,
estimates are shown as a range (for VLQ: 350 µs per shot, low, to 400 µs per shot, worst case,
use for budgeting). Submission latency is not billed.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `qaas.runtime` | `wasm` | `wasm`: qaas in the WebAssembly runtime bundled with the extension (no local Python). `python`: a local Python with qaas (`qaas.pythonPath`) |
| `qaas.pythonPath` | *(empty)* | Python 3.12 with qaas. Empty uses the Python extension's selection, then `python3`. A value from workspace settings is used only after you allow it once (interpreters picked with **Select Python Interpreter** are allowed automatically); the same applies to `qaas.condaPath` |
| `qaas.condaPath` | *(empty)* | `conda` executable when it is not found automatically |
| `qaas.packageExtra` | `iqm_qiskit` | IQM extra installed with qaas |
| `qaas.workflowsIntegration` | `false` | `true`: sign in through the IT4I Workflows extension instead of py4lexis (see below) |
| `qaas.workflowsService` | `core` | IT4I Workflows service used in `workflows` mode: `core` (LEXIS production) or `efp` (EFP Workflows) |
| `qaas.lexisProject` | *(empty)* | LEXIS project identifier |
| `qaas.lexisResource` | *(empty)* | LEXIS resource; empty lets the client choose |
| `qaas.backendName` | *(empty)* | Backend name. Empty: the backend of the LEXIS resource, as qaas chooses it; the status bar shows its name once LEXIS reports it |
| `qaas.lexisAaiUrl` | *(empty)* | LEXIS login (Keycloak) URL; empty is production `https://aai.lexis.tech` |
| `qaas.lexisApiUrl` | *(empty)* | LEXIS Platform API URL; empty is production `https://api.lexis.tech` |
| `qaas.lexisRealm` | *(empty)* | Keycloak realm; empty is the py4lexis default `LEXIS_AAI_v2` |
| `qaas.devConnectionFile` | `${workspaceFolder}/.qaas/dev.env` | Dev connection file; when it exists it overrides the LEXIS settings and token |
| `qaas.defaultShots` | `1024` | Shots for OpenQASM runs |
| `qaas.confirmSubmit` | `true` | Confirm with the estimate before submitting |
| `qaas.showEstimates` | `true` | Estimates above submissions in code |
| `qaas.validateQasm` | `true` | Check `.qasm` files on open and save |
| `qaas.jobPollSeconds` | `20` | Refresh interval for active jobs |
| `qaas.resultsDirectory` | `${workspaceFolder}/qaas-results/${jobId}-${jobName}` | Download folder. Variables: `${workspaceFolder}`, `${userHome}`, `${jobId}`, `${jobName}`, `${project}`, `${date}`, `~` |
| `qaas.downloadMeasurements` | `false` | Also download per-shot measurements |
| `qaas.autoDownloadResults` | `false` | Download when a job finishes |
| `qaas.importJobLimit` | `50` | Jobs fetched by `Import Jobs from HEAppE` |
| `qaas.pulseSampleRate` | `2e9` | Drive sample rate for waveform previews before the calibration set is fetched |
| `qaas.calibrationMaxAgeMinutes` | `60` | Pulse runs re-read the current calibration set when the cached one is older |

Scripts started with **Run Python File on QPU** get `LEXIS_PROJECT`, `LEXIS_RESOURCE`,
`QAAS_BACKEND`, `LEXIS_TOKEN` and, for a non-production instance, `PY4LEXIS_AAI_URL`,
`PY4LEXIS_API_URL` and `PY4LEXIS_REALM` as environment variables (those that are set; with
`qaas.workflowsService` set to `efp`, only `PY4LEXIS_API_URL`). `LEXIS_TOKEN` is always a
short-lived **access token** issued by the bridge (also after a browser login), never the stored
refresh token, because everything started in that terminal can read it. Scripts that still need
LEXIS after it expires (usually minutes; the expiry is shown when the script starts) must be run
again.

## WebAssembly runtime

By default (`qaas.runtime: wasm`) the extension runs its Python bridge in
[Pyodide](https://pyodide.org) (CPython compiled to WebAssembly) in a worker thread of VS Code's
extension host. qaas, py4lexis, qiskit (compiled to WebAssembly) and the IQM stack come with the
extension in its `wasm/` folder, so no Python, venv or `pip install` is needed.

- The same bridge code serves every feature: transpile, run, jobs, downloads, calibrations,
  pulse-level operators, ideal simulation, OpenQASM checks. Result files are written to the same
  folders. Not yet verified against a live QPU.
- Every sign-in method works: browser login, refresh/offline and access tokens, the dev connection
  file, IT4I Workflows.
- The first LEXIS command of a window loads the runtime (about 10 s); the status bar shows it.
- Python scripts run there too (see below). A local Python is only needed for calibration
  notebooks, scripts that import something the bundle lacks, and `qaas.runtime: python` (e.g. to
  use a qaas version other than the bundled one). `QaaS: Check qaas Environment` shows the bundled
  versions.
- The LEXIS browser login cannot open a browser from the runtime: a notification shows the login
  code and an **Open Login Page** button. Sign in in the browser; QaaS continues on its own.
- Needs JSPI (WebAssembly stack switching), which VS Code's Electron has. qiskit runs single-threaded.
- A build of the extension without `wasm/` (e.g. a development checkout) uses the local Python.

`wasm/` is not in git. Build it, and update it to a new qaas or Pyodide release, with
`npm run wasm:build`; see [qaas-wasm/README.md](qaas-wasm/README.md).

### Python scripts in the WebAssembly runtime

`QaaS: Run Python File on QPU` runs the script in the WebAssembly runtime, in its own worker and a
`QaaS run` terminal, like `python script.py` (same environment variables, `__name__ == "__main__"`,
the workspace folder as working directory).

- **Bundled libraries**: qaas (`qheappe_client`), py4lexis, py4heappe, the IQM stack (iqm-client,
  iqm-pulla, iqm-pulse), qiskit, qiskit-qasm3-import, numpy, scipy, pandas, xarray, matplotlib,
  rustworkx, requests, pydantic, pyyaml and the Python standard library.
  **`QaaS: Show Bundled Python Libraries`** lists every package with its version, with tips.
- **Before the run** QaaS checks the imports. When one is not bundled (e.g. `torch`), it offers
  **Run with Local Python** (`qaas.pythonPath`) instead; nothing is submitted. The editor marks
  such imports in QPU scripts with an information hint.
- **Simulation**: use `qiskit.primitives.StatevectorSampler` or `qiskit.quantum_info.Statevector`.
  Qiskit Aer is not available; scripts that import it get a choice before the run.
- **Plots**: `plt.show()` saves the figures as PNG files and opens them in VS Code (also
  `qiskit.visualization.plot_histogram`).
- **Terminal**: output appears as it is printed, `input()` reads a line you type, Ctrl+C stops the
  script.
- **Not available**: threads, subprocesses and process pools (thread pools run their tasks one after
  another); packages that are not bundled. qiskit runs single-threaded.
- The first run of a window loads a worker (about 10 s); the next run starts at once.
- **Jobs**: every job the script submits appears in the Jobs view at once, and in a panel for the run
  (state, shots, results summary; Results and Cancel per job). Finished jobs' results are fetched into
  the results folder (`qaas.resultsDirectory`).

## Sign in through IT4I Workflows

With the IT4I Workflows extension (`lexis-platform.lexis-platform`) installed, QaaS can use its sign-in
instead of its own py4lexis login. Turn on `qaas.workflowsIntegration` (IT4I Workflows turns it on in the workspace settings when you open QaaS from it, then runs Synchronize). The jobs view then offers only Synchronize, not the py4lexis sign-in. Without IT4I Workflows installed and enabled (for example after uninstalling it) QaaS signs in on its own and removes `qaas.workflowsIntegration` and `qaas.workflowsService` from the user settings (workspace settings stay, as they may be committed in a repository).

- IT4I Workflows signs in once; its `lexis` CLI keeps the session in the system keyring. QaaS stores no token.
- QaaS asks IT4I Workflows for a short-lived **access token** for every use and keeps it in memory only, until 30 s
  before it expires. The refresh token never leaves the `lexis` CLI.
- The token is used only for the instance of `qaas.workflowsService` (`core`: `https://api.lexis.tech`, `efp`:
  `https://api.workflows.my-eurohpc.eu`); a token for another instance is refused. `qaas.lexisAaiUrl`,
  `qaas.lexisApiUrl`, `qaas.lexisRealm` and the dev connection file's URLs and token are not used in this mode, so the
  LEXIS test instance needs `qaas.workflowsIntegration` off.
- py4lexis is never imported; it does not have to be installed. The bridge refuses any token that is not an access
  token instead of starting a py4lexis login.
- Sign out in IT4I Workflows. `Set LEXIS Token` and `Open Dev Connection File` are hidden in this mode. `Log Out of LEXIS` stays: it revokes the tokens QaaS stored itself before (py4lexis sign-in).
- The status bar tooltip adds "(signed in through IT4I Workflows)". With `qaas.workflowsService` set to `efp`, the
  status bar shows `<backend> · LEXIS workflows` on a warning background; the label comes from the server's host name,
  as with `LEXIS test`.
- `Run Python File on QPU` still passes an access token as `LEXIS_TOKEN` to the script. With `efp`, which counts as a
  non-production instance, the script also gets `PY4LEXIS_API_URL=https://api.workflows.my-eurohpc.eu`.
- The Rabi calibration notebook signs in only with `LEXIS_TOKEN` set in the kernel's environment; without it, it
  falls back to the py4lexis login. Turn `qaas.workflowsIntegration` off for calibration notebooks.

## Testing against the LEXIS test instance

Run **QaaS: Open Dev Connection File**. It creates `.qaas/dev.env` (and adds it to
`.qaas/.gitignore`) with these keys:

```bash
PY4LEXIS_AAI_URL=<login (Keycloak) URL of the instance>
PY4LEXIS_API_URL=<LEXIS Platform API URL of the instance>
PY4LEXIS_REALM=<Keycloak realm of the instance>
QAAS_LEXIS_PROJECT=<test project>
QAAS_LEXIS_RESOURCE=<test resource>
# QAAS_BACKEND_NAME=<backend name; empty: the resource's backend>
QAAS_LEXIS_TOKEN=<refresh or offline token>
```

- Values in the file override the `qaas.*` settings and the stored token; changes apply to the
  next request, no reload needed. Delete or rename the file to go back to production.
- A **refresh/offline token** is exchanged for access tokens by py4lexis and renewed as they
  expire. An access token works too but expires within minutes. Without a token, the browser
  login opens on the test instance.
- The status bar shows e.g. `<backend> · LEXIS test` on a warning background while the file points at a
  non-production instance. Jobs record their instance, so test and production jobs can share the
  Jobs view and are always refreshed against the right one.
- **QaaS: Test LEXIS Connection** logs in, prints the user, token kind and expiry, and lists the
  backends in the **QaaS** output channel.
- Instead of the file, the URLs can be set with `qaas.lexisAaiUrl`, `qaas.lexisApiUrl` and
  `qaas.lexisRealm` (e.g. in workspace settings), and the token with **Set LEXIS Token**.
- A token is only ever sent to the instance it belongs to. Order: the dev file's token (when the
  file selects that instance), the token stored for that instance with **Set LEXIS Token** or
  **Sign in**, then the `QAAS_LEXIS_TOKEN` environment variable (production only). A workspace or
  dev file that points at another server therefore gets no stored token; sign in again there.
- The extension is disabled in untrusted (Restricted Mode) workspaces. In trusted ones, values a
  cloned repository could plant are used only after you allow them once per folder: a
  non-production LEXIS login set by workspace settings or the dev file (the browser login would
  show that server's page), `qaas.pythonPath` / `qaas.condaPath` from workspace settings, an
  interpreter inside the workspace picked by the Python extension, and a workspace
  `qaas.resultsDirectory` outside the workspace. Instances and paths from your user settings
  need no approval.

## How it works

The extension does not reimplement the client. It starts
[`python/qaas_bridge.py`](python/qaas_bridge.py) once with your interpreter and talks to it
over stdin/stdout (one JSON request and response per line). With `qaas.runtime: wasm` the same
bridge runs in Pyodide in a worker thread ([`src/wasm/worker.ts`](src/wasm/worker.ts)), with the
same requests and responses. The process keeps the LEXIS login
and HEAppE clients alive, and calls `qheappe_client` (`QProvider`, `QBackend`, `QJob`).
Library output goes to the **QaaS** output channel. py4lexis writes its log (no tokens) to
`lexis.log` in the extension's log folder (**Developer: Open Extension Logs Folder**), readable
by your user only.

## Development

```bash
npm install
pip install -r requirements-dev.txt   # ruff
npm run compile        # or: npm run watch, then F5 for an Extension Development Host
npm run test:unit      # estimator, scanner, statistics, catalog model (node --test)
npm run test:py        # Python bridge and operator code generator (needs qaas[iqm_qiskit])
npm test               # integration tests in a downloaded VS Code
npm run lint           # Biome (TypeScript/JSON) + Ruff (Python)
npm run format         # format everything
npm run package        # build a .vsix (includes wasm/ when it has been built)
npm run wasm:status    # bundled vs. latest qaas and Pyodide release
npm run wasm:build     # build wasm/ (WebAssembly runtime) for qaas 1.1.0 (-- --qaas <tag|latest>)
npm run wasm:test      # smoke test of wasm/, incl. the Python tests inside Pyodide
```

Formatting and linting: [Biome](https://biomejs.dev/) for TypeScript, JavaScript and JSON;
[Ruff](https://docs.astral.sh/ruff/) for Python. The workspace recommends both VS Code
extensions and formats on save.

## Authors

Developed at [IT4Innovations National Supercomputing Center](https://www.it4i.cz),
VSB - Technical University of Ostrava.

- Ing. Jan Swiatkowski
- Ing. Jan Martinovič, Ph.D.

## License

Apache-2.0
