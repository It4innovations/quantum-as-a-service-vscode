import * as path from "node:path";
import * as vscode from "vscode";
import { Bridge } from "./bridge";
import { cfg, currentTarget, requireProject, TOKEN_KEY } from "./config";
import { estimate, formatRange, formatSeconds } from "./core/estimate";
import { createEnvironment, installQaas, selectInterpreter } from "./environments";
import { detectCalls, EstimateCodeLensProvider, PYTHON_SELECTOR, QASM_SELECTOR } from "./estimateLens";
import { type EstimatorPreset, EstimatorViewProvider } from "./estimatorView";
import { JobManager, type JobRecord, JobStore, JobsTreeProvider, TERMINAL } from "./jobs";
import { resolvePython } from "./python";
import { QasmCommands, TRANSPILED_SCHEME, TranspiledContentProvider } from "./qasm";

interface CheckData {
  python: string;
  executable: string;
  packages: Record<string, string | null>;
  importable: boolean;
  importError?: string;
  qaasOutdated: boolean;
}

interface BackendInfo {
  name: string;
  resource: string | null;
  host: string | null;
  clusterId: number | null;
  allocatedUnits: number | null;
}

let output: vscode.OutputChannel;

async function checkEnvironment(bridge: Bridge): Promise<void> {
  let d: CheckData;
  try {
    d = await bridge.request<CheckData>("check");
  } catch (e) {
    output.appendLine(`Environment check failed: ${(e as Error).message}`);
    const c = await vscode.window.showErrorMessage(
      `QaaS: could not run Python (${(e as Error).message}).`,
      "Select Interpreter",
    );
    if (c) {
      await vscode.commands.executeCommand("qaas.selectInterpreter");
    }
    return;
  }
  output.appendLine(`Python ${d.python} at ${d.executable}`);
  for (const [name, ver] of Object.entries(d.packages)) {
    output.appendLine(`  ${name}: ${ver ?? "not installed"}`);
  }
  if (d.importable && !d.qaasOutdated) {
    vscode.window.showInformationMessage(`QaaS: qaas ${d.packages.qaas} is ready (Python ${d.python}).`);
    return;
  }
  if (d.importError) {
    output.appendLine(`  import error: ${d.importError}`);
  }
  const msg = d.importable
    ? `QaaS: qaas ${d.packages.qaas} is older than 1.0.0.`
    : `QaaS: qaas is not usable in ${d.executable} (${d.importError}).`;
  const choice = await vscode.window.showWarningMessage(
    msg,
    d.importable ? "Upgrade qaas" : "Install qaas",
    "Select Interpreter",
  );
  if (choice === "Select Interpreter") {
    await selectInterpreter();
  } else if (choice) {
    await installQaas(d.executable);
  }
}

async function listBackends(context: vscode.ExtensionContext, bridge: Bridge): Promise<void> {
  if (!(await requireProject())) {
    return;
  }
  const target = await currentTarget(context.secrets);
  let backends: BackendInfo[];
  try {
    backends = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "QaaS: fetching backends (a browser login may open)…",
        cancellable: true,
      },
      (_p, token) => bridge.call<BackendInfo[]>("backends", target, {}, token),
    );
  } catch (e) {
    vscode.window.showErrorMessage(`QaaS: ${(e as Error).message}`);
    return;
  }
  if (backends.length === 0) {
    vscode.window.showInformationMessage("QaaS: no backends available for this project.");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    backends.map((b) => ({
      label: b.name,
      description: b.resource ?? "",
      detail: [
        b.host && `host ${b.host}`,
        typeof b.allocatedUnits === "number" && `${b.allocatedUnits} units allocated`,
      ]
        .filter(Boolean)
        .join(" · "),
      backend: b,
    })),
    { title: "Available quantum backends", placeHolder: "Select a default backend" },
  );
  if (pick) {
    await cfg().update("backendName", pick.backend.name, vscode.ConfigurationTarget.Global);
    if (pick.backend.resource) {
      await cfg().update("lexisResource", pick.backend.resource, vscode.ConfigurationTarget.Global);
    }
    vscode.window.showInformationMessage(`QaaS: default backend set to ${pick.backend.name}.`);
  }
}

async function newFromTemplate(context: vscode.ExtensionContext, file: string, language: string): Promise<void> {
  const bytes = await vscode.workspace.fs.readFile(
    vscode.Uri.file(path.join(context.extensionPath, "templates", file)),
  );
  const doc = await vscode.workspace.openTextDocument({ language, content: Buffer.from(bytes).toString("utf8") });
  await vscode.window.showTextDocument(doc);
}

