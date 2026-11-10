import { execFile } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";

/** Resolve the interpreter: qaas.pythonPath, then the Python extension's selection, then python3. */
export async function resolvePython(): Promise<string> {
  const configured = vscode.workspace.getConfiguration("qaas").get<string>("pythonPath");
  if (configured) {
    return configured;
  }
  const pyExt = vscode.extensions.getExtension("ms-python.python");
  if (pyExt) {
    try {
      const api = pyExt.isActive ? pyExt.exports : await pyExt.activate();
      const env = api?.environments?.getActiveEnvironmentPath?.(vscode.workspace.workspaceFolders?.[0]?.uri);
      const resolved = env && (await api.environments.resolveEnvironment(env));
      const exe: string | undefined = resolved?.executable?.uri?.fsPath;
      if (exe) {
        return exe;
      }
    } catch {
      // fall through to default
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

export interface BridgeResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Run python/qaas_bridge.py and parse the JSON object on its last stdout line. */
export async function runBridge<T>(
  context: vscode.ExtensionContext,
  args: string[],
  env: Record<string, string> = {},
  token?: vscode.CancellationToken,
): Promise<BridgeResult<T>> {
  const python = await resolvePython();
  const script = path.join(context.extensionPath, "python", "qaas_bridge.py");

  return new Promise((resolve) => {
    const child = execFile(
      python,
      [script, ...args],
      { env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const lastLine = stdout.trim().split("\n").pop() ?? "";
        try {
          resolve(JSON.parse(lastLine) as BridgeResult<T>);
        } catch {
          resolve({ ok: false, error: (stderr || err?.message || "No output from Python bridge").trim() });
        }
      },
    );
    token?.onCancellationRequested(() => child.kill());
  });
}
