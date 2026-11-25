# Changelog

## 0.1.0

- Script run panel: jobs a script submits in the WebAssembly runtime appear in the Jobs view at once and in a panel for the run, with live state and a results summary. Eye button in the Jobs view (open: on, closed: off) to turn the automatic refresh of active jobs on or off (`qaas.autoRefreshJobs`). HEAppE job state 256 (deleted) is final instead of unknown.
- Not tied to one QPU: works with any backend of the LEXIS project's resource (e.g. VLQ at IT4I, EQE at LRZ). `qaas.backendName` defaults to empty (the resource's backend, named once LEXIS reports it); commands and messages say QPU or the backend's name. Billed-time estimates use a per-backend billing model (VLQ's is known); other backends get no estimate instead of VLQ's. The script template is now `qpu_circuit.py`.
- WebAssembly runtime, the default (`qaas.runtime: wasm`): the Python bridge runs in Pyodide in a worker thread of the extension host, with qaas 1.1.0, py4lexis, qiskit (compiled to WebAssembly) and the IQM stack bundled in `wasm/`, so no local Python is needed; every sign-in method works there. A local Python is optional (`qaas.runtime: python`, `Run Python File on VLQ`, calibration notebooks). `npm run wasm:build` builds or updates the bundle for a new qaas or Pyodide release.
- qaas 1.1.0: bundled in the WebAssembly runtime; `Install qaas` installs exactly this version into a local Python (with IT4I's package index, which has py4lexis); older ones are reported as outdated.
- Run Python File on VLQ runs scripts in the WebAssembly runtime by default: output, `input()` and Ctrl+C in a terminal, `plt.show()` opens the figures; imports the bundle lacks are found before the run, with the local Python offered instead. `QaaS: Show Bundled Python Libraries` lists the bundled packages with tips; VLQ scripts get hints on imports that are not bundled. matplotlib is bundled for scripts; qiskit's primitives (StatevectorSampler) work.
- The LEXIS browser login notification names the login code and asks to click Open Login Page, since the runtime cannot open a browser itself.
- Billed-time estimates no longer count `backend.run(` mentioned in comments, strings or docstrings.
- A refused cancel shows HEAppE's reason (e.g. the job is already deleted), and the Jobs view takes over the state HEAppE names. Synchronize keeps its results when HEAppE does not deliver the calibration set.
- Downloads and the script template use qaas 1.1's job API: `QJob.result()` takes no arguments (per-shot results through `memory=True`) and returns a qiskit `Result`.
- VLQ-native OpenQASM (`move` on the resonator, as in a transpiled export) parses until qaas handles it; Run from the transpiled view submits the source file.
- The browser login notification now also appears for the login URL LEXIS sends with a single slash (`https:/aai.lexis.tech/...`).
- Sign in through the IT4I Workflows extension: `qaas.workflowsIntegration` (off by default, then QaaS signs in with py4lexis as before) takes a short-lived access token from the IT4I Workflows API for every use, keeps it in memory only and never imports py4lexis; `qaas.workflowsService` picks IT4I Workflows (`core`) or EFP Workflows (`efp`).
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
- LEXIS test instance and other instances: `qaas.lexisAaiUrl` / `qaas.lexisApiUrl` / `qaas.lexisRealm`, or a git-ignored `.qaas/dev.env` with URLs, project, resource and token; refresh/offline tokens renewed automatically; jobs remember their instance; `QaaS: Test LEXIS Connection`; status bar marks non-production instances.
- Pulse-level jobs: marked in the Jobs view (also imported ones, from the HEAppE task name); imported pulse jobs are downloaded by rebuilding counts from raw readouts.
- Jobs whose results could not be fetched get a warning icon, an orange label and the reason in the tooltip.
- Calibrations view and panel: current and known calibration sets, per-qubit metrics (tiles, dot plot, chip diagram, table), comparison of two sets, CSV export.
- Jobs view: "Own and accessible" and "Other users' jobs (no access)" groups, labelled by LEXIS resource; no actions or polling for other users' jobs.
- README: platform support section (Windows and Linux to be checked).
- Job import tells own jobs (`ListJobsForCurrentUser` with `UserId` from `CurrentUserInfo`) from other users' jobs, which HEAppE lists to Managers/Administrators but does not let them read (HTTP 403).
- Synchronize with LEXIS Platform (sign in, backend check, job import, active jobs, calibration set) and a sign-in prompt (browser, pasted refresh/access token, or dev file) before any LEXIS command.
- The bridge starts on any Python 3 and reports an unsuitable interpreter (needs 3.12 with qaas) with Select Interpreter / Create Environment / Install qaas, instead of crashing on `datetime.UTC`.
- Verified on live VLQ; fixes found there: transpiled circuits with IQM's `move` gate export to OpenQASM 3; job import reads py4heappe's snake_case job models; cancel actually sends the request (qaas 1.0.0 does not await it) and reports refusals; pulse job results are mapped to bits with the compile context (kept per session, recompiled after a restart); no py4heappe shutdown tracebacks.
- Rabi notebook: Rabi-curve fit over all rounds instead of the highest point (about 5× more accurate in simulation); `LEXIS_TOKEN` support.
- py4lexis log goes to the temp directory instead of `./lexis_logs.log`.
- Tooling: Biome (TypeScript/JSON) and Ruff (Python) replace ESLint.

## 0.0.1

- Initial scaffold: environment check, qaas install, LEXIS token storage, backend listing, VLQ circuit template, run current file.
- Install qaas 1.0.0+ from PyPI; warn when the installed qaas is older than 1.0.0.