/** Run a Python file in a terminal with LEXIS settings in the environment; confirm with the cost estimate. */
async function runPythonFile(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
  if (!doc || doc.languageId !== "python") {
    vscode.window.showWarningMessage("QaaS: open a Python file to run.");
    return;
  }
  if ((doc.isUntitled && !(await doc.save())) || (doc.isDirty && !(await doc.save()))) {
    return;
  }
  if (!(await requireProject())) {
    return;
  }
  const calls = detectCalls(doc);
  if (calls.length > 0 && cfg().get<boolean>("confirmSubmit", true)) {
    const total = calls.reduce((a, c) => a + c.high, 0);
    const lines = calls.map(
      (c) => `line ${c.line + 1}: ${formatRange(estimate({ shots: c.shots, circuits: c.circuits ?? 1 }))}`,
    );
    const unknown = calls.some((c) => c.circuits === undefined)
      ? "\nSome circuit counts are unknown; those are estimated per circuit."
      : "";
    const ok = await vscode.window.showInformationMessage(
      `Run ${path.basename(doc.fileName)} on VLQ?`,
      {
        modal: true,
        detail: `Estimated billed QPU time: up to ${formatSeconds(total)}\n${lines.join("\n")}${unknown}`,
      },
      "Run",
    );
    if (ok !== "Run") {
      return;
    }
  }
  const t = await currentTarget(context.secrets);
  const env: Record<string, string> = { LEXIS_PROJECT: t.project, LEXIS_RESOURCE: t.resource, QAAS_BACKEND: t.backend };
  if (t.token) {
    env.LEXIS_TOKEN = t.token;
  }
  const terminal = vscode.window.createTerminal({ name: "QaaS run", env });
  terminal.show();
  const python = await resolvePython();
  const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
  terminal.sendText(`${process.platform === "win32" ? "& " : ""}${q(python)} ${q(doc.uri.fsPath)}`);
  vscode.window
    .showInformationMessage(
      "QaaS: jobs submitted by the script appear in the Jobs view after an import.",
      "Import Jobs",
    )
    .then((c) => c && vscode.commands.executeCommand("qaas.jobs.import"));
}

