import * as path from "node:path";
import * as vscode from "vscode";
import { Bridge } from "./bridge";
import {
  cfg,
  currentTarget,
  devEnvPath,
  devOverrides,
  lexisInstance,
  requireProject,
  TOKEN_KEY,
  targetEnv,
} from "./config";
import { devEnvTemplate, instanceLabel } from "./core/devEnv";
import { estimate, formatRange, formatSeconds } from "./core/estimate";
import { createEnvironment, installQaas, selectInterpreter } from "./environments";
import { detectCalls, EstimateCodeLensProvider, PYTHON_SELECTOR, QASM_SELECTOR } from "./estimateLens";
import { type EstimatorPreset, EstimatorViewProvider } from "./estimatorView";
import { JobManager, type JobRecord, JobStore, JobsTreeProvider, TERMINAL } from "./jobs";
import { OperatorCatalog, OperatorCommands, type OperatorNode, OperatorsTreeProvider } from "./operators";
import { resolvePython } from "./python";
import { QasmCommands, TRANSPILED_SCHEME, TranspiledContentProvider } from "./qasm";
import { ensureEnvironment, ensureReady, lexisName, signIn, type WhoAmI } from "./session";
import { WaveformEditor } from "./waveformEditor";

interface BackendInfo {
  name: string;
  resource: string | null;
  host: string | null;
  clusterId: number | null;
  allocatedUnits: number | null;
}

let output: vscode.OutputChannel;

async function listBackends(context: vscode.ExtensionContext, bridge: Bridge): Promise<void> {
  if (!(await requireProject()) || !(await ensureReady(bridge, context.secrets, output))) {
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
  const dev = devOverrides();
  if (pick && (dev.QAAS_BACKEND_NAME || dev.QAAS_LEXIS_RESOURCE)) {
    vscode.window.showInformationMessage(
      `QaaS: ${path.basename(devEnvPath())} sets the backend/resource; edit it to use ${pick.backend.name}.`,
    );
  } else if (pick) {
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
  const env = targetEnv(t);
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
  const dev = devOverrides();
  const project = dev.QAAS_LEXIS_PROJECT || cfg().get<string>("lexisProject");
  const backend = dev.QAAS_BACKEND_NAME || cfg().get<string>("backendName") || "VLQ";
  const instance = lexisInstance(dev);
  const label = instanceLabel(instance);
  item.text = `$(pulse) ${backend}${label ? ` · LEXIS ${label}` : ""}`;
  item.backgroundColor = label ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  const where = instance ? `LEXIS ${instance.apiUrl ?? instance.aaiUrl}` : "LEXIS production";
  const fromFile = Object.keys(dev).length > 0 ? ` (overrides from ${path.basename(devEnvPath())})` : "";
  item.tooltip = `QaaS: ${where}, project ${project || "not set"}${fromFile}. Click to choose a backend.`;
}

/** Log in to the current LEXIS instance and list backends, reporting each step in the output channel. */
async function testConnection(context: vscode.ExtensionContext, bridge: Bridge): Promise<void> {
  if (!(await ensureReady(bridge, context.secrets, output))) {
    return;
  }
  const target = await currentTarget(context.secrets);
  const where = target.instance ? (target.instance.apiUrl ?? target.instance.aaiUrl) : "production";
  output.show(true);
  output.appendLine(
    `[connection] LEXIS ${where} · project ${target.project || "(not set)"} · resource ${target.resource || "(auto)"} · backend ${target.backend}`,
  );
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `QaaS: connecting to LEXIS ${where}…`,
        cancellable: true,
      },
      async (_p, token) => {
        const me = await bridge.call<WhoAmI>("whoami", target, {}, token);
        output.appendLine(
          `[connection] logged in as ${me.user ?? "?"} (${me.tokenKind}; issuer ${me.issuer ?? "?"}; access token valid until ${me.expiresAt ?? "?"})`,
        );
        if (!target.project) {
          return { me, backends: undefined };
        }
        const backends = await bridge.call<BackendInfo[]>("backends", target, {}, token);
        for (const b of backends) {
          output.appendLine(`[connection] backend ${b.name} · resource ${b.resource ?? "?"} · host ${b.host ?? "?"}`);
        }
        return { me, backends };
      },
    );
    const n = result.backends?.length;
    vscode.window.showInformationMessage(
      `QaaS: connected to LEXIS ${where} as ${result.me.user ?? "?"}${
        n === undefined ? " (no project set, backends not listed)" : `, ${n} backend${n === 1 ? "" : "s"} available`
      }.`,
    );
  } catch (e) {
    output.appendLine(`[connection] failed: ${(e as Error).message}`);
    vscode.window.showErrorMessage(`QaaS: connection to LEXIS ${where} failed: ${(e as Error).message}`);
  }
}

