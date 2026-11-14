import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Target } from "./config";
import { PRODUCTION_AAI_URL } from "./core/devEnv";
import { resolvePython } from "./python";
import { trustedLoginInstance } from "./trust";

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

/**
 * Long-running `python qaas_bridge.py serve` process. Keeps the LEXIS login and HEAppE
 * clients alive between commands. Requests are answered in order.
 */
export class Bridge implements vscode.Disposable {
  private proc?: ChildProcessWithoutNullStreams;
  private starting?: Promise<ChildProcessWithoutNullStreams>;
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
    const proc = await this.ensure();
    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    token?.onCancellationRequested(() => {
      // The server handles one request at a time; cancelling means restarting it.
      this.output.appendLine(`[bridge] ${method} cancelled; restarting Python bridge`);
      this.restart();
    });
    proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
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
    if (AUTH_METHODS.has(method) && !target.token && !(await trustedLoginInstance(target.instance))) {
      throw new BridgeError(
        `Login to ${target.instance?.aaiUrl ?? "this LEXIS instance"} was not allowed. Remove or fix the instance URLs in the workspace settings or dev connection file.`,
        "LoginDeclined",
      );
    }
    return this.request<T>(method, { ...target, ...params }, token);
  }

  restart(): void {
    this.proc?.kill();
    this.proc = undefined;
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

  private ensure(): Promise<ChildProcessWithoutNullStreams> {
    if (this.proc && this.proc.exitCode === null) {
      return Promise.resolve(this.proc);
    }
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private async start(): Promise<ChildProcessWithoutNullStreams> {
    const python = await resolvePython();
    const script = path.join(this.extensionPath, "python", "qaas_bridge.py");
    this.output.appendLine(`[bridge] starting ${python} ${script} serve`);
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: "1" };
    if (this.lexisLog) {
      env.QAAS_LEXIS_LOG = this.lexisLog;
    }
    const proc = spawn(python, [script, "serve"], { env });
    this.proc = proc;
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
      this.failAll(
        new BridgeError(`Could not start Python (${python}): ${err.message}. Set "qaas.pythonPath".`, "SpawnError"),
      );
    });
    proc.on("exit", (code) => {
      if (this.proc === proc) {
        this.proc = undefined;
        this.authenticated = false;
        this.environmentOk = false;
      }
      if (this.pending.size > 0) {
        const tail = this.stderrBuf.trim().split("\n").slice(-3).join(" ");
        this.failAll(new BridgeError(`Python bridge exited (code ${code}). ${tail}`, "Exited"));
      }
    });
    return proc;
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
