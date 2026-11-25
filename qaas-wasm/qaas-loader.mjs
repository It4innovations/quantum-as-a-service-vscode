// qaas (IT4I Quantum-as-a-Service) for the browser via Pyodide (WebAssembly).
//
//   import { loadQaas } from "./qaas-loader.mjs";
//   const pyodide = await loadQaas({ onStatus: console.log });
//   await pyodide.runPythonAsync(`from qheappe_client import QProvider ...`);
//
// Options:
//   bundleURL  the bundle built by build.py (manifest.json, wheels/, pyodide/); default: ../wasm/
//   indexURL   Pyodide distribution URL; default: the bundle's pyodide/ folder
//   onStatus   progress callback (string)
//   pyodide    an already loaded Pyodide instance of the bundle's version (optional)

export async function loadQaas(opts = {}) {
  const bundleURL = new URL(opts.bundleURL ?? "../wasm/", import.meta.url).href;
  const indexURL = opts.indexURL ?? new URL("pyodide/", bundleURL).href;
  const status = opts.onStatus ?? (() => {});

  const manifest = await (await fetch(new URL("manifest.json", bundleURL))).json();

  let pyodide = opts.pyodide;
  if (!pyodide) {
    status(`Loading Pyodide ${manifest.pyodide_version} ...`);
    const { loadPyodide } = await import(`${indexURL}pyodide.mjs`);
    pyodide = await loadPyodide({ indexURL });
  }

  status("Loading native packages (numpy, scipy, rustworkx, cryptography, ...) ...");
  await pyodide.loadPackage(["micropip", ...manifest.pyodide_packages], {
    messageCallback: () => {},
  });

  status(`Installing ${manifest.wheels.length} wheels (qiskit wasm, qaas, IQM stack) ...`);
  pyodide.globals.set("_qaas_manifest_json", JSON.stringify(manifest));
  pyodide.globals.set("_qaas_bundle_url", bundleURL);
  pyodide.qaasManifest = manifest;
  await pyodide.runPythonAsync(`
import json, micropip
_m = json.loads(_qaas_manifest_json)
for _name, _ver in _m["mock_packages"].items():
    micropip.add_mock_package(_name, _ver)
await micropip.install([f"{_qaas_bundle_url}wheels/{w}" for w in _m["wheels"]], deps=False)
import qaas_pyodide
qaas_pyodide.install()
del _m, _name, _ver, _qaas_manifest_json, _qaas_bundle_url
`);
  status("qaas ready");
  return pyodide;
}
