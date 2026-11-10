import * as path from "node:path";
import * as vscode from "vscode";
import { resolvePython, runBridge } from "./python";

const TOKEN_KEY = "qaas.lexisToken";

interface CheckData {
  python: string;
  executable: string;
  packages: Record<string, string | null>;
  importable: boolean;
  importError?: string;
}

interface BackendInfo {
  name: string;
  resource: string | null;
  host: string | null;
  clusterId: number | null;
  allocatedUnits: number | null;
}

let output: vscode.OutputChannel;

function config() {
  return vscode.workspace.getConfiguration("qaas");
}

async function lexisEnv(context: vscode.ExtensionContext): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    LEXIS_PROJECT: config().get<string>("lexisProject") ?? "",
    LEXIS_RESOURCE: config().get<string>("lexisResource") ?? "",
    QAAS_BACKEND: config().get<string>("backendName") || "VLQ",
  };
  const token = await context.secrets.get(TOKEN_KEY);
  if (token) {
    env.LEXIS_TOKEN = token;
  }
  return env;
}

async function requireProject(): Promise<string | undefined> {
  let project = config().get<string>("lexisProject");
  if (!project) {
    project = await vscode.window.showInputBox({
      title: "LEXIS project",
      prompt: "LEXIS project identifier (saved to settings)",
      ignoreFocusOut: true,
    });
    if (project) {
      await config().update("lexisProject", project, vscode.ConfigurationTarget.Global);
    }
  }
  return project || undefined;
}

async function checkEnvironment(context: vscode.ExtensionContext): Promise<void> {
  const res = await runBridge<CheckData>(context, ["check"]);
  if (!res.ok || !res.data) {
    output.appendLine(`Environment check failed: ${res.error}`);
    output.show(true);
    vscode.window.showErrorMessage(`QaaS: could not run Python (${res.error}). Set "qaas.pythonPath".`);
    return;
  }
  const d = res.data;
  output.appendLine(`Python ${d.python} at ${d.executable}`);
  for (const [name, ver] of Object.entries(d.packages)) {
    output.appendLine(`  ${name}: ${ver ?? "not installed"}`);
  }
  if (d.importable) {
    vscode.window.showInformationMessage(`QaaS: qaas ${d.packages.qaas} is ready (Python ${d.python}).`);
  } else {
    output.appendLine(`  import error: ${d.importError}`);
    const choice = await vscode.window.showWarningMessage(
      "QaaS: the qaas package is not importable in the selected interpreter.",
      "Install qaas",
      "Show Details",
    );
    if (choice === "Install qaas") {
      await vscode.commands.executeCommand("qaas.installPackage");
    } else if (choice === "Show Details") {
      output.show();
    }
  }
}

async function installPackage(): Promise<void> {
  const python = await resolvePython();
  const extra = config().get<string>("packageExtra") || "iqm_qiskit";
  const indexUrl = config().get<string>("packageIndexUrl");
  const terminal = vscode.window.createTerminal("QaaS install");
  terminal.show();
  const quote = (s: string) => (process.platform === "win32" ? `"${s}"` : `'${s}'`);
  terminal.sendText(
    `${quote(python)} -m pip install ${quote(`qaas[${extra}]`)}` +
      (indexUrl ? ` --extra-index-url ${quote(indexUrl)}` : ""),
  );
}

async function listBackends(context: vscode.ExtensionContext): Promise<void> {
  const project = await requireProject();
  if (!project) {
    return;
  }
  const resource = config().get<string>("lexisResource") ?? "";
  const env = await lexisEnv(context);

  const res = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "QaaS: fetching backends (a browser login may open)…",
      cancellable: true,
    },
    (_progress, token) =>
      runBridge<BackendInfo[]>(context, ["backends", "--project", project, "--resource", resource], env, token),
  );

  if (!res.ok || !res.data) {
    output.appendLine(`List backends failed: ${res.error}`);
    vscode.window.showErrorMessage(`QaaS: ${res.error}`);
    return;
  }
  if (res.data.length === 0) {
    vscode.window.showInformationMessage("QaaS: no backends available for this project.");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    res.data.map((b) => ({
      label: b.name,
      description: b.resource ?? "",
      detail: [b.host && `host ${b.host}`, typeof b.allocatedUnits === "number" && `${b.allocatedUnits} units allocated`]
        .filter(Boolean)
        .join(" · "),
      backend: b,
    })),
    { title: "Available quantum backends", placeHolder: "Select a default backend" },
  );
  if (pick) {
    await config().update("backendName", pick.backend.name, vscode.ConfigurationTarget.Global);
    if (pick.backend.resource) {
      await config().update("lexisResource", pick.backend.resource, vscode.ConfigurationTarget.Global);
    }
    vscode.window.showInformationMessage(`QaaS: default backend set to ${pick.backend.name}.`);
  }
}

async function newCircuitFile(context: vscode.ExtensionContext): Promise<void> {
  const template = vscode.Uri.file(path.join(context.extensionPath, "templates", "vlq_circuit.py"));
  const bytes = await vscode.workspace.fs.readFile(template);
  const doc = await vscode.workspace.openTextDocument({
    language: "python",
    content: Buffer.from(bytes).toString("utf8"),
  });
  await vscode.window.showTextDocument(doc);
}

async function runCurrentFile(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
  if (!doc || doc.languageId !== "python") {
    vscode.window.showWarningMessage("QaaS: open a Python file to run.");
    return;
  }
  if (doc.isUntitled) {
    const saved = await doc.save();
    if (!saved) {
      return;
    }
  } else if (doc.isDirty) {
    await doc.save();
  }
  if (!(await requireProject())) {
    return;
  }
  const python = await resolvePython();
  const terminal = vscode.window.createTerminal({ name: "QaaS run", env: await lexisEnv(context) });
  terminal.show();
  const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
  terminal.sendText(`${q(python)} ${q(doc.uri.fsPath)}`);
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("QaaS");
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("qaas.checkEnvironment", () => checkEnvironment(context)),
    vscode.commands.registerCommand("qaas.installPackage", installPackage),
    vscode.commands.registerCommand("qaas.setToken", async () => {
      const token = await vscode.window.showInputBox({
        title: "LEXIS access token",
        prompt: "Stored in VS Code secret storage. Leave unset to log in through the browser instead.",
        password: true,
        ignoreFocusOut: true,
      });
      if (token) {
        await context.secrets.store(TOKEN_KEY, token);
        vscode.window.showInformationMessage("QaaS: LEXIS token saved.");
      }
    }),
    vscode.commands.registerCommand("qaas.clearToken", async () => {
      await context.secrets.delete(TOKEN_KEY);
      vscode.window.showInformationMessage("QaaS: LEXIS token cleared.");
    }),
    vscode.commands.registerCommand("qaas.listBackends", () => listBackends(context)),
    vscode.commands.registerCommand("qaas.newCircuitFile", () => newCircuitFile(context)),
    vscode.commands.registerCommand("qaas.runCurrentFile", (uri?: vscode.Uri) => runCurrentFile(context, uri)),
  );
}

export function deactivate(): void {}
