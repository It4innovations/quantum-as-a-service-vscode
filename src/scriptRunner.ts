/**
 * Run Python File on QPU in the WebAssembly runtime: the script runs in Pyodide in its own worker
 * (src/wasm/worker.ts, script mode), with a terminal for output, input() and Ctrl+C. Imports the
 * bundle does not have are found before the run, so the user can switch to a local Python instead.
 */

import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import { offerLogin } from "./loginPrompt";
import type { FromWorker, ScriptJob, ToWorker, WasmWorkerData } from "./wasm/protocol";

/** Importable in the bundle but limited there; keep in step with LIMITED in python/qaas_script.py. */
export const LIMITED: Record<string, string> = {
  qiskit_aer:
    "Qiskit Aer is not in the WebAssembly runtime (AerSimulator raises). Use qiskit.primitives.StatevectorSampler or qiskit.quantum_info.Statevector.",
  multiprocessing: "The WebAssembly runtime cannot start processes; process pools fail.",
  subprocess: "The WebAssembly runtime cannot start processes.",
  threading: "The WebAssembly runtime has no threads; starting a thread fails.",
  concurrent:
    "The WebAssembly runtime has no threads: ThreadPoolExecutor runs tasks one after another, ProcessPoolExecutor fails.",
};

/** Packages shown first in the library overview, by topic. */
const HIGHLIGHTS: [string, string[]][] = [
  [
    "LEXIS and the QPU",
    ["qaas", "py4lexis", "py4heappe", "iqm-client", "iqm-pulla", "iqm-pulse", "iqm-station-control-client"],
  ],
  ["Circuits", ["qiskit", "qiskit-qasm3-import", "openqasm3", "rustworkx"]],
  ["Numerics and data", ["numpy", "scipy", "pandas", "xarray", "matplotlib"]],
  ["Utilities", ["requests", "pydantic", "pyyaml", "rich", "tqdm"]],
];

interface Manifest {
  qaas_version: string;
  pyodide_version: string;
  python_version?: string;
  modules?: string[];
  stdlib?: string[];
  packages?: Record<string, string>;
}

let cachedManifest: { dir: string; manifest: Manifest } | undefined;

export function bundleManifest(extensionPath: string): Manifest | undefined {
  const dir = path.join(extensionPath, "wasm");
  if (cachedManifest?.dir !== dir) {
    try {
      cachedManifest = { dir, manifest: JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) };
    } catch {
      return undefined;
    }
  }
  return cachedManifest.manifest;
}

export interface ImportProblem {
  name: string;
  /** 0-based. */
  line: number;
  reason?: string;
}

/**
 * Top-level imports of a script, without relative imports and imports inside `try:` blocks. A
 * line-based reading of the source: quick enough to run as the user types.
 */
export function scriptImports(source: string): { name: string; line: number }[] {
  const lines = source.split(/\r?\n/);
  const found = new Map<string, number>();
  const indent = (s: string) => s.length - s.trimStart().length;
  const insideTry = (i: number) => {
    const own = indent(lines[i]);
    for (let j = i - 1; j >= 0; j--) {
      const t = lines[j].trim();
      if (!t || t.startsWith("#")) {
        continue;
      }
      if (indent(lines[j]) < own) {
        return /^try\s*:/.test(t);
      }
    }
    return false;
  };
  lines.forEach((text, i) => {
    const t = text.trim();
    let names: string[] = [];
    const imp = /^import\s+(.+)$/.exec(t);
    const from = /^from\s+([A-Za-z_][\w.]*)\s+import\b/.exec(t);
    if (imp) {
      names = imp[1]
        .split("#")[0]
        .split(",")
        .map((n) => n.trim().split(/\s+/)[0]);
    } else if (from) {
      names = [from[1]];
    }
    if (names.length === 0 || insideTry(i)) {
      return;
    }
    for (const n of names) {
      const top = n.split(".")[0];
      if (/^[A-Za-z_]\w*$/.test(top) && !found.has(top)) {
        found.set(top, i);
      }
    }
  });
  return [...found].map(([name, line]) => ({ name, line }));
}

