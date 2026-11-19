import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import * as vscode from "vscode";
import { cfg, type Target } from "./config";
import { PRODUCTION_AAI_URL } from "./core/devEnv";
import { resolvePython } from "./python";
import { trustedLoginInstance } from "./trust";
import type { FromWorker, ToWorker, WasmWorkerData } from "./wasm/protocol";
import { currentAuthMode } from "./workflows";

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly type: string,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** Methods that need a LEXIS login. */
const AUTH_METHODS = new Set([
  "whoami",
  "accessToken",
  "backends",
  "backendInfo",
  "analyze",
  "submit",
  "jobInfo",
  "listJobs",
  "cancel",
  "download",
  "pulseInfo",
  "submitPulse",
  "downloadPulse",
]);

export type Runtime = "python" | "wasm";

/** `qaas.runtime`: a local Python with qaas, or the WebAssembly build bundled with the extension. */
export function currentRuntime(): Runtime {
  return cfg().get<string>("runtime") === "wasm" ? "wasm" : "python";
}

/** Where requests go: the Python process's stdin, or the WebAssembly worker. */
interface Transport {
  send(line: string): void;
  kill(): void;
  readonly alive: boolean;
}

/**
 * Long-running `python qaas_bridge.py serve` process, or the same bridge in Pyodide in a worker
 * thread (`qaas.runtime: wasm`). Keeps the LEXIS login and HEAppE clients alive between commands.
 * Requests are answered in order.
 */
export class Bridge implements vscode.Disposable {
  private transport?: Transport;
  private starting?: Promise<Transport>;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stdoutBuf = "";
  private stderrBuf = "";
  /** True once a login-requiring call succeeded in this process. */
  authenticated = false;
  /** True once the environment check passed for this process (Python 3.12 with qaas). */
  environmentOk = false;
  private readonly authenticatedEmitter = new vscode.EventEmitter<void>();
  /** Fires when a login-requiring call first succeeds in this bridge process. */
  readonly onDidAuthenticate = this.authenticatedEmitter.event;

  constructor(
    private readonly extensionPath: string,
    private readonly output: vscode.OutputChannel,
    /** py4lexis log file; under the extension's per-user log folder, not the shared temp dir. */
    private readonly lexisLog?: string,
  ) {}

  async request<T>(method: string, params: object = {}, token?: vscode.CancellationToken): Promise<T> {
    const transport = await this.ensure();
    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    token?.onCancellationRequested(() => {
      // The server handles one request at a time; cancelling means restarting it.
      this.output.appendLine(`[bridge] ${method} cancelled; restarting Python bridge`);
      this.restart();
    });
    transport.send(JSON.stringify({ id, method, params }));
    const value = await result;
    if (AUTH_METHODS.has(method) && !this.authenticated) {
      this.authenticated = true;
      this.authenticatedEmitter.fire();
    }
    return value;
  }

  /**
   * Request with the LEXIS target merged into the params. A browser login (no token) on a
   * non-production instance chosen by the workspace or dev file needs the user's approval first.
   */
  async call<T>(method: string, target: Target, params: object = {}, token?: vscode.CancellationToken): Promise<T> {
    if (currentAuthMode() === "workflows") {
      // Never fall back to a py4lexis login: the bridge refuses any token that is not an access token.
      if (AUTH_METHODS.has(method) && !target.token) {
        throw new BridgeError(
          "Sign in with IT4I Workflows first (setting qaas.workflowsIntegration is on).",
          "SignInRequired",
        );
      }
      return this.request<T>(method, { ...target, auth: "workflows", ...params }, token);
    }
    if (AUTH_METHODS.has(method) && !target.token && !(await trustedLoginInstance(target.instance))) {
      throw new BridgeError(
        `Login to ${target.instance?.aaiUrl ?? "this LEXIS instance"} was not allowed. Remove or fix the instance URLs in the workspace settings or dev connection file.`,
        "LoginDeclined",
      );
    }
    return this.request<T>(method, { ...target, ...params }, token);
  }

  restart(): void {
    this.transport?.kill();
    this.transport = undefined;
    this.starting = undefined;
    this.authenticated = false;
    this.environmentOk = false;
    this.failAll(new BridgeError("Python bridge restarted", "Restarted"));
  }

