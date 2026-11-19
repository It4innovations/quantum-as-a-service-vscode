/**
 * WebAssembly runtime of the Python bridge (setting `qaas.runtime: wasm`). Runs in a Node worker
 * thread of the extension host: loads Pyodide and the qaas wheels from the extension's `wasm/`
 * folder, imports `python/qaas_bridge.py`, and answers the same JSON request lines as
 * `python qaas_bridge.py serve`. No local Python is needed.
 *
 * Host files (result downloads, operator files) are reached through Emscripten's NODEFS: each
 * top-level host directory is mounted at the same path, so the paths in requests and responses
 * need no translation on macOS and Linux. Windows drives are mounted at /mnt/<letter> and the
 * paths translated in both directions.
 *
 * The bridge's sync qaas calls block through JSPI (`pyodide.ffi.run_sync`), so every request is
 * entered with `callPromising`.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import type { FromWorker, ToWorker, WasmWorkerData } from "./protocol";

interface Manifest {
  qaas_version: string;
  pyodide_version: string;
  pyodide_packages: string[];
  mock_packages: Record<string, string>;
  wheels: string[];
  sha256: Record<string, string>;
}

// Minimal view of the Pyodide API used here (Pyodide ships no types for this use).
interface PyProxy {
  callPromising(...args: unknown[]): Promise<unknown>;
}
interface EmscriptenFS {
  mkdirTree(p: string): void;
  mount(type: unknown, opts: { root: string }, mountpoint: string): void;
  analyzePath(p: string): { exists: boolean };
  filesystems: { NODEFS: unknown };
}
interface Pyodide {
  FS: EmscriptenFS;
  loadPackage(names: string[], opts?: { messageCallback?: (m: string) => void }): Promise<unknown>;
  runPythonAsync(code: string, opts?: { globals?: unknown }): Promise<unknown>;
  globals: { set(name: string, value: unknown): void };
}

const port = parentPort;
if (!port) {
  throw new Error("worker.ts must run in a worker thread");
}
const data = workerData as WasmWorkerData;
const post = (msg: FromWorker) => port.postMessage(msg);
const log = (text: string) => post({ type: "log", text });

/** Host directories never mounted: Pyodide has its own /dev, /proc and /lib. */
const NOT_MOUNTED = new Set(["dev", "proc", "sys", "lib", "lib32", "lib64", "libx32"]);
/** Pyodide directories the host directory of the same name replaces. */
const REPLACED = new Set(["home", "tmp", "mnt"]);
const WINDOWS = process.platform === "win32";

function mountHost(py: Pyodide): void {
  const { FS } = py;
  const mount = (root: string, at: string) => {
    try {
      FS.mkdirTree(at);
      FS.mount(FS.filesystems.NODEFS, { root }, at);
    } catch (e) {
      log(`[wasm] could not mount ${root} at ${at}: ${(e as Error).message}`);
    }
  };
  if (WINDOWS) {
    for (const letter of "abcdefghijklmnopqrstuvwxyz") {
      const root = `${letter.toUpperCase()}:\\`;
      try {
        statSync(root);
      } catch {
        continue;
      }
      mount(root, `/mnt/${letter}`);
    }
    return;
  }
  for (const name of readdirSync("/")) {
    if (NOT_MOUNTED.has(name) || (FS.analyzePath(`/${name}`).exists && !REPLACED.has(name))) {
      continue;
    }
    try {
      if (!statSync(`/${name}`).isDirectory()) {
        continue;
      }
    } catch {
      continue; // dangling symlink, no permission
    }
    mount(`/${name}`, `/${name}`);
  }
}

/** Windows paths in requests -> /mnt/<drive>/..., and back in responses. */
function mapStrings(value: unknown, f: (s: string) => string): unknown {
  if (typeof value === "string") {
    return f(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => mapStrings(v, f));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, f)]));
  }
  return value;
}
const toWasmPath = (s: string) =>
  /^[A-Za-z]:[\\/]/.test(s) ? `/mnt/${s[0].toLowerCase()}/${s.slice(3).replace(/\\/g, "/")}` : s;
const toHostPath = (s: string) =>
  /^\/mnt\/[a-z](\/|$)/.test(s) ? `${s[5].toUpperCase()}:\\${s.slice(7).replace(/\//g, "\\")}` : s;

function translate(line: string, f: (s: string) => string): string {
  return WINDOWS ? JSON.stringify(mapStrings(JSON.parse(line), f)) : line;
}

function verifyWheels(m: Manifest): void {
  for (const wheel of m.wheels) {
    const expected = m.sha256[wheel];
    const actual = createHash("sha256")
      .update(readFileSync(path.join(data.bundleDir, "wheels", wheel)))
      .digest("hex");
    if (expected && actual !== expected) {
      throw new Error(`wasm/wheels/${wheel} does not match manifest.json (sha256); reinstall the extension.`);
    }
  }
}