/** Imports the bundle lacks (`missing`) or supports only partly (`limited`). */
export function checkImports(
  source: string,
  scriptDir: string,
  manifest: Manifest,
): { missing: ImportProblem[]; limited: ImportProblem[] } {
  const known = new Set([...(manifest.modules ?? []), ...(manifest.stdlib ?? []), "__future__"]);
  const local = (name: string) =>
    existsSync(path.join(scriptDir, `${name}.py`)) || existsSync(path.join(scriptDir, name));
  const missing: ImportProblem[] = [];
  const limited: ImportProblem[] = [];
  for (const imp of scriptImports(source)) {
    if (LIMITED[imp.name]) {
      limited.push({ ...imp, reason: LIMITED[imp.name] });
    } else if (!known.has(imp.name) && !local(imp.name)) {
      missing.push(imp);
    }
  }
  return { missing, limited };
}

/** A script meant for a QPU: it uses qaas, qiskit, IQM or LEXIS (the editor hints only there). */
export function isQaasScript(source: string): boolean {
  return scriptImports(source).some((i) =>
    ["qheappe_client", "qaas", "qiskit", "iqm", "py4lexis", "py4heappe"].includes(i.name),
  );
}

// ---------------------------------------------------------------------------------- overview

export const LIBRARIES_SCHEME = "qaas-libraries";

