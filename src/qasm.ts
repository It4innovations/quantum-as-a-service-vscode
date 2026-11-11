import * as path from "node:path";
import * as vscode from "vscode";
import type { Bridge } from "./bridge";
import { cfg, currentTarget, requireProject } from "./config";
import { estimate, formatRange } from "./core/estimate";
import { type CalibrationEntry, parseOperatorDirectives, pickEntry, shapeOnly } from "./core/operators";
import { isQasm } from "./estimateLens";
import type { JobManager, JobRecord } from "./jobs";
import { type OperatorCatalog, shortId } from "./operators";

interface PulsePlan {
  operators: { spec: object; loci: CalibrationEntry["loci"] }[];
  use: Record<string, string>;
  used: NonNullable<JobRecord["operators"]>;
}

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
/** Sources up to this size are kept with the job record. */
const MAX_STORED_SOURCE = 200_000;

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
    private readonly catalog: OperatorCatalog,
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
    const directiveProblems = this.directiveDiagnostics(doc);
    try {
      await this.bridge.request<AnalyzeResult>("analyze", { source: doc.getText() });
      this.diagnostics.set(doc.uri, directiveProblems);
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
        ...directiveProblems,
      ]);
    }
  }

  /** `// @qaas operator prx=name` must name an operator of the catalog. */
  private directiveDiagnostics(doc: vscode.TextDocument): vscode.Diagnostic[] {
    const { use, lines } = parseOperatorDirectives(doc.getText());
    const out: vscode.Diagnostic[] = [];
    for (const [gate, name] of Object.entries(use)) {
      const op = this.catalog.byName(name);
      const range = doc.lineAt(lines[gate]).range;
      if (!op) {
        out.push(
          new vscode.Diagnostic(range, `No operator "${name}" in .qaas/operators.`, vscode.DiagnosticSeverity.Warning),
        );
      } else if ((op.spec.gate ?? "prx") !== gate) {
        out.push(
          new vscode.Diagnostic(
            range,
            `Operator "${name}" implements ${op.spec.gate}, not ${gate}.`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
    }
    return out;
  }

  /** Choose a catalog operator, then run the file at pulse level with it. */
  async runWithOperator(uri?: vscode.Uri): Promise<void> {
    const ops = this.catalog.valid();
    if (ops.length === 0) {
      const c = await vscode.window.showInformationMessage("QaaS: the operator catalog is empty.", "New Operator…");
      if (c) {
        await vscode.commands.executeCommand("qaas.operators.new");
      }
      return;
    }
    const current = this.catalog.pulseInfo()?.calibrationSetId;
    const pick = await vscode.window.showQuickPick(
      ops.map((o) => {
        const entry = o.spec.calibrations?.find((c) => c.calibrationSetId === current);
        return {
          label: o.spec.name,
          description: `${o.spec.gate ?? "prx"} · ${entry ? (entry.status ?? "draft") : current ? "no entry for the current set" : "calibration set unknown"}`,
          detail: o.spec.description,
          name: o.spec.name,
          gate: o.spec.gate ?? "prx",
        };
      }),
      { title: "Run at pulse level with operator", placeHolder: "Tip: add  // @qaas operator prx=<name>  to the file" },
    );
    if (pick) {
      await this.run(uri, undefined, { [pick.gate]: pick.name });
    }
  }

  /** Resolve operators and their calibration for the current set; asks when it is missing or a draft. */
  private async planPulse(use: Record<string, string>): Promise<PulsePlan | undefined> {
    let info: Awaited<ReturnType<OperatorCatalog["ensurePulseInfo"]>>;
    try {
      info = await this.catalog.ensurePulseInfo();
    } catch (e) {
      vscode.window.showErrorMessage(`QaaS: could not read the current calibration set: ${(e as Error).message}`);
      return undefined;
    }
    const plan: PulsePlan = { operators: [], use, used: [] };
    for (const [gate, name] of Object.entries(use)) {
      const op = this.catalog.byName(name);
      if (!op) {
        vscode.window.showErrorMessage(`QaaS: no operator "${name}" in .qaas/operators.`);
        return undefined;
      }
      if ((op.spec.gate ?? "prx") !== gate) {
        vscode.window.showErrorMessage(`QaaS: operator "${name}" implements ${op.spec.gate}, not ${gate}.`);
        return undefined;
      }
      let cal = op.spec.calibrations?.find((c) => c.calibrationSetId === info.calibrationSetId);
      if (!cal) {
        const latest = pickEntry(op.spec, info.calibrationSetId);
        const actions = latest ? ["Migrate…", "Use Old Values"] : ["Start from Native Gate"];
        const choice = await vscode.window.showWarningMessage(
          `${name} has no calibration for the current calibration set ${shortId(info.calibrationSetId)}.`,
          {
            modal: true,
            detail: latest
              ? `Its latest values were tuned on set ${shortId(latest.calibrationSetId)}. Migrate them (then verify), or run with the old values.`
              : "It has no calibration values yet.",
          },
          ...actions,
        );
        if (choice === "Use Old Values" && latest) {
          cal = latest;
        } else {
          if (choice === "Migrate…") {
            await vscode.commands.executeCommand("qaas.operators.migrate", { kind: "operator", entry: op });
          } else if (choice === "Start from Native Gate") {
            await vscode.commands.executeCommand("qaas.operators.seed", { kind: "operator", entry: op });
          }
          return undefined;
        }
      } else if (cal.status !== "calibrated") {
        const ok = await vscode.window.showWarningMessage(
          `${name}: the values for the current calibration set are a draft (not verified on hardware).`,
          { modal: true },
          "Run Anyway",
        );
        if (!ok) {
          return undefined;
        }
      }
      plan.operators.push({ spec: shapeOnly(op.spec), loci: cal.loci });
      plan.used.push({ name, gate, calibrationSetId: cal.calibrationSetId, status: cal.status ?? "draft" });
    }
    return plan;
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

  /** Submit one .qasm file, or several selected in the explorer as one job. Operators: directives or `forcedUse`. */
  async run(uri?: vscode.Uri, selected?: vscode.Uri[], forcedUse?: Record<string, string>): Promise<void> {
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
    let use: Record<string, string> = forcedUse ?? {};
    if (!forcedUse) {
      for (const d of docs) {
        for (const [gate, name] of Object.entries(parseOperatorDirectives(d.getText()).use)) {
          if (use[gate] && use[gate] !== name) {
            vscode.window.showErrorMessage(
              `QaaS: the selected files ask for different ${gate} operators (${use[gate]}, ${name}).`,
            );
            return;
          }
          use = { ...use, [gate]: name };
        }
      }
    }
    const pulse = Object.keys(use).length > 0 ? await this.planPulse(use) : undefined;
    if (Object.keys(use).length > 0 && !pulse) {
      return;
    }
    const pulseText = pulse
      ? `\nPulse level: ${pulse.used.map((u) => `${u.gate}=${u.name} (set ${shortId(u.calibrationSetId)}, ${u.status})`).join(", ")}`
      : "";
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
            `Project ${target.project}${target.resource ? `, resource ${target.resource}` : ""}${pulseText}`,
        },
        "Submit",
      );
      if (ok !== "Submit") {
        return;
      }
    }
    const sources = docs.map((d) => d.getText());
    try {
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `QaaS: submitting "${jobName}"…`, cancellable: true },
        (_p, token) =>
          pulse
            ? this.bridge.call<SubmitResult>(
                "submitPulse",
                target,
                { sources, shots, jobName, operators: pulse.operators, use: pulse.use },
                token,
              )
            : this.bridge.call<SubmitResult>("submit", target, { sources, shots, jobName }, token),
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
        qasmSources: sources.join("").length <= MAX_STORED_SOURCE ? sources : undefined,
        kind: pulse ? "pulse" : "circuit",
        operators: pulse?.used,
        origin: "extension",
      });
      vscode.window.showInformationMessage(`QaaS: submitted job #${res.jobId} (est. ${formatRange(est)} billed).`);
    } catch (e) {
      vscode.window.showErrorMessage(`QaaS: submit failed: ${(e as Error).message}`);
    }
  }
}
