import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export const TOKEN_KEY = "qaas.lexisToken";

export function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("qaas");
}

/** Connection parameters sent with every bridge request. */
export interface Target {
  project: string;
  resource: string;
  backend: string;
  token?: string;
}

export async function currentTarget(secrets: vscode.SecretStorage): Promise<Target> {
  return {
    project: cfg().get<string>("lexisProject") ?? "",
    resource: cfg().get<string>("lexisResource") ?? "",
    backend: cfg().get<string>("backendName") || "VLQ",
    token: (await secrets.get(TOKEN_KEY)) || undefined,
  };
}

/** Ask for the LEXIS project once and save it to user settings. */
export async function requireProject(): Promise<string | undefined> {
  let project = cfg().get<string>("lexisProject");
  if (!project) {
    project = await vscode.window.showInputBox({
      title: "LEXIS project",
      prompt: "LEXIS project identifier (saved to settings)",
      ignoreFocusOut: true,
    });
    if (project) {
      await cfg().update("lexisProject", project, vscode.ConfigurationTarget.Global);
    }
  }
  return project || undefined;
}

export function sanitize(s: string): string {
  return (
    s
      .replace(/[^\w.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "job"
  );
}

/** Expand ${workspaceFolder}, ${userHome}, ${jobId}, ${jobName}, ${date} and a leading ~. */
export function expandPath(template: string, vars: Record<string, string>): string {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.join(os.homedir(), "qaas");
  const all: Record<string, string> = {
    workspaceFolder: ws,
    userHome: os.homedir(),
    date: new Date().toISOString().slice(0, 10),
    ...vars,
  };
  let out = template.replace(/\$\{(\w+)\}/g, (m, k: string) => all[k] ?? m);
  if (out === "~" || out.startsWith("~/")) {
    out = path.join(os.homedir(), out.slice(1));
  }
  return path.resolve(out);
}