async function start(): Promise<PyProxy> {
  const t0 = Date.now();
  if (typeof (globalThis as { WebAssembly?: { Suspending?: unknown } }).WebAssembly?.Suspending !== "function") {
    throw new Error(
      `The WebAssembly runtime needs JSPI (WebAssembly stack switching), which this VS Code (Node ${process.versions.node}) does not have. Update VS Code, or set qaas.runtime to python.`,
    );
  }
  const manifest = JSON.parse(readFileSync(path.join(data.bundleDir, "manifest.json"), "utf8")) as Manifest;
  verifyWheels(manifest);
  const indexURL = path.join(data.bundleDir, "pyodide") + path.sep;
  const { loadPyodide } = (await import(pathToFileURL(path.join(indexURL, "pyodide.mjs")).href)) as {
    loadPyodide: (opts: object) => Promise<Pyodide>;
  };
  post({ type: "status", text: `loading Pyodide ${manifest.pyodide_version}` });
  const py = await loadPyodide({
    indexURL,
    stdout: (s: string) => log(s),
    stderr: (s: string) => log(s),
  });
  post({ type: "status", text: "loading numpy, scipy and other packages" });
  await py.loadPackage(["micropip", ...manifest.pyodide_packages], { messageCallback: () => {} });

  py.FS.mkdirTree("/qaas/wheels");
  py.FS.mount(py.FS.filesystems.NODEFS, { root: path.join(data.bundleDir, "wheels") }, "/qaas/wheels");
  py.FS.mkdirTree("/qaas/python");
  py.FS.mount(py.FS.filesystems.NODEFS, { root: data.pythonDir }, "/qaas/python");
  post({ type: "status", text: `installing qaas ${manifest.qaas_version}` });
  py.globals.set("_qaas_manifest", JSON.stringify(manifest));
  const handle = (await py.runPythonAsync(`
import json, os, sys, micropip
_m = json.loads(_qaas_manifest)
for _name, _version in _m["mock_packages"].items():
    micropip.add_mock_package(_name, _version)
await micropip.install(["emfs:/qaas/wheels/" + w for w in _m["wheels"]], deps=False)
import qaas_pyodide
qaas_pyodide.install()
sys.path.insert(0, "/qaas/python")
os.chdir("/")
import qaas_bridge
_server = qaas_bridge.Server()
del _m, _qaas_manifest
lambda line: qaas_bridge.handle(_server, line)
`)) as PyProxy;
  // Host directories last: the installation above writes to Pyodide's own /lib and /tmp. HOME only
  // now: Pyodide creates the HOME it starts with in memory, which would hide the host's directory.
  mountHost(py);
  py.globals.set("_qaas_home", WINDOWS ? toWasmPath(os.homedir()) : os.homedir());
  await py.runPythonAsync('os.environ["HOME"] = _qaas_home\ndel _qaas_home');
  post({
    type: "ready",
    seconds: (Date.now() - t0) / 1000,
    versions: { qaas: manifest.qaas_version, pyodide: manifest.pyodide_version },
  });
  if (data.testsDir && !WINDOWS) {
    await runTests(py, data.testsDir);
  }
  return handle;
}

/** Build check: the bridge's unittest suite inside Pyodide (host paths are mounted 1:1). */
async function runTests(py: Pyodide, testsDir: string): Promise<void> {
  const run = (await py.runPythonAsync(`
def _qaas_run_tests(start):
    import io, json, sys, unittest

    class Tee(io.StringIO):
        def write(self, s):
            sys.stderr.write(s)
            return super().write(s)

    out = Tee()
    suite = unittest.defaultTestLoader.discover(start)
    result = unittest.TextTestRunner(stream=out, verbosity=2).run(suite)
    return json.dumps([result.wasSuccessful(), out.getvalue()])
_qaas_run_tests`)) as PyProxy;
  try {
    const [ok, output] = JSON.parse((await run.callPromising(testsDir)) as string) as [boolean, string];
    post({ type: "tests", ok, output });
  } catch (e) {
    post({ type: "tests", ok: false, output: (e as Error).message });
  }
}

// Requests are answered one at a time, in order, like the Python process.
let queue: Promise<unknown> = Promise.resolve();
const ready = start();
ready.catch((e: Error) => post({ type: "fatal", message: e.message }));

port.on("message", (msg: ToWorker) => {
  if (msg.type !== "request") {
    return;
  }
  queue = queue.then(async () => {
    let handle: PyProxy;
    try {
      handle = await ready;
    } catch {
      return; // reported as fatal
    }
    try {
      const response = (await handle.callPromising(translate(msg.line, toWasmPath))) as string | undefined;
      if (response) {
        post({ type: "line", line: translate(response, toHostPath) });
      }
    } catch (e) {
      // handle() turns Python exceptions into error responses; this is a Pyodide failure.
      post({ type: "fatal", message: `WebAssembly runtime failed: ${(e as Error).message}` });
    }
  });
});
