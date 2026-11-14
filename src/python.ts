import * as vscode from "vscode";
import { trustedInterpreter, trustedSetting } from "./trust";

/**
 * Resolve the interpreter: qaas.pythonPath (a workspace value only once approved), then the
 * Python extension's selection (one inside the workspace only once approved), then python3.
 */
export async function resolvePython(): Promise<string> {
  const configured = await trustedSetting("pythonPath");
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
      if (exe && (await trustedInterpreter(exe))) {
        return exe;
      }
    } catch {
      // fall through to default
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}
