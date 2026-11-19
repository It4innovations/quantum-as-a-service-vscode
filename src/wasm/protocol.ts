/** Messages between the extension host and the WebAssembly runtime worker (worker.ts). */

export interface WasmWorkerData {
  /** The extension's `wasm/` folder: manifest.json, wheels/, pyodide/. */
  bundleDir: string;
  /** The extension's `python/` folder with qaas_bridge.py. */
  pythonDir: string;
  /** Build checks only: run the unittest suite in this folder after startup (not packaged). */
  testsDir?: string;
}

/** A JSON request line, as written to the Python process's stdin. */
export type ToWorker = { type: "request"; line: string };

export type FromWorker =
  /** Startup progress. */
  | { type: "status"; text: string }
  | { type: "ready"; seconds: number; versions: { qaas: string; pyodide: string } }
  /** A JSON response line, as read from the Python process's stdout. */
  | { type: "line"; line: string }
  /** Library output (Python stdout and stderr). */
  | { type: "log"; text: string }
  /** Result of `testsDir` (unittest output). */
  | { type: "tests"; ok: boolean; output: string }
  /** The runtime cannot start or broke; pending requests fail. */
  | { type: "fatal"; message: string };