function updateStatusBar(item: vscode.StatusBarItem): void {
  const project = cfg().get<string>("lexisProject");
  item.text = `$(pulse) ${cfg().get<string>("backendName") || "VLQ"}`;
  item.tooltip = project
    ? `QaaS: project ${project}. Click to choose a backend.`
    : "QaaS: no LEXIS project set. Click to choose a backend.";
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("QaaS");
  const bridge = new Bridge(context.extensionPath, output);
  const store = new JobStore(context.globalState);
  const jobs = new JobManager(store, bridge, context.secrets, output);
  const tree = new JobsTreeProvider(store);
  const lens = new EstimateCodeLensProvider();
  const estimator = new EstimatorViewProvider();
  const transpiled = new TranspiledContentProvider();
  const qasm = new QasmCommands(bridge, jobs, context.secrets, transpiled, output);

  const jobsView = vscode.window.createTreeView("qaas.jobs", {
    treeDataProvider: tree,
    canSelectMany: true,
    showCollapseAll: false,
  });
  const updateBadge = () => {
    const active = store.all().filter((r) => !TERMINAL.has(r.state)).length;
    jobsView.badge = active ? { value: active, tooltip: `${active} active job${active === 1 ? "" : "s"}` } : undefined;
  };
  store.onDidChange(updateBadge);
  updateBadge();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "qaas.listBackends";
  updateStatusBar(status);
  status.show();

  /** Tree commands get (clicked, selection); fall back to the clicked item. */
  const sel = (item?: JobRecord, items?: JobRecord[]): JobRecord[] =>
    items && items.length > 0 ? items : item ? [item] : [...jobsView.selection];

  context.subscriptions.push(
    output,
    bridge,
    jobs,
    jobsView,
    estimator,
    status,
    vscode.window.registerWebviewViewProvider(EstimatorViewProvider.viewId, estimator),
    vscode.languages.registerCodeLensProvider(
      [...(PYTHON_SELECTOR as vscode.DocumentFilter[]), ...(QASM_SELECTOR as vscode.DocumentFilter[])],
      lens,
    ),
    vscode.workspace.registerTextDocumentContentProvider(TRANSPILED_SCHEME, transpiled),
    ...qasm.register(),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("qaas.pythonPath")) {
        bridge.restart();
      }
      if (e.affectsConfiguration("qaas.jobPollSeconds")) {
        jobs.schedule();
      }
      if (e.affectsConfiguration("qaas")) {
        lens.refresh();
        updateStatusBar(status);
      }
    }),

    // environment
    vscode.commands.registerCommand("qaas.checkEnvironment", () => checkEnvironment(bridge)),
    vscode.commands.registerCommand("qaas.installPackage", () => installQaas()),
    vscode.commands.registerCommand("qaas.selectInterpreter", () => selectInterpreter()),
    vscode.commands.registerCommand("qaas.createEnvironment", () => createEnvironment()),
    vscode.commands.registerCommand("qaas.restartBridge", () => bridge.restart()),
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
      bridge.restart();
      vscode.window.showInformationMessage("QaaS: LEXIS token cleared and session closed.");
    }),
    vscode.commands.registerCommand("qaas.listBackends", () => listBackends(context, bridge)),

    // circuits
    vscode.commands.registerCommand("qaas.newCircuitFile", () => newFromTemplate(context, "vlq_circuit.py", "python")),
    vscode.commands.registerCommand("qaas.newQasmFile", () => newFromTemplate(context, "bell.qasm", "openqasm")),
    vscode.commands.registerCommand("qaas.runCurrentFile", (uri?: vscode.Uri) => runPythonFile(context, uri)),
    vscode.commands.registerCommand("qaas.runQasm", (uri?: vscode.Uri, uris?: vscode.Uri[]) => qasm.run(uri, uris)),
    vscode.commands.registerCommand("qaas.transpileQasm", (uri?: vscode.Uri) => qasm.transpile(uri)),
    vscode.commands.registerCommand("qaas.openEstimator", (preset?: EstimatorPreset) => estimator.open(preset)),

    // jobs
    vscode.commands.registerCommand("qaas.jobs.refresh", () => jobs.poll(true)),
    vscode.commands.registerCommand("qaas.jobs.import", () => jobs.importFromHeappe()),
    vscode.commands.registerCommand("qaas.jobs.showResults", (r: JobRecord) => jobs.showResults(r)),
    vscode.commands.registerCommand("qaas.jobs.download", async (r?: JobRecord, rs?: JobRecord[]) => {
      for (const job of sel(r, rs).filter((j) => j.state === "FINISHED")) {
        await jobs.download(job);
      }
    }),
    vscode.commands.registerCommand("qaas.jobs.downloadTo", (r?: JobRecord, rs?: JobRecord[]) =>
      jobs.downloadTo(sel(r, rs).filter((j) => j.state === "FINISHED")),
    ),
    vscode.commands.registerCommand("qaas.jobs.openFolder", (r: JobRecord) => {
      if (r.downloadedTo) {
        void vscode.commands.executeCommand(
          "revealFileInOS",
          vscode.Uri.file(path.join(r.downloadedTo, "counts.json")),
        );
      }
    }),
    vscode.commands.registerCommand("qaas.jobs.openDataWrangler", (r: JobRecord) => jobs.analysis.openDataWrangler(r)),
    vscode.commands.registerCommand("qaas.jobs.openNotebook", (r: JobRecord) => jobs.analysis.openNotebook(r)),
    vscode.commands.registerCommand("qaas.jobs.cancel", (r: JobRecord) => jobs.cancel(r)),
    vscode.commands.registerCommand("qaas.jobs.copyId", (r: JobRecord) => vscode.env.clipboard.writeText(r.jobId)),
    vscode.commands.registerCommand("qaas.jobs.remove", async (r?: JobRecord, rs?: JobRecord[]) => {
      const list = sel(r, rs);
      const ok = await vscode.window.showWarningMessage(
        `Remove ${list.length} job${list.length === 1 ? "" : "s"} from the list? Jobs on HEAppE and downloaded files are kept.`,
        { modal: true },
        "Remove",
      );
      if (ok) {
        await store.remove(list);
      }
    }),
    vscode.commands.registerCommand("qaas.jobs.clearFinished", () =>
      store.remove(store.all().filter((r) => TERMINAL.has(r.state))),
    ),
  );

  // Resume tracking jobs from earlier sessions (only polls without a login prompt).
  void jobs.poll(false);
}

export function deactivate(): void {}
