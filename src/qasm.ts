import * as path from "node:path";
import * as vscode from "vscode";
import type { Bridge } from "./bridge";
import { cfg, currentTarget, requireProject } from "./config";
import { estimate, formatRange } from "./core/estimate";
import { isQasm } from "./estimateLens";
import type { JobManager } from "./jobs";

interface CircuitStats {
  numQubits: number;
  depth: number;
  size: number;
  twoQubitGates: number;
  ops: Record<string, number>;
}
interface AnalyzeResult {
  original: CircuitStats;
  transpiled?: CircuitStats;
  transpiledQasm?: string;
  layout?: Record<string, number>;
}
interface SubmitResult {
  jobId: string;
  shots: number;
  circuits: number;
  calibrationSetId?: string;
  submittedAt: string;
}

export const TRANSPILED_SCHEME = "qaas-transpiled";

/** Read-only documents holding transpiled QASM for the diff view. */
export class TranspiledContentProvider implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  set(uri: vscode.Uri, text: string): void {
    this.docs.set(uri.toString(), text);
    this.changed.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "";
  }
}

export class QasmCommands {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("qaas-qasm");

  constructor(
    private readonly bridge: Bridge,
    private readonly jobs: JobManager,
    private readonly secrets: vscode.SecretStorage,
    private readonly transpiled: TranspiledContentProvider,
    private readonly output: vscode.OutputChannel,
  ) {}

  register(): vscode.Disposable[] {
    return [
      this.diagnostics,
      vscode.workspace.onDidSaveTextDocument((d) => this.validate(d)),
      vscode.workspace.onDidOpenTextDocument((d) => this.validate(d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.diagnostics.delete(d.uri)),
    ];
  }

  private async docFor(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!doc || !isQasm(doc)) {
      vscode.window.showWarningMessage("QaaS: open an OpenQASM 3 (.qasm) file.");
      return undefined;
    }
    return doc;
  }

  /** Parse with Qiskit's OpenQASM 3 importer and show errors in the editor. No login needed. */
  async validate(doc: vscode.TextDocument): Promise<void> {
    if (!isQasm(doc) || doc.uri.scheme === TRANSPILED_SCHEME || !cfg().get<boolean>("validateQasm", true)) {
      return;
    }
    try {
      await this.bridge.request<AnalyzeResult>("analyze", { source: doc.getText() });
      this.diagnostics.delete(doc.uri);
    } catch (e) {
      const msg = (e as Error).message;
      if ((e as { type?: string }).type !== "BridgeError") {
        return; // Python or qiskit missing: reported by the environment check instead
      }
      // qiskit-qasm3-import reports '"<line>,<col>: message"'; others say "line N ... column M".
      const m = /(\d+),(\d+):/.exec(msg) ?? /line\s*(\d+)(?:\D+col(?:umn)?\s*(\d+))?/i.exec(msg);
      const line = m ? Math.max(0, Number(m[1]) - 1) : 0;
      const col = m?.[2] ? Math.max(0, Number(m[2])) : 0;
      const range = new vscode.Range(line, col, line, Number.MAX_SAFE_INTEGER);
      this.diagnostics.set(doc.uri, [
        new vscode.Diagnostic(
          range,
          msg.replace(/^OpenQASM 3 parse error:\s*"?(\d+,\d+:\s*)?/, "").replace(/"$/, ""),
          vscode.DiagnosticSeverity.Error,
        ),
      ]);
    }
  }