/** Markdown overview of the bundled libraries, with tips for scripts. */
export function librariesMarkdown(manifest: Manifest): string {
  const packages = manifest.packages ?? {};
  const shown = new Set<string>();
  const row = (name: string) => {
    shown.add(name);
    return `| \`${name}\` | ${packages[name]} |`;
  };
  const sections = HIGHLIGHTS.map(([title, names]) => {
    const rows = names.filter((n) => packages[n]).map(row);
    return rows.length ? `### ${title}\n\n| Package | Version |\n| --- | --- |\n${rows.join("\n")}\n` : "";
  }).join("\n");
  const others = Object.keys(packages)
    .filter((n) => !shown.has(n))
    .sort();
  return `# Python libraries in the WebAssembly runtime

\`Run Python File on QPU\` runs scripts in the WebAssembly runtime bundled with QaaS: Python ${
    manifest.python_version ?? "3.13"
  } on Pyodide ${manifest.pyodide_version}, with qaas ${manifest.qaas_version}. No local Python is needed.
A script that imports something not listed here can run with your local Python instead: QaaS offers it
before the run, or set \`qaas.runtime\` to \`python\`.

${sections}
## Tips

- **Connect to the QPU** of your LEXIS project's resource with \`from qheappe_client.qprovider import QProvider\`. The script gets
  \`LEXIS_PROJECT\`, \`LEXIS_RESOURCE\`, \`QAAS_BACKEND\` and \`LEXIS_TOKEN\` (a short-lived access token)
  as environment variables; see \`templates/qpu_circuit.py\`.
- **Simulate locally** with \`qiskit.primitives.StatevectorSampler\` or \`qiskit.quantum_info.Statevector\`.
  Qiskit Aer is not available.
- **Plots**: \`plt.show()\` saves the figures as PNG files and opens them in VS Code;
  \`qiskit.visualization.plot_histogram\` works the same way.
- **input()** reads a line typed in the run terminal; **Ctrl+C** stops the script.
- **Files**: paths are relative to the workspace folder, as in a terminal; results can be written anywhere
  you can write.
- **Not available**: threads, subprocesses and process pools; packages that are not listed here.
  qiskit runs single-threaded, so large transpilations take longer.

## All packages

${others.map((n) => `\`${n}\` ${packages[n]}`).join(" · ")}
`;
}

// ------------------------------------------------------------------------------------- runner

const INPUT_BYTES = 64 * 1024;
const SPARE_IDLE_MS = 5 * 60 * 1000;

interface Started {
  worker: Worker;
  input: SharedArrayBuffer;
  ready: Promise<void>;
  /** Messages that arrived before the terminal took the worker over. */
  early: FromWorker[];
  loaded: boolean;
}

export interface RunOptions {
  file: string;
  env: Record<string, string>;
  cwd: string;
  /** The script imports something the bundle does not have; it did not run. */
  onMissing: (modules: { name: string; line: number }[]) => void;
  /** The script submitted a job (circuit or pulse-level). */
  onJob?: (job: ScriptJob) => void;
  /** The script ended: exit code, and how ("exited", "stopped", "not run", "failed"). */
  onExit?: (code: number, how: string) => void;
}

/** Workers in script mode: one per run, plus one loaded ahead so a run starts at once. */
export class ScriptRunner implements vscode.Disposable {
  private spare?: Started;
  private spareTimer?: NodeJS.Timeout;
  private readonly running = new Set<Worker>();

  constructor(
    private readonly extensionPath: string,
    private readonly output: vscode.OutputChannel,
  ) {}

  /** Load a worker in the background for the next run. */
  prewarm(): void {
    if (!this.spare) {
      this.spare = this.startWorker();
    }
    clearTimeout(this.spareTimer);
    this.spareTimer = setTimeout(() => this.dropSpare(), SPARE_IDLE_MS);
  }

  dispose(): void {
    this.dropSpare();
    for (const w of this.running) {
      void w.terminate();
    }
  }

  private dropSpare(): void {
    clearTimeout(this.spareTimer);
    void this.spare?.worker.terminate();
    this.spare = undefined;
  }

  private startWorker(): Started {
    const input = new SharedArrayBuffer(8 + INPUT_BYTES);
    const workerData: WasmWorkerData = {
      mode: "script",
      bundleDir: path.join(this.extensionPath, "wasm"),
      pythonDir: path.join(this.extensionPath, "python"),
      input,
    };
    const worker = new Worker(path.join(__dirname, "wasm", "worker.js"), { workerData });
    const started: Started = { worker, input, ready: Promise.resolve(), early: [], loaded: false };
    started.ready = new Promise<void>((resolve, reject) => {
      const onMessage = (msg: FromWorker) => {
        if (msg.type === "ready") {
          worker.off("message", onMessage);
          started.loaded = true;
          resolve();
        } else if (msg.type === "fatal") {
          reject(new Error(msg.message));
        } else {
          started.early.push(msg);
        }
      };
      worker.on("message", onMessage);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`WebAssembly runtime stopped (code ${code}).`)));
    });
    started.ready.catch((e: Error) => this.output.appendLine(`[run] WebAssembly runtime did not start: ${e.message}`));
    return started;
  }

  /** Run the script in a new terminal. Resolves once the terminal is open. */
  async run(opts: RunOptions): Promise<void> {
    const started = this.spare ?? this.startWorker();
    this.spare = undefined;
    clearTimeout(this.spareTimer);
    const manifest = bundleManifest(this.extensionPath);
    const name = path.basename(opts.file);
    const writer = new vscode.EventEmitter<string>();
    const closer = new vscode.EventEmitter<number | undefined>();
    const out = (text: string) => writer.fire(text.replace(/\r?\n/g, "\r\n"));
    let line = "";
    let waiting = false;
    let finished = false;
    const typedAhead: (string | null)[] = [];
    const control = new Int32Array(started.input, 0, 2);
    const bytes = new Uint8Array(started.input, 8);

    const deliver = (text: string | null) => {
      if (text === null) {
        Atomics.store(control, 1, -1);
      } else {
        const encoded = new TextEncoder().encode(text).slice(0, INPUT_BYTES);
        bytes.set(encoded);
        Atomics.store(control, 1, encoded.length);
      }
      waiting = false;
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
    };
    const finish = (code: number, note?: string) => {
      if (finished) {
        return;
      }
      finished = true;
      this.running.delete(started.worker);
      void started.worker.terminate();
      out(`\n\x1b[2m${note ?? `[${name} exited with code ${code}]`}\x1b[0m\n`);
      opts.onExit?.(code, note ? note.replace(/^\[|\]$/g, "") : "exited");
      this.prewarm();
    };
    const onMessage = (msg: FromWorker) => {
      switch (msg.type) {
        case "output":
          out(msg.stream === "err" ? `\x1b[31m${msg.text}\x1b[0m` : msg.text);
          offerLogin(msg.text); // a script that signs in with py4lexis itself
          break;
        case "input":
          waiting = true;
          if (typedAhead.length) {
            deliver(typedAhead.shift() ?? null);
          }
          break;
        case "job":
          opts.onJob?.(msg.job);
          break;
        case "figure":
          void vscode.commands.executeCommand("vscode.open", vscode.Uri.file(msg.path), {
            viewColumn: vscode.ViewColumn.Beside,
            preserveFocus: true,
          });
          break;
        case "missing":
          out(
            `\x1b[33mNot run: ${msg.modules.map((m) => `${m.name} (line ${m.line})`).join(", ")} ${
              msg.modules.length > 1 ? "are" : "is"
            } not in the WebAssembly runtime.\x1b[0m\n`,
          );
          finish(1, "[not run]");
          opts.onMissing(msg.modules);
          break;
        case "exit":
          finish(msg.code);
          break;
        case "fatal":
          out(`\x1b[31m${msg.message}\x1b[0m\n`);
          finish(1);
          break;
        case "log":
        case "status":
          this.output.appendLine(`[run] ${"text" in msg ? msg.text : ""}`);
          break;
      }
    };

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writer.event,
      onDidClose: closer.event,
      open: () => {
        out(
          `\x1b[2mQaaS: ${name} in the WebAssembly runtime (qaas ${manifest?.qaas_version ?? "?"}, Python ${
            manifest?.python_version ?? "?"
          }). Ctrl+C stops it. Libraries: "QaaS: Show Bundled Python Libraries".\x1b[0m\n`,
        );
        void started.ready.then(
          () => {
            if (finished) {
              return;
            }
            for (const msg of started.early) {
              onMessage(msg);
            }
            started.worker.on("message", onMessage);
            started.worker.once("exit", () => finish(1, "[stopped]"));
            started.worker.postMessage({
              type: "run",
              file: opts.file,
              args: [],
              env: opts.env,
              cwd: opts.cwd,
              figuresDir: path.join(os.tmpdir(), "qaas-figures", `${Date.now()}`),
            } satisfies ToWorker);
          },
          (e: Error) => {
            out(`\x1b[31mThe WebAssembly runtime did not start: ${e.message}\x1b[0m\n`);
            finish(1);
          },
        );
        if (!started.loaded) {
          out("\x1b[2mLoading the runtime (about 10 s)...\x1b[0m\n");
        }
      },
      close: () => {
        if (!finished) {
          finish(130, "[stopped]");
        }
      },
      handleInput: (data) => {
        if (finished) {
          closer.fire(undefined);
          return;
        }
        for (const ch of data) {
          if (ch === "\x03") {
            out("^C\n");
            finish(130, "[stopped with Ctrl+C]");
            return;
          }
          if (ch === "\r") {
            out("\n");
            const text = `${line}\n`;
            line = "";
            waiting ? deliver(text) : typedAhead.push(text);
          } else if (ch === "\x04" && line === "") {
            waiting ? deliver(null) : typedAhead.push(null);
          } else if (ch === "\x7f") {
            if (line) {
              line = line.slice(0, -1);
              writer.fire("\b \b");
            }
          } else if (ch >= " ") {
            line += ch;
            writer.fire(ch);
          }
        }
      },
    };
    this.running.add(started.worker);
    const terminal = vscode.window.createTerminal({ name: `QaaS run: ${name}`, pty });
    terminal.show();
  }
}