/**
 * Synchronize with the LEXIS Platform: sign in (asking how, if needed), check the backend,
 * import jobs from HEAppE, refresh active jobs and, with pulse operators, the calibration set.
 */
async function synchronize(
  context: vscode.ExtensionContext,
  bridge: Bridge,
  jobs: JobManager,
  catalog: OperatorCatalog,
): Promise<void> {
  if (!(await ensureEnvironment(bridge, output)) || !(await requireProject())) {
    return;
  }
  if (!(await ensureReady(bridge, context.secrets, output))) {
    return;
  }
  const name = lexisName();
  const summary: string[] = [];
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `QaaS: synchronizing with ${name}`, cancellable: true },
      async (progress, token) => {
        const target = await currentTarget(context.secrets);
        progress.report({ message: "signing in…" });
        const me = await bridge.call<WhoAmI>("whoami", target, {}, token);
        summary.push(`signed in as ${me.user ?? "?"}`);

        progress.report({ message: "checking backends…" });
        const backends = await bridge.call<BackendInfo[]>("backends", target, {}, token);
        const current = backends.find((b) => b.name === target.backend);
        if (current) {
          summary.push(`backend ${current.name}${current.resource ? ` on ${current.resource}` : ""}`);
        } else {
          summary.push(`backend ${target.backend} not available (${backends.map((b) => b.name).join(", ") || "none"})`);
        }

        progress.report({ message: "importing jobs…" });
        const imported = await jobs.importFromHeappe({ quiet: true });
        if (imported) {
          summary.push(`${imported.found} jobs on HEAppE, ${imported.added} new`);
        }

        progress.report({ message: "refreshing active jobs…" });
        await jobs.poll(true);

        if (catalog.valid().length > 0) {
          progress.report({ message: "reading the calibration set…" });
          const info = await catalog.refreshPulseInfo(token);
          summary.push(`calibration set ${info.calibrationSetId.slice(0, 8)}…`);
        }
      },
    );
  } catch (e) {
    output.appendLine(`[sync] failed: ${(e as Error).message}`);
    vscode.window.showErrorMessage(`QaaS: synchronization with ${name} failed: ${(e as Error).message}`);
    return;
  }
  output.appendLine(`[sync] ${summary.join(" · ")}`);
  const missing = summary.find((s) => s.includes("not available"));
  if (missing) {
    const c = await vscode.window.showWarningMessage(`QaaS: ${summary.join(" · ")}.`, "Choose Backend");
    if (c) {
      await listBackends(context, bridge);
    }
  } else {
    vscode.window.showInformationMessage(`QaaS: synchronized with ${name}: ${summary.join(" · ")}.`);
  }
}

