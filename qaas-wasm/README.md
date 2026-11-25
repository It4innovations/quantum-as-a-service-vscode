# qaas in WebAssembly (Pyodide)

Build recipe for the extension's **WebAssembly runtime** (`qaas.runtime: wasm`, the default): IT4I
[quantum-as-a-service](https://github.com/It4innovations/quantum-as-a-service) (`qheappe_client` +
IQM stack, qiskit compiled to wasm32) on [Pyodide](https://pyodide.org). The extension runs its
Python bridge ([../python/qaas_bridge.py](../python/qaas_bridge.py)) in a Node worker thread with
it, so it needs no local Python.

The build writes `../wasm/` (git-ignored, packaged into the `.vsix`):

```
wasm/
  manifest.json           qaas and Pyodide versions, Pyodide packages to load, placeholder packages, wheels + sha256
  requirements.lock.txt   the installed versions
  wheels/                 qaas, py4lexis, qiskit (wasm32), python-rapidjson (wasm32), pure-Python dependencies, stubs, adapter
  pyodide/                Pyodide core and only the Pyodide packages these need, plus matplotlib for scripts
```

## Updating to a new qaas or Pyodide release

Run from the repository root; every step is manual:

```bash
npm run wasm:status                     # bundled vs. latest qaas and Pyodide release
npm run wasm:build                      # qaas v1.1.0 (DEFAULT_QAAS in build.py), default Pyodide
npm run wasm:build -- --qaas v1.2.0     # a given qaas tag
npm run wasm:build -- --qaas latest     # the newest release; add --stable to skip pre-releases
npm run wasm:build -- --pyodide 0.29.3  # another Pyodide release
npm run wasm:test                       # smoke test of wasm/ only
```

To move the extension to another qaas release, change it in three places: `DEFAULT_QAAS` in
`build.py`, `QAAS_VERSION` in `src/environments.ts` (what a local Python gets installed) and
`MIN_QAAS` in `python/qaas_bridge.py` (older ones are reported as outdated) — the qaas version
the extension supports.

`build` stops with a message when it cannot continue, for example when qaas needs a newer numpy than
Pyodide ships (then try a newer Pyodide), or a new dependency has no pure-Python wheel and does not
compile. When it succeeds it has already run the smoke test. Then package with `npm run package`.

Needs `git`, [`uv`](https://docs.astral.sh/uv/), Node 24+ and network access to GitHub, PyPI,
IT4I's package index and GitLab (`opencode.it4i.eu`), crates.io, conda-forge and jsDelivr. Runs on macOS (arm64 and x86_64) and Linux x86_64; conda-forge
has no emscripten for linux-aarch64 (so not in Docker on Apple silicon). The cache
(`~/.cache/qaas-wasm`, or `$QAAS_WASM_CACHE`) holds the toolchain and compiled wheels, several GB;
deleting it only costs time.

## What `build.py` does

1. **qaas** is cloned at the release tag and built as a wheel. Its `requires-python` upper bound is
   widened to Pyodide's Python (qaas 1.1.0a1 says `<3.13`; Pyodide 0.27 was the last 3.12 release).
2. **Dependencies** of `qaas[iqm_qiskit]` are resolved with `uv pip compile`, with IT4I's package
   index as an extra index (py4lexis is published there, not on PyPI):
   - A package without a pure-Python wheel on PyPI is taken from Pyodide when Pyodide builds it
     (numpy, scipy, pandas, rustworkx, cryptography, ...) and forced to Pyodide's version.
     Pyodide's builds do not always match PyPI's metadata (its cryptography 46 is built with cffi
     1.17; PyPI's requires cffi 2), so every other package's requirements are then checked against
     Pyodide's versions, and a package that needs newer ones is moved to an older release.
   - A git dependency of a dependency (py4lexis needs `python-http-irods-client @ git+...`) is
     added as a direct requirement, as uv asks, and built from that git tag; it must be pure Python.
   - `grpcio`, `symengine`, `scipy-stubs` and `psutil` are micropip placeholders: not importable,
     never imported by the bridge. `qiskit-aer` is a stub wheel
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
   (`out/wasm/worker.js`): startup, `check`, `analyze`, `simulate`, `pulseSample`, py4lexis
   renewing a made-up refresh token at LEXIS's Keycloak and a request to the real LEXIS API with a
   made-up access token (both must fail with an authentication error, not a transport or import
   error), and the bridge's unit tests ([../python/tests](../python/tests)) inside Pyodide.

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
- `multiprocessing.pool.ThreadPool` (py4heappe) and `concurrent.futures.ThreadPoolExecutor` (qiskit's
  primitives) are replaced by pools that run each task at once in the caller: Pyodide cannot start
  threads.
- `webbrowser.open` reports "no browser" in a worker (Pyodide's version needs `window`), so the
  py4lexis browser login only prints its URL, which the extension offers as a notification.
- py4lexis and python-keycloak use `requests`, which works unchanged: urllib3 2.x sends requests
  through `fetch` and JSPI in Pyodide.

## Scripts (Run Python File on QPU)

The worker has a second mode for user scripts (`mode: "script"`): it loads the same bundle plus
`script_packages` (matplotlib), then runs one script with
[../python/qaas_script.py](../python/qaas_script.py): imports checked with `find_spec` (missing ones
stop the run before anything executes), `runpy` as `__main__`, `plt.show()` saving PNG files. The
manifest's `modules` (top-level import names of the bundle) and `stdlib` let the extension check
imports without starting Pyodide, for the hints in the editor and before the cost confirmation.
`input()` blocks the worker on a `SharedArrayBuffer` until the terminal sends a line.

## Limitations of the WebAssembly runtime

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
