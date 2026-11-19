# qaas in WebAssembly (Pyodide)

Build recipe for the extension's **WebAssembly runtime** (setting `qaas.runtime: wasm`): IT4I
[quantum-as-a-service](https://github.com/It4innovations/quantum-as-a-service) (`qheappe_client` +
IQM stack, qiskit compiled to wasm32) on [Pyodide](https://pyodide.org). The extension runs its
Python bridge ([../python/qaas_bridge.py](../python/qaas_bridge.py)) in a Node worker thread with
it, so it needs no local Python.

The build writes `../wasm/` (git-ignored, packaged into the `.vsix`):

```
wasm/
  manifest.json           qaas and Pyodide versions, Pyodide packages to load, placeholder packages, wheels + sha256
  requirements.lock.txt   the installed versions
  wheels/                 qaas, qiskit (wasm32), python-rapidjson (wasm32), pure-Python dependencies, stubs, adapter
  pyodide/                Pyodide core and only the Pyodide packages these need (about 40 MB)
```

## Updating to a new qaas or Pyodide release

Run from the repository root; every step is manual:

```bash
npm run wasm:status                     # bundled vs. latest qaas and Pyodide release
npm run wasm:build                      # latest qaas release (pre-releases included), default Pyodide
npm run wasm:build -- --qaas v1.2.0     # a given qaas tag; --stable skips pre-releases
npm run wasm:build -- --pyodide 0.29.3  # another Pyodide release
npm run wasm:test                       # smoke test of wasm/ only
```

`build` stops with a message when it cannot continue, for example when qaas needs a newer numpy than
Pyodide ships (then try a newer Pyodide), or a new dependency has no pure-Python wheel and does not
compile. When it succeeds it has already run the smoke test. Then package with `npm run package`.

Needs `git`, [`uv`](https://docs.astral.sh/uv/), Node 24+ and network access to GitHub, PyPI,
crates.io, conda-forge and jsDelivr. Runs on macOS (arm64 and x86_64) and Linux x86_64; conda-forge
has no emscripten for linux-aarch64 (so not in Docker on Apple silicon). The cache
(`~/.cache/qaas-wasm`, or `$QAAS_WASM_CACHE`) holds the toolchain and compiled wheels, several GB;
deleting it only costs time.

## What `build.py` does

1. **qaas** is cloned at the release tag and built as a wheel. Its `requires-python` upper bound is
   widened to Pyodide's Python (qaas 1.1.0a1 says `<3.13`; Pyodide 0.27 was the last 3.12 release).
2. **Dependencies** of `qaas[iqm_qiskit]` are resolved with `uv pip compile`:
   - A package without a pure-Python wheel on PyPI is taken from Pyodide when Pyodide builds it
     (numpy, scipy, pandas, rustworkx, cryptography, ...) and forced to Pyodide's version.
     Pyodide's builds do not always match PyPI's metadata (its cryptography 46 is built with cffi
     1.17; PyPI's requires cffi 2), so every other package's requirements are then checked against
     Pyodide's versions, and a package that needs newer ones is moved to an older release.
   - `py4lexis`, `grpcio`, `symengine`, `scipy-stubs` and `psutil` are micropip placeholders: not
     importable, never imported by the bridge. `qiskit-aer` is a stub wheel
     ([build-recipe/stubs/qiskit_aer_stub](build-recipe/stubs/qiskit_aer_stub)): IQM's fake
     backends build noise models at import time; `AerSimulator` raises.
3. **Wheels**: pure-Python ones from PyPI (sha256 checked). Everything else is compiled for wasm32
   from its sdist with `pyodide build`, using emscripten (the version Pyodide's cross-build
   environment names), Rust and binaryen from conda-forge. Compiled wheels are cached per Pyodide
   version, so qiskit (Rust, the slow one) is only rebuilt when its version changes. They are
   renamed to Pyodide's platform tag (pyodide-build ≥ 0.39 writes `pyemscripten_2025_0`, Pyodide
   0.29's micropip wants `pyodide_2025_0`; same ABI).
4. **Crate patches** in [build-recipe/patches](build-recipe/patches) are applied to Rust projects
   that lock the crate and version a patch names (`--- a/<crate>-<version>/...`); a patch for
   another version is reported, not applied:
   - `rand_pcg 0.3.1` hides `Pcg64` on emscripten, which rustworkx-core needs.
   - `rayon-core 1.12.1` only falls back to one thread on `Unsupported`; emscripten without
     pthreads returns `WouldBlock`, and transpiling panics with "global thread pool has not been
     initialized".
5. **wasm/** is assembled: the wheels, `manifest.json`, and the Pyodide core files plus the
   packages the manifest loads (downloaded from jsDelivr, checked against `pyodide-lock.json`).
6. **Smoke test** ([smoke-test.mjs](smoke-test.mjs)), through the extension's own worker
   (`out/wasm/worker.js`): startup, `check`, `analyze`, `simulate`, `pulseSample`, the refusal of
   refresh tokens, a request to the real LEXIS API with a made-up token (expects an authentication
   error, not a transport error), and the bridge's unit tests ([../python/tests](../python/tests))
   inside Pyodide.

## The adapter (`qaas-pyodide`)

[build-recipe/stubs/qaas_pyodide](build-recipe/stubs/qaas_pyodide) adapts `qheappe_client.QClient`,
which was written for CPython, without changing qaas:

- HTTP goes through `fetch` (an aiohttp `ClientSession` subset: query parameters, JSON, multipart
  uploads, timeouts, error mapping). In VS Code that is Node's `fetch`, so CORS does not apply.
- The sync API (`get_backend()`, `job.result()`, ...) runs on Pyodide's event loop through
  `pyodide.ffi.run_sync`, which needs JSPI (VS Code's Electron, Node 24+, Chrome/Edge 137+). QClient
  refuses sync calls from the loop that owns its HTTP session, because on CPython that would
  deadlock; with JSPI the loop keeps running, so the adapter turns that check off.
- The HEAppE events WebSocket is declined; waiting for a job falls back to polling.

## Limitations of the WebAssembly runtime

- **Sign-in**: py4lexis is a placeholder, so no browser login and no refresh tokens. It works with
  the IT4I Workflows sign-in (`qaas.workflowsIntegration`) or a pasted access token.
- **Startup**: about 10 s on the first LEXIS command of a VS Code window (Apple M-series).
- **Single-threaded qiskit**: rayon falls back to one thread.
- **Windows**: drives are mounted at `/mnt/<letter>` and paths translated; not tested yet.
- No Aer simulation (the extension's ideal simulation uses `Statevector`, which works).

## Other files

- [index.html](index.html) and [qaas-loader.mjs](qaas-loader.mjs): browser demo of the same bundle.
  Serve the repository root (`python3 -m http.server 8000`) and open
  `http://localhost:8000/qaas-wasm/`. In a browser the LEXIS/HEAppE endpoints must allow the page's
  origin (CORS).
- [dev-tests](dev-tests): development aids. `run.mjs` runs a Python file in Pyodide in Node
  (`t_transport.py` against `echo_server.py`, `t_pytest.py` for qaas's own offline tests);
  `browser_test.py` drives the demo in headless Chrome (Playwright).