/** Open the developer connection file, creating it (and git-ignoring it) on first use. */
async function openDevConnectionFile(): Promise<void> {
  const uri = vscode.Uri.file(devEnvPath());
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(devEnvTemplate(), "utf8"));
    const ignore = vscode.Uri.joinPath(uri, "..", ".gitignore");
    let text = "";
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(ignore)).toString("utf8");
    } catch {
      // no .gitignore yet
    }
    const name = path.basename(uri.fsPath);
    if (!text.split(/\r?\n/).includes(name)) {
      await vscode.workspace.fs.writeFile(
        ignore,
        Buffer.from(`${text}${text && !text.endsWith("\n") ? "\n" : ""}${name}\n`, "utf8"),
      );
    }
  }
  await vscode.window.showTextDocument(uri);
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
  const catalog = new OperatorCatalog(bridge, context.secrets, context.globalState, output);
  const operatorCommands = new OperatorCommands(catalog, bridge, context.secrets, output);
  const qasm = new QasmCommands(bridge, jobs, context.secrets, transpiled, output, catalog);
  const operatorsView = vscode.window.createTreeView("qaas.operators", {
    treeDataProvider: new OperatorsTreeProvider(catalog),
  });
  void catalog.loadCachedInfo();
  catalog.onDidChange(() => lens.refresh());

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

  const devWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.dirname(devEnvPath())), path.basename(devEnvPath())),
  );
  const onDevChange = () => {
    updateStatusBar(status);
    void catalog.loadCachedInfo();
  };

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
      if (["qaas.lexisProject", "qaas.lexisResource", "qaas.backendName"].some((k) => e.affectsConfiguration(k))) {
        void catalog.loadCachedInfo();
      }
      if (e.affectsConfiguration("qaas.jobPollSeconds")) {
        jobs.schedule();
      }
      if (e.affectsConfiguration("qaas")) {
        lens.refresh();
        updateStatusBar(status);
      }
    }),
    devWatcher,
    devWatcher.onDidCreate(onDevChange),
    devWatcher.onDidChange(onDevChange),
    devWatcher.onDidDelete(onDevChange),

    // environment
    vscode.commands.registerCommand("qaas.checkEnvironment", () => ensureEnvironment(bridge, output, true)),
    vscode.commands.registerCommand("qaas.sync", () => synchronize(context, bridge, jobs, catalog)),
    vscode.commands.registerCommand("qaas.signIn", () => signIn(bridge, context.secrets, output)),
    vscode.commands.registerCommand("qaas.installPackage", () => installQaas()),
    vscode.commands.registerCommand("qaas.selectInterpreter", () => selectInterpreter()),
    vscode.commands.registerCommand("qaas.createEnvironment", () => createEnvironment()),
    vscode.commands.registerCommand("qaas.restartBridge", () => bridge.restart()),
    vscode.commands.registerCommand("qaas.openDevConnection", () => openDevConnectionFile()),
    vscode.commands.registerCommand("qaas.testConnection", () => testConnection(context, bridge)),
    vscode.commands.registerCommand("qaas.setToken", async () => {
      const token = await vscode.window.showInputBox({
        title: "LEXIS refresh or access token",
        prompt:
          "Stored in VS Code secret storage. A refresh/offline token is renewed automatically; an access token expires in minutes. Leave unset to log in through the browser.",
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
    vscode.commands.registerCommand("qaas.runQasmWithOperator", (uri?: vscode.Uri) => qasm.runWithOperator(uri)),

    // pulse-level operator catalog
    catalog,
    operatorsView,
    operatorCommands.watchResults(),
    vscode.commands.registerCommand("qaas.operators.new", () => operatorCommands.newOperator()),
    vscode.commands.registerCommand("qaas.operators.refreshCalibration", () => operatorCommands.refreshCalibration()),
    vscode.commands.registerCommand(
      "qaas.operators.openEditor",
      (node?: OperatorNode, calibrationSetId?: string, locus?: string) => {
        const n = node ?? operatorsView.selection[0];
        if (n && (n.kind === "operator" || n.kind === "calibration" || n.kind === "locus")) {
          const set = calibrationSetId ?? (n.kind !== "operator" ? n.cal.calibrationSetId : undefined);
          WaveformEditor.open(catalog, bridge, n.entry, set, locus ?? (n.kind === "locus" ? n.locus : undefined));
        }
      },
    ),
    vscode.commands.registerCommand("qaas.operators.openFile", (n: OperatorNode) => {
      if (n.kind !== "calset") {
        void vscode.window.showTextDocument(n.entry.uri);
      }
    }),
    vscode.commands.registerCommand("qaas.operators.seed", (n: OperatorNode) => operatorCommands.seed(n)),
    vscode.commands.registerCommand("qaas.operators.migrate", (n: OperatorNode) => operatorCommands.migrate(n)),
    vscode.commands.registerCommand("qaas.operators.markCalibrated", (n: OperatorNode) =>
      operatorCommands.markCalibrated(n),
    ),
    vscode.commands.registerCommand("qaas.operators.deleteEntry", (n: OperatorNode) => operatorCommands.deleteEntry(n)),
    vscode.commands.registerCommand("qaas.operators.insertCode", (n: OperatorNode) => operatorCommands.insertCode(n)),
    vscode.commands.registerCommand("qaas.operators.calibrate", (n: OperatorNode) => operatorCommands.calibrate(n)),
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