  async transpile(uri?: vscode.Uri): Promise<void> {
    const doc = await this.docFor(uri);
    if (!doc || !(await requireProject())) {
      return;
    }
    const target = await currentTarget(this.secrets);
    try {
      const res = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `QaaS: transpiling for ${target.backend}…`,
          cancellable: true,
        },
        (_p, token) =>
          this.bridge.call<AnalyzeResult>("analyze", target, { source: doc.getText(), transpile: true }, token),
      );
      const base = path.basename(doc.fileName, ".qasm");
      const right = vscode.Uri.from({
        scheme: TRANSPILED_SCHEME,
        path: `/${base}.${target.backend}.qasm`,
        query: doc.uri.toString(),
      });
      this.transpiled.set(right, res.transpiledQasm ?? "");
      const o = res.original;
      const t = res.transpiled!;
      const layout = res.layout
        ? Object.entries(res.layout)
            .map(([v, p]) => `q${v}→${p}`)
            .join(", ")
        : "n/a";
      this.output.appendLine(
        `[transpile] ${path.basename(doc.fileName)} for ${target.backend}: depth ${o.depth}→${t.depth}, ` +
          `2-qubit gates ${o.twoQubitGates}→${t.twoQubitGates}, size ${o.size}→${t.size}, layout ${layout}, ops ${JSON.stringify(t.ops)}`,
      );
      await vscode.commands.executeCommand(
        "vscode.diff",
        doc.uri,
        right,
        `${path.basename(doc.fileName)} ↔ transpiled for ${target.backend}`,
        {
          preview: true,
        },
      );
      vscode.window.showInformationMessage(
        `QaaS: depth ${o.depth} → ${t.depth} · 2-qubit gates ${o.twoQubitGates} → ${t.twoQubitGates} · layout ${layout}`,
      );
    } catch (e) {
      vscode.window.showErrorMessage(`QaaS: transpile failed: ${(e as Error).message}`);
    }
  }

  /** Submit one .qasm file, or several selected in the explorer as one job. */
  async run(uri?: vscode.Uri, selected?: vscode.Uri[]): Promise<void> {
    const uris =
      selected && selected.length > 1 ? selected.filter((u) => u.fsPath.toLowerCase().endsWith(".qasm")) : [uri];
    const docs: vscode.TextDocument[] = [];
    for (const u of uris) {
      const d = await this.docFor(u);
      if (!d) {
        return;
      }
      if (d.isDirty) {
        await d.save();
      }
      docs.push(d);
    }
    if (docs.length === 0 || !(await requireProject())) {
      return;
    }
    const target = await currentTarget(this.secrets);
    const defaultShots = cfg().get<number>("defaultShots") ?? 1024;
    const shotsText = await vscode.window.showInputBox({
      title: `Run ${docs.length === 1 ? path.basename(docs[0].fileName) : `${docs.length} circuits`} on ${target.backend}`,
      prompt: "Shots per circuit",
      value: String(defaultShots),
      validateInput: (v) => {
        if (!/^\d+$/.test(v) || Number(v) < 1) {
          return "Enter a positive whole number";
        }
        const e = estimate({ shots: Number(v), circuits: docs.length });
        return {
          message: `Estimated billed time: ${formatRange(e)}`,
          severity: vscode.InputBoxValidationSeverity.Info,
        };
      },
      ignoreFocusOut: true,
    });
    if (!shotsText) {
      return;
    }
    const shots = Number(shotsText);
    const est = estimate({ shots, circuits: docs.length });
    const defaultName = docs.length === 1 ? path.basename(docs[0].fileName, ".qasm") : `batch_${docs.length}_circuits`;
    const jobName = await vscode.window.showInputBox({ title: "Job name", value: defaultName, ignoreFocusOut: true });
    if (jobName === undefined) {
      return;
    }
    if (cfg().get<boolean>("confirmSubmit", true)) {
      const ok = await vscode.window.showInformationMessage(
        `Submit "${jobName}" to ${target.backend}?`,
        {
          modal: true,
          detail:
            `${docs.length} circuit${docs.length === 1 ? "" : "s"} × ${shots.toLocaleString()} shots\n` +
            `Estimated billed QPU time: ${formatRange(est)} (${est.vlqJobs} VLQ job${est.vlqJobs === 1 ? "" : "s"})\n` +
            `Project ${target.project}${target.resource ? `, resource ${target.resource}` : ""}`,
        },
        "Submit",
      );
      if (ok !== "Submit") {
        return;
      }
    }
    try {
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `QaaS: submitting "${jobName}"…`, cancellable: true },
        (_p, token) =>
          this.bridge.call<SubmitResult>(
            "submit",
            target,
            { sources: docs.map((d) => d.getText()), shots, jobName },
            token,
          ),
      );
      await this.jobs.track({
        jobId: res.jobId,
        name: jobName,
        project: target.project,
        resource: target.resource,
        backend: target.backend,
        state: "SUBMITTED",
        submittedAt: res.submittedAt,
        shots,
        circuits: res.circuits,
        calibrationSetId: res.calibrationSetId,
        source: docs.map((d) => vscode.workspace.asRelativePath(d.uri)).join(", "),
        estimate: { low: est.low, high: est.high },
        origin: "extension",
      });
      vscode.window.showInformationMessage(`QaaS: submitted job #${res.jobId} (est. ${formatRange(est)} billed).`);
    } catch (e) {
      vscode.window.showErrorMessage(`QaaS: submit failed: ${(e as Error).message}`);
    }
  }
}
