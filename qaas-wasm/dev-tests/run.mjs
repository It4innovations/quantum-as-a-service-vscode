// Run a Python file inside Pyodide in Node (development aid; the build's checks are in ../smoke-test.mjs).
//
//   node qaas-wasm/dev-tests/run.mjs qaas-wasm/dev-tests/t_transport.py wasm/wheels/*.whl
//   MOUNT=<host dir>:<dir in Pyodide>[,...] node qaas-wasm/dev-tests/run.mjs t_pytest.py wasm/wheels/*.whl
//
// The wheels are copied to /wheels. Pyodide comes from PYODIDE_DIR, default the extension's bundle
// (wasm/pyodide/). Node 24+ for JSPI. Behind a TLS-intercepting proxy, set NODE_EXTRA_CA_CERTS.
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const indexURL = `${resolve(process.env.PYODIDE_DIR ?? join(repo, "wasm", "pyodide"))}/`;
const { loadPyodide } = await import(pathToFileURL(join(indexURL, "pyodide.mjs")).href);

const [script, ...wheels] = process.argv.slice(2);
const py = await loadPyodide({ indexURL });
py.FS.mkdirTree("/wheels");
for (const m of (process.env.MOUNT ?? "").split(",").filter(Boolean)) {
  const [src, dst] = m.split(":");
  py.FS.mkdirTree(dst);
  py.FS.mount(py.FS.filesystems.NODEFS, { root: src }, dst);
}
for (const w of wheels) {
  py.FS.writeFile(`/wheels/${basename(w)}`, readFileSync(w));
}
await py.loadPackage("micropip");
try {
  await py.runPythonAsync(readFileSync(script, "utf8"));
} catch (e) {
  console.error(String(e).split("\n").slice(-25).join("\n"));
  process.exit(1);
}
