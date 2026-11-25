/** Messages between the extension host and the WebAssembly runtime worker (worker.ts). */

export interface WasmWorkerData {
  /** "bridge" (default): answer bridge requests. "script": run one user script (Run Python File). */
  mode?: "bridge" | "script";
  /** The extension's `wasm/` folder: manifest.json, wheels/, pyodide/. */
  bundleDir: string;
  /** The extension's `python/` folder with qaas_bridge.py. */
  pythonDir: string;
  /** py4lexis log file (QAAS_LEXIS_LOG), in the extension's per-user log folder. */
  lexisLog?: string;
  /** Build checks only: run the unittest suite in this folder after startup (not packaged). */
  testsDir?: string;
  /**
   * Script mode: stdin for input(). Int32 [0] = 1 when a line is ready, [1] = its byte length
   * (-1 for end of input); the UTF-8 bytes follow at byte offset 8.
   */
  input?: SharedArrayBuffer;
}

/** A job a script submitted (reported by python/qaas_script.py). */
export interface ScriptJob {
  jobId: string;
  name: string;
  tasks: number;
  shots: number | null;
  kind: "circuit" | "pulse";
}

export type ToWorker =
  /** A JSON request line, as written to the Python process's stdin. */
  | { type: "request"; line: string }
  /** Script mode: run a script like `python <file> <args>`. */
  | { type: "run"; file: string; args: string[]; env: Record<string, string>; cwd: string; figuresDir: string };

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
  /** Script mode: output of the script. */
  | { type: "output"; stream: "out" | "err"; text: string }
  /** Script mode: input() waits for a line (see WasmWorkerData.input). */
  | { type: "input" }
  /** Script mode: imports the bundle does not have; the script did not run. */
  | { type: "missing"; modules: { name: string; line: number }[] }
  /** Script mode: plt.show() saved a figure. */
  | { type: "figure"; path: string }
  /** Script mode: the script submitted a job to HEAppE. */
  | { type: "job"; job: ScriptJob }
  /** Script mode: the script ended. */
  | { type: "exit"; code: number }
  /** The runtime cannot start or broke; pending requests fail. */
  | { type: "fatal"; message: string };