  dispose(): void {
    this.restart();
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private ensure(): Promise<Transport> {
    if (this.transport?.alive) {
      return Promise.resolve(this.transport);
    }
    if (!this.starting) {
      this.starting = (currentRuntime() === "wasm" ? this.startWasm() : this.startProcess()).finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  /** The transport ended: forget it and fail what is still waiting. */
  private ended(transport: Transport, err: BridgeError): void {
    if (this.transport === transport) {
      this.transport = undefined;
      this.authenticated = false;
      this.environmentOk = false;
    }
    if (this.pending.size > 0) {
      this.failAll(err);
    }
  }

  private async startProcess(): Promise<Transport> {
    const python = await resolvePython();
    const script = path.join(this.extensionPath, "python", "qaas_bridge.py");
    this.output.appendLine(`[bridge] starting ${python} ${script} serve`);
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: "1" };
    if (this.lexisLog) {
      env.QAAS_LEXIS_LOG = this.lexisLog;
    }
    const proc = spawn(python, [script, "serve"], { env });
    let failed = false;
    const transport: Transport = {
      send: (line) => proc.stdin.write(`${line}\n`),
      kill: () => proc.kill(),
      get alive() {
        return !failed && proc.exitCode === null && proc.signalCode === null;
      },
    };
    this.transport = transport;
    this.stdoutBuf = "";
    this.stderrBuf = "";

    proc.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      this.stdoutBuf += chunk;
      for (let nl = this.stdoutBuf.indexOf("\n"); nl >= 0; nl = this.stdoutBuf.indexOf("\n")) {
        const line = this.stdoutBuf.slice(0, nl).trim();
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
        if (line) {
          this.onMessage(line);
        }
      }
    });
    proc.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      this.output.append(chunk);
      this.stderrBuf = (this.stderrBuf + chunk).slice(-4000);
      this.detectLogin(chunk);
    });
    proc.on("error", (err) => {
      this.output.appendLine(`[bridge] failed to start: ${err.message}`);
      failed = true;
      this.ended(
        transport,
        new BridgeError(`Could not start Python (${python}): ${err.message}. Set "qaas.pythonPath".`, "SpawnError"),
      );
    });
    proc.on("exit", (code) => {
      const tail = this.stderrBuf.trim().split("\n").slice(-3).join(" ");
      this.ended(transport, new BridgeError(`Python bridge exited (code ${code}). ${tail}`, "Exited"));
    });
    return transport;
  }

  /** The bridge in Pyodide, in a worker thread of the extension host (no local Python). */
  private async startWasm(): Promise<Transport> {
    const bundleDir = path.join(this.extensionPath, "wasm");
    if (!existsSync(path.join(bundleDir, "manifest.json"))) {
      throw new BridgeError(
        'This build of the extension has no WebAssembly runtime (its wasm/ folder is missing; build it with "npm run wasm:build"). Set qaas.runtime to python.',
        "Environment",
      );
    }
    this.output.appendLine(`[bridge] starting the WebAssembly runtime from ${bundleDir}`);
    const workerData: WasmWorkerData = { bundleDir, pythonDir: path.join(this.extensionPath, "python") };
    const worker = new Worker(path.join(__dirname, "wasm", "worker.js"), { workerData });
    let exited = false;
    const transport: Transport = {
      send: (line) => worker.postMessage({ type: "request", line } satisfies ToWorker),
      kill: () => {
        exited = true;
        void worker.terminate();
      },
      get alive() {
        return !exited;
      },
    };
    this.transport = transport;
    let ready: () => void = () => {};
    // Loading takes about 10 s; show it in the status bar.
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "QaaS: starting the WebAssembly runtime" },
      () => new Promise<void>((resolve) => (ready = resolve)),
    );
    worker.on("message", (msg: FromWorker) => {
      switch (msg.type) {
        case "line":
          this.onMessage(msg.line);
          break;
        case "log":
          this.output.appendLine(msg.text);
          break;
        case "status":
          this.output.appendLine(`[wasm] ${msg.text}`);
          break;
        case "ready":
          this.output.appendLine(
            `[wasm] qaas ${msg.versions.qaas} on Pyodide ${msg.versions.pyodide} ready in ${msg.seconds.toFixed(1)} s`,
          );
          ready();
          break;
        case "fatal":
          this.output.appendLine(`[wasm] ${msg.message}`);
          ready();
          exited = true;
          void worker.terminate();
          this.ended(transport, new BridgeError(msg.message, "Environment"));
          break;
      }
    });
    worker.on("error", (err) => {
      this.output.appendLine(`[wasm] worker error: ${err.stack ?? err.message}`);
      ready();
      exited = true;
      this.ended(transport, new BridgeError(`WebAssembly runtime failed: ${err.message}`, "Exited"));
    });
    worker.on("exit", (code) => {
      ready();
      exited = true;
      this.ended(transport, new BridgeError(`WebAssembly runtime stopped (code ${code}).`, "Exited"));
    });
    return transport;
  }

  private onMessage(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { type: string; message: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      this.output.appendLine(`[bridge] unexpected output: ${line}`);
      return;
    }
    const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
    if (!p || msg.id === undefined) {
      return;
    }
    this.pending.delete(msg.id);
    if (msg.error) {
      p.reject(new BridgeError(msg.error.message, msg.error.type));
    } else {
      p.resolve(msg.result);
    }
  }

  /** py4lexis prints the device-login URL; offer to open it (webbrowser.open fails on remote hosts). */
  private detectLogin(chunk: string): void {
    const m = /Open provided url in your browser[^:]*:\s*(https?:\/\/\S+)/.exec(chunk);
    if (m) {
      const url = m[1];
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        // show the raw URL
      }
      const production = host === new URL(PRODUCTION_AAI_URL).host;
      vscode.window
        .showInformationMessage(
          production
            ? `QaaS: finish the LEXIS login in your browser (${host}).`
            : `QaaS: finish the LEXIS login in your browser. The login page is on ${host}, not the LEXIS production login (${new URL(PRODUCTION_AAI_URL).host}).`,
          "Open Login Page",
        )
        .then((choice) => {
          if (choice) {
            vscode.env.openExternal(vscode.Uri.parse(url));
          }
        });
    }
  }
}
