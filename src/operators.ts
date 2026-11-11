import * as path from "node:path";
import * as vscode from "vscode";
import { parseDocument } from "yaml";
import type { Bridge } from "./bridge";
import { cfg, currentTarget, requireProject, sanitize } from "./config";
import { buildCalibrationNotebook, calibrationCost } from "./core/calibrationNotebook";
import { formatSeconds } from "./core/estimate";
import {
  applyCalibrationResult,
  type CalibrationEntry,
  entryStatus,
  isCalibrationResult,
  migrateEntry,
  OPERATOR_NAME_RE,
  type OperatorSpec,
  type OperatorStatus,
  operatorStatus,
  operatorTemplate,
  type ParsedOperator,
  type PulseInfo,
  parseOperator,
  pickEntry,
  rangeOf,
  removeEntry,
  seedEntry,
  setEntryStatus,
  shapeOnly,
  type TemplateOptions,
  upsertEntry,
} from "./core/operators";

export const OPERATOR_GLOB = "**/.qaas/operators/*.{yaml,yml,json}";
const RESULT_GLOB = "**/.qaas/calibrations/*.json";

export interface CatalogEntry {
  uri: vscode.Uri;
  text: string;
  parsed: ParsedOperator;
  spec?: OperatorSpec;
}

interface ValidateResult {
  locus: string;
  nSamples: number;
  peak: number;
  error: string | null;
}

export const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

function age(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) {
    return "just now";
  }
  if (min < 60) {
    return `${min} min ago`;
  }
  return min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
}

/** Operator files of the workspace, their problems, and the current calibration set. */
export class OperatorCatalog implements vscode.Disposable {
  private readonly entries = new Map<string, CatalogEntry>();
  private readonly deepProblems = new Map<string, vscode.Diagnostic[]>();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("qaas-operators");
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly bridge: Bridge,
    private readonly secrets: vscode.SecretStorage,
    private readonly state: vscode.Memento,
    private readonly output: vscode.OutputChannel,
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher(OPERATOR_GLOB);
    this.disposables.push(
      watcher,
      this.diagnostics,
      watcher.onDidCreate((u) => this.loadFile(u)),
      watcher.onDidChange((u) => this.loadFile(u)),
      watcher.onDidDelete((u) => {
        this.entries.delete(u.toString());
        this.diagnostics.delete(u);
        this.changed.fire();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.isOperatorFile(e.document.uri)) {
          this.load(e.document.uri, e.document.getText());
        }
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (this.isOperatorFile(d.uri)) {
          void this.deepValidate(d.uri);
        }
      }),
    );
    void this.scan();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  isOperatorFile(uri: vscode.Uri): boolean {
    return /[\\/]\.qaas[\\/]operators[\\/][^\\/]+\.(ya?ml|json)$/i.test(uri.fsPath);
  }

  async scan(): Promise<void> {
    const files = await vscode.workspace.findFiles(OPERATOR_GLOB, "**/node_modules/**");
    this.entries.clear();
    for (const f of files) {
      await this.loadFile(f, false);
    }
    this.refreshDiagnostics();
    this.changed.fire();
  }

  private async loadFile(uri: vscode.Uri, notify = true): Promise<void> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    const text = open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    this.load(uri, text, notify);
  }

  private load(uri: vscode.Uri, text: string, notify = true): void {
    const parsed = parseOperator(text);
    this.entries.set(uri.toString(), { uri, text, parsed, spec: parsed.spec });
    if (notify) {
      this.refreshDiagnostics();
      this.changed.fire();
    }
  }

  all(): CatalogEntry[] {
    return [...this.entries.values()].sort((a, b) =>
      (a.spec?.name ?? a.uri.fsPath).localeCompare(b.spec?.name ?? b.uri.fsPath),
    );
  }

  valid(): (CatalogEntry & { spec: OperatorSpec })[] {
    return this.all().filter((e): e is CatalogEntry & { spec: OperatorSpec } => !!e.spec);
  }

  byName(name: string): (CatalogEntry & { spec: OperatorSpec }) | undefined {
    return this.valid().find((e) => e.spec.name === name);
  }

  get(uri: vscode.Uri): CatalogEntry | undefined {
    return this.entries.get(uri.toString());
  }

  // --- current calibration set ------------------------------------------

  private async infoKey(): Promise<string> {
    const t = await currentTarget(this.secrets);
    return `qaas.pulseInfo:${t.project}|${t.resource}|${t.backend}`;
  }

  /** Last fetched calibration info for the configured backend (may be outdated). */
  pulseInfo(): PulseInfo | undefined {
    return this.cachedInfo;
  }
  private cachedInfo?: PulseInfo;

  async loadCachedInfo(): Promise<void> {
    this.cachedInfo = this.state.get<PulseInfo>(await this.infoKey());
    this.refreshDiagnostics();
    this.changed.fire();
  }

  /** Fetch the current calibration set and native gate values (needs a LEXIS login). */
  async refreshPulseInfo(token?: vscode.CancellationToken): Promise<PulseInfo> {
    const target = await currentTarget(this.secrets);
    const info = await this.bridge.call<PulseInfo>("pulseInfo", target, {}, token);
    await this.state.update(await this.infoKey(), info);
    const previous = this.cachedInfo?.calibrationSetId;
    this.cachedInfo = info;
    this.refreshDiagnostics();
    this.changed.fire();
    if (previous && previous !== info.calibrationSetId) {
      const stale = this.valid().filter((e) => operatorStatus(e.spec, info.calibrationSetId) === "stale").length;
      if (stale) {
        vscode.window.showWarningMessage(
          `QaaS: the calibration set changed to ${shortId(info.calibrationSetId)}. ${stale} operator${stale === 1 ? " needs" : "s need"} migration.`,
        );
      }
    }
    return info;
  }

  /** Cached info when younger than qaas.calibrationMaxAgeMinutes, else a fresh fetch. */
  async ensurePulseInfo(): Promise<PulseInfo> {
    const maxAge = (cfg().get<number>("calibrationMaxAgeMinutes") ?? 60) * 60000;
    const info = this.cachedInfo;
    if (info && Date.now() - new Date(info.fetchedAt).getTime() < maxAge) {
      return info;
    }
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "QaaS: reading the current calibration set…",
        cancellable: true,
      },
      (_p, token) => this.refreshPulseInfo(token),
    );
  }

  // --- diagnostics -------------------------------------------------------

  private refreshDiagnostics(): void {
    const names = new Map<string, number>();
    for (const e of this.valid()) {
      names.set(e.spec.name, (names.get(e.spec.name) ?? 0) + 1);
    }
    const current = this.cachedInfo?.calibrationSetId;
    for (const e of this.entries.values()) {
      const text = e.text;
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === e.uri.toString());
      const toRange = (start: number, end: number) => {
        if (doc) {
          return new vscode.Range(doc.positionAt(start), doc.positionAt(Math.max(end, start + 1)));
        }
        const before = text.slice(0, start).split("\n");
        const line = before.length - 1;
        return new vscode.Range(line, before[line].length, line, before[line].length + Math.max(1, end - start));
      };
      const out: vscode.Diagnostic[] = [];
      for (const s of e.parsed.syntaxErrors) {
        out.push(new vscode.Diagnostic(toRange(s.offset, s.offset + 1), s.message, vscode.DiagnosticSeverity.Error));
      }
      for (const p of e.parsed.problems) {
        const [a, b] = rangeOf(e.parsed.doc, p.path);
        const sev = p.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
        out.push(new vscode.Diagnostic(toRange(a, b), p.message, sev));
      }
      if (e.spec && (names.get(e.spec.name) ?? 0) > 1) {
        const [a, b] = rangeOf(e.parsed.doc, ["name"]);
        out.push(
          new vscode.Diagnostic(
            toRange(a, b),
            `Another operator file also uses the name "${e.spec.name}".`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
      if (e.spec && current) {
        e.spec.calibrations?.forEach((c, i) => {
          const status = entryStatus(c, current);
          if (status === "stale" && !e.spec?.calibrations?.some((x) => x.calibrationSetId === current)) {
            const [a, b] = rangeOf(e.parsed.doc, ["calibrations", i, "calibrationSetId"]);
            const d = new vscode.Diagnostic(
              toRange(a, b),
              `Tuned on calibration set ${shortId(c.calibrationSetId)}; the current set is ${shortId(current)}. Use "Migrate to Current Calibration Set".`,
              vscode.DiagnosticSeverity.Information,
            );
            d.code = "qaas.stale";
            out.push(d);
          }
        });
      }
      out.push(...(this.deepProblems.get(e.uri.toString()) ?? []));
      this.diagnostics.set(e.uri, out);
    }
  }

  /** Python-side checks: expressions, built-in waveforms, sampling of every qubit. No login. */
  async deepValidate(uri: vscode.Uri): Promise<void> {
    const e = this.get(uri);
    if (!e?.spec) {
      this.deepProblems.delete(uri.toString());
      return;
    }
    const out: vscode.Diagnostic[] = [];
    const rate = this.cachedInfo?.sampleRate ?? cfg().get<number>("pulseSampleRate") ?? 2e9;
    const doc = await vscode.workspace.openTextDocument(uri);
    const rangeAt = (p: (string | number)[]) => {
      const [a, b] = rangeOf(e.parsed.doc, p);
      return new vscode.Range(doc.positionAt(a), doc.positionAt(Math.max(b, a + 1)));
    };
    try {
      const cals = e.spec.calibrations ?? [];
      if (cals.length === 0) {
        await this.bridge.request<ValidateResult[]>("pulseValidate", {
          spec: shapeOnly(e.spec),
          loci: {},
          sampleRate: rate,
        });
      }
      for (const [i, c] of cals.entries()) {
        const results = await this.bridge.request<ValidateResult[]>("pulseValidate", {
          spec: shapeOnly(e.spec),
          loci: c.loci,
          sampleRate: rate,
        });
        for (const r of results) {
          const where = rangeAt(["calibrations", i, "loci", r.locus]);
          if (r.error) {
            out.push(new vscode.Diagnostic(where, `${r.locus}: ${r.error}`, vscode.DiagnosticSeverity.Error));
          } else if (r.peak > 1) {
            out.push(
              new vscode.Diagnostic(
                where,
                `${r.locus}: peak amplitude ${r.peak.toFixed(3)} exceeds 1; lower amplitude_i / amplitude_q.`,
                vscode.DiagnosticSeverity.Error,
              ),
            );
          }
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      if ((err as { type?: string }).type === "BridgeError") {
        out.push(new vscode.Diagnostic(rangeAt(["waveform"]), msg, vscode.DiagnosticSeverity.Error));
      } else {
        this.output.appendLine(`[operators] validation of ${uri.fsPath} skipped: ${msg}`);
      }
    }
    this.deepProblems.set(uri.toString(), out);
    this.refreshDiagnostics();
  }

  /** Replace an operator file's content through the editor (keeps undo and open editors in sync). */
  async write(uri: vscode.Uri, yamlText: string): Promise<void> {
    const text = uri.fsPath.toLowerCase().endsWith(".json")
      ? `${JSON.stringify(parseDocument(yamlText).toJS(), null, 2)}\n`
      : yamlText;
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    this.load(uri, text);
  }

  async textOf(uri: vscode.Uri): Promise<string> {
    return (await vscode.workspace.openTextDocument(uri)).getText();
  }
}

// --- tree ------------------------------------------------------------------

export type OperatorNode =
  | { kind: "calset" }
  | { kind: "operator"; entry: CatalogEntry & { spec: OperatorSpec } }
  | { kind: "invalid"; entry: CatalogEntry }
  | { kind: "calibration"; entry: CatalogEntry & { spec: OperatorSpec }; cal: CalibrationEntry }
  | { kind: "locus"; entry: CatalogEntry & { spec: OperatorSpec }; cal: CalibrationEntry; locus: string };

const STATUS_TEXT: Record<OperatorStatus, string> = {
  ready: "calibrated for the current set",
  draft: "draft for the current set",
  stale: "needs migration",
  uncalibrated: "not calibrated",
  unknown: "calibration set unknown",
};

function statusIcon(s: OperatorStatus): vscode.ThemeIcon {
  switch (s) {
    case "ready":
      return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
    case "draft":
      return new vscode.ThemeIcon("edit", new vscode.ThemeColor("editorWarning.foreground"));
    case "stale":
      return new vscode.ThemeIcon("history", new vscode.ThemeColor("editorWarning.foreground"));
    case "uncalibrated":
      return new vscode.ThemeIcon("circle-large-outline");
    default:
      return new vscode.ThemeIcon("pulse");
  }
}

export function describeShape(spec: OperatorSpec): string {
  const one = (s?: OperatorSpec["waveform"]["i"]) =>
    !s
      ? "zero"
      : s.type === "builtin"
        ? (s.name ?? "?")
        : s.type === "expression"
          ? (s.expression ?? "")
          : s.type === "samples"
            ? `${s.samples?.length ?? 0} samples`
            : s.type;
  return `I: ${one(spec.waveform.i)} · Q: ${one(spec.waveform.q)}`;
}

export class OperatorsTreeProvider implements vscode.TreeDataProvider<OperatorNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly catalog: OperatorCatalog) {
    catalog.onDidChange(() => this.changed.fire());
  }

  getChildren(node?: OperatorNode): OperatorNode[] {
    if (!node) {
      if (this.catalog.all().length === 0) {
        return [];
      }
      return [
        { kind: "calset" },
        ...this.catalog
          .all()
          .map(
            (entry): OperatorNode =>
              entry.spec
                ? { kind: "operator", entry: entry as CatalogEntry & { spec: OperatorSpec } }
                : { kind: "invalid", entry },
          ),
      ];
    }
    if (node.kind === "operator") {
      return (node.entry.spec.calibrations ?? []).map((cal) => ({ kind: "calibration", entry: node.entry, cal }));
    }
    if (node.kind === "calibration") {
      return Object.keys(node.cal.loci)
        .sort()
        .map((locus) => ({ kind: "locus", entry: node.entry, cal: node.cal, locus }));
    }
    return [];
  }

  getTreeItem(node: OperatorNode): vscode.TreeItem {
    const info = this.catalog.pulseInfo();
    const current = info?.calibrationSetId;
    switch (node.kind) {
      case "calset": {
        const item = new vscode.TreeItem(
          info ? `Calibration set ${shortId(info.calibrationSetId)}` : "Current calibration set: unknown",
        );
        item.description = info ? `${info.backend} · ${age(info.fetchedAt)}` : "click to fetch (login)";
        item.iconPath = new vscode.ThemeIcon("calendar");
        item.tooltip = info
          ? `${info.calibrationSetId}\nNative prx: ${info.nativeImplementation}\nSample rate ${(info.sampleRate / 1e9).toFixed(2)} GS/s` +
            (info.granularity ? `, granularity ${info.granularity} samples` : "")
          : "Fetch the current calibration set to see which operators need migration.";
        item.command = { command: "qaas.operators.refreshCalibration", title: "Refresh" };
        item.contextValue = "calset";
        return item;
      }
      case "invalid": {
        const item = new vscode.TreeItem(path.basename(node.entry.uri.fsPath));
        item.description = "invalid";
        item.iconPath = new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground"));
        item.tooltip = [
          ...node.entry.parsed.syntaxErrors.map((e) => e.message),
          ...node.entry.parsed.problems.map((p) => p.message),
        ].join("\n");
        item.command = { command: "vscode.open", title: "Open", arguments: [node.entry.uri] };
        return item;
      }
      case "operator": {
        const spec = node.entry.spec;
        const status = operatorStatus(spec, current);
        const item = new vscode.TreeItem(spec.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = node.entry.uri.toString();
        item.description = `${spec.gate ?? "prx"} · ${STATUS_TEXT[status]}`;
        item.iconPath = statusIcon(status);
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${spec.name}** (${spec.gate ?? "prx"})\n\n`);
        if (spec.description) {
          md.appendMarkdown(`${spec.description}\n\n`);
        }
        md.appendCodeblock(describeShape(spec), "text");
        md.appendMarkdown(`\n${vscode.workspace.asRelativePath(node.entry.uri)}`);
        item.tooltip = md;
        item.contextValue = `operator.${status}`;
        item.command = { command: "qaas.operators.openEditor", title: "Open Waveform Editor", arguments: [node] };
        return item;
      }
      case "calibration": {
        const c = node.cal;
        const st = entryStatus(c, current);
        const item = new vscode.TreeItem(
          `set ${shortId(c.calibrationSetId)}`,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.id = `${node.entry.uri.toString()}#${c.calibrationSetId}`;
        const n = Object.keys(c.loci).length;
        item.description = [
          c.status ?? "draft",
          `${n} qubit${n === 1 ? "" : "s"}`,
          st === "stale" ? "old set" : st === "unknown" ? "" : "current",
        ]
          .filter(Boolean)
          .join(" · ");
        item.iconPath = new vscode.ThemeIcon(
          st === "stale" ? "history" : c.status === "calibrated" ? "verified" : "edit",
        );
        item.tooltip = [
          c.calibrationSetId,
          c.backend && `Backend ${c.backend}`,
          c.updatedAt && `Updated ${new Date(c.updatedAt).toLocaleString()}`,
          c.migratedFrom && `Migrated from ${c.migratedFrom}`,
          c.verifiedLoci?.length ? `Verified: ${c.verifiedLoci.join(", ")}` : undefined,
          c.note,
        ]
          .filter(Boolean)
          .join("\n");
        item.contextValue = `calibration.${st}.${c.status ?? "draft"}`;
        return item;
      }
      case "locus": {
        const v = node.cal.loci[node.locus];
        const item = new vscode.TreeItem(node.locus);
        const parts = [
          typeof v.duration === "number" ? `${(v.duration * 1e9).toFixed(1)} ns` : undefined,
          typeof v.amplitude_i === "number" ? `Aᵢ ${v.amplitude_i.toFixed(4)}` : undefined,
          typeof v.amplitude_q === "number" && v.amplitude_q !== 0 ? `A_q ${v.amplitude_q.toFixed(4)}` : undefined,
          node.cal.verifiedLoci?.includes(node.locus) ? "verified" : undefined,
        ];
        item.description = parts.filter(Boolean).join(" · ");
        item.iconPath = new vscode.ThemeIcon("circuit-board");
        item.tooltip = Object.entries(v)
          .map(([k, x]) => `${k}: ${x}`)
          .join("\n");
        item.command = {
          command: "qaas.operators.openEditor",
          title: "Open Waveform Editor",
          arguments: [{ kind: "operator", entry: node.entry }, node.cal.calibrationSetId, node.locus],
        };
        return item;
      }
    }
  }
}

// --- commands ----------------------------------------------------------------

export class OperatorCommands {
  constructor(
    private readonly catalog: OperatorCatalog,
    private readonly bridge: Bridge,
    private readonly secrets: vscode.SecretStorage,
    private readonly output: vscode.OutputChannel,
  ) {}

  private workspaceRoot(): vscode.Uri | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      vscode.window.showWarningMessage(
        "QaaS: open a folder first; operators live in .qaas/operators of the workspace.",
      );
    }
    return root;
  }

  async newOperator(): Promise<vscode.Uri | undefined> {
    const root = this.workspaceRoot();
    if (!root) {
      return undefined;
    }
    const templates: (vscode.QuickPickItem & { template: TemplateOptions["template"] })[] = [
      { label: "DRAG Gaussian", description: "built-in Gaussian, derivative on Q", template: "drag_gaussian" },
      {
        label: "Cosine rise-fall",
        description: "built-in CosineRiseFall, derivative on Q",
        template: "cosine_rise_fall",
      },
      { label: "Hann + DRAG", description: "expression cos²(πt), derivative on Q", template: "hann_drag" },
      { label: "Custom expression", description: "your own formula of t and parameters", template: "expression" },
      { label: "Sample points", description: "values interpolated over the pulse", template: "samples" },
    ];
    const tpl = await vscode.window.showQuickPick(templates, { title: "New pulse-level operator (custom prx)" });
    if (!tpl) {
      return undefined;
    }
    const name = await vscode.window.showInputBox({
      title: "Operator name",
      prompt: "Implementation name registered with the IQM compiler",
      value: tpl.template,
      validateInput: (v) =>
        !OPERATOR_NAME_RE.test(v)
          ? "Lower case letters, digits and underscores, starting with a letter"
          : this.catalog.byName(v)
            ? "An operator with this name exists"
            : undefined,
    });
    if (!name) {
      return undefined;
    }
    const description = await vscode.window.showInputBox({ title: "Description (optional)", value: "" });
    let text = operatorTemplate({ name, template: tpl.template, description: description ?? "" });
    const info = this.catalog.pulseInfo();
    if (info?.qubits.length) {
      const picks = await vscode.window.showQuickPick(
        info.qubits.map((q) => ({ label: q, picked: true })),
        {
          title: `Start a draft calibration for set ${shortId(info.calibrationSetId)} from the native gate? (Esc to skip)`,
          canPickMany: true,
        },
      );
      if (picks?.length) {
        text = upsertEntry(
          text,
          seedEntry(
            info,
            picks.map((p) => p.label),
          ),
        );
      }
    }
    const uri = vscode.Uri.joinPath(root, ".qaas", "operators", `${name}.yaml`);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
    await vscode.window.showTextDocument(uri);
    return uri;
  }

  async refreshCalibration(): Promise<void> {
    if (!(await requireProject())) {
      return;
    }
    try {
      const info = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "QaaS: reading the current calibration set…",
          cancellable: true,
        },
        (_p, token) => this.catalog.refreshPulseInfo(token),
      );
      vscode.window.showInformationMessage(
        `QaaS: calibration set ${shortId(info.calibrationSetId)} on ${info.backend}, ${info.qubits.length} qubits, native prx ${info.nativeImplementation}.`,
      );
    } catch (e) {
      vscode.window.showErrorMessage(`QaaS: could not read the calibration set: ${(e as Error).message}`);
    }
  }

  /** Seed a draft entry for the current set from the native gate. */
  async seed(node: OperatorNode): Promise<void> {
    if (node.kind !== "operator") {
      return;
    }
    const info = await this.catalog.ensurePulseInfo();
    if (node.entry.spec.calibrations?.some((c) => c.calibrationSetId === info.calibrationSetId)) {
      vscode.window.showInformationMessage("QaaS: this operator already has an entry for the current calibration set.");
      return;
    }
    const picks = await vscode.window.showQuickPick(
      info.qubits.map((q) => ({ label: q, picked: true })),
      { title: "Qubits to seed from the native prx gate", canPickMany: true },
    );
    if (!picks?.length) {
      return;
    }
    const text = await this.catalog.textOf(node.entry.uri);
    await this.catalog.write(
      node.entry.uri,
      upsertEntry(
        text,
        seedEntry(
          info,
          picks.map((p) => p.label),
        ),
      ),
    );
  }

  async migrate(node: OperatorNode): Promise<void> {
    if (node.kind !== "operator" && node.kind !== "calibration") {
      return;
    }
    const entry = node.entry;
    const info = await this.catalog.ensurePulseInfo();
    const from =
      node.kind === "calibration"
        ? node.cal
        : [...(entry.spec.calibrations ?? [])]
            .filter((c) => c.calibrationSetId !== info.calibrationSetId)
            .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
    if (!from) {
      vscode.window.showInformationMessage("QaaS: nothing to migrate; there is no entry for an older calibration set.");
      return;
    }
    if (from.calibrationSetId === info.calibrationSetId) {
      vscode.window.showInformationMessage("QaaS: this entry already belongs to the current calibration set.");
      return;
    }
    if (entry.spec.calibrations?.some((c) => c.calibrationSetId === info.calibrationSetId)) {
      const ok = await vscode.window.showWarningMessage(
        `${entry.spec.name} already has an entry for the current set ${shortId(info.calibrationSetId)}. Replace it?`,
        { modal: true },
        "Replace",
      );
      if (ok !== "Replace") {
        return;
      }
    }
    const how = await vscode.window.showQuickPick(
      [
        {
          label: "Rescale amplitudes with the native gate",
          description: "recommended",
          detail: "amplitude × (native amplitude now / native amplitude when tuned), per qubit",
          scale: true,
        },
        { label: "Copy values unchanged", detail: "same duration and amplitudes", scale: false },
      ],
      {
        title: `Migrate ${entry.spec.name} from ${shortId(from.calibrationSetId)} to ${shortId(info.calibrationSetId)}`,
      },
    );
    if (!how) {
      return;
    }
    const m = migrateEntry(from, info, how.scale);
    const text = await this.catalog.textOf(entry.uri);
    await this.catalog.write(entry.uri, upsertEntry(text, m.entry));
    const factors = Object.entries(m.factors)
      .filter(([l]) => !m.unscaled.includes(l))
      .map(([l, f]) => `${l} ×${f.toFixed(3)}`)
      .join(", ");
    const unscaled = m.unscaled.length
      ? ` Copied without rescaling (no native reference): ${m.unscaled.join(", ")}.`
      : "";
    const choice = await vscode.window.showInformationMessage(
      `QaaS: ${entry.spec.name} migrated as a draft. ${factors ? `Factors: ${factors}.` : ""}${unscaled} Verify it, e.g. with a Rabi calibration.`,
      "Calibrate (Rabi)…",
    );
    if (choice) {
      await this.calibrate({ kind: "operator", entry: this.catalog.byName(entry.spec.name) ?? entry });
    }
  }

  async markCalibrated(node: OperatorNode): Promise<void> {
    if (node.kind !== "calibration") {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Mark the entry for set ${shortId(node.cal.calibrationSetId)} as calibrated? Do this only after verifying the values on hardware.`,
      { modal: true },
      "Mark Calibrated",
    );
    if (ok) {
      const text = await this.catalog.textOf(node.entry.uri);
      await this.catalog.write(node.entry.uri, setEntryStatus(text, node.cal.calibrationSetId, "calibrated"));
    }
  }

  async deleteEntry(node: OperatorNode): Promise<void> {
    if (node.kind !== "calibration") {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Delete the calibration entry for set ${shortId(node.cal.calibrationSetId)} from ${node.entry.spec.name}?`,
      { modal: true },
      "Delete",
    );
    if (ok) {
      const text = await this.catalog.textOf(node.entry.uri);
      await this.catalog.write(node.entry.uri, removeEntry(text, node.cal.calibrationSetId));
    }
  }

  /** Generated Python for an operator and its calibration entry. */
  async code(entry: CatalogEntry & { spec: OperatorSpec }, cal?: CalibrationEntry): Promise<string> {
    const note = cal
      ? `Calibration set ${cal.calibrationSetId} (${cal.status ?? "draft"}${cal.updatedAt ? `, ${cal.updatedAt}` : ""}).`
      : "No calibration values yet.";
    return this.bridge.request<string>("pulseCode", {
      operators: [{ spec: shapeOnly(entry.spec), loci: cal?.loci ?? {} }],
      use: { [entry.spec.gate ?? "prx"]: entry.spec.name },
      note: `${note}\nSource: ${vscode.workspace.asRelativePath(entry.uri)}`,
    });
  }

  async insertCode(node: OperatorNode): Promise<void> {
    if (node.kind !== "operator" && node.kind !== "calibration") {
      return;
    }
    const cal =
      node.kind === "calibration" ? node.cal : pickEntry(node.entry.spec, this.catalog.pulseInfo()?.calibrationSetId);
    let code: string;
    try {
      code = await this.code(node.entry, cal);
    } catch (e) {
      vscode.window.showErrorMessage(`QaaS: ${(e as Error).message}`);
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === "python") {
      await editor.edit((b) => b.insert(editor.selection.active, `${code}\n`));
    } else {
      const doc = await vscode.workspace.openTextDocument({ language: "python", content: code });
      await vscode.window.showTextDocument(doc);
    }
  }

  async calibrate(node: OperatorNode): Promise<void> {
    if (node.kind !== "operator") {
      return;
    }
    const root = this.workspaceRoot();
    const project = await requireProject();
    if (!root || !project) {
      return;
    }
    const spec = node.entry.spec;
    const info = this.catalog.pulseInfo();
    const cal = pickEntry(spec, info?.calibrationSetId);
    const qubits = [...new Set([...Object.keys(cal?.loci ?? {}), ...(info?.qubits ?? [])])];
    const qubit = qubits.length
      ? await vscode.window.showQuickPick(qubits, { title: `Qubit to calibrate ${spec.name} on` })
      : await vscode.window.showInputBox({ title: "Qubit to calibrate", value: "QB1" });
    if (!qubit) {
      return;
    }
    const ok = await vscode.window.showInformationMessage(
      `Create a Rabi calibration notebook for ${spec.name} on ${qubit}?`,
      {
        modal: true,
        detail: `Running it submits 7 pulse-level jobs, estimated billed time up to ${formatSeconds(calibrationCost())}. The result is offered for saving into the operator file.`,
      },
      "Create Notebook",
    );
    if (!ok) {
      return;
    }
    let code: string;
    try {
      code = await this.code(node.entry, cal?.calibrationSetId === info?.calibrationSetId ? cal : undefined);
    } catch (e) {
      vscode.window.showErrorMessage(`QaaS: ${(e as Error).message}`);
      return;
    }
    const t = await currentTarget(this.secrets);
    const nb = buildCalibrationNotebook({
      operator: spec.name,
      operatorCode: code,
      project,
      resource: t.resource,
      backend: t.backend,
      qubit,
      resultDirectory: vscode.Uri.joinPath(root, ".qaas", "calibrations").fsPath,
    });
    const uri = vscode.Uri.joinPath(root, ".qaas", "notebooks", `${spec.name}_rabi_${sanitize(qubit)}.ipynb`);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(nb, "utf8"));
    await vscode.window.showNotebookDocument(await vscode.workspace.openNotebookDocument(uri));
  }

  /** Watch for results written by calibration notebooks and offer to save them. */
  watchResults(): vscode.Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher(RESULT_GLOB, false, true, true);
    watcher.onDidCreate(async (uri) => {
      try {
        const data = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8"));
        if (!isCalibrationResult(data)) {
          return;
        }
        const op = this.catalog.byName(data.operator);
        if (!op) {
          vscode.window.showWarningMessage(
            `QaaS: calibration result for unknown operator "${data.operator}" (${uri.fsPath}).`,
          );
          return;
        }
        const v = data.values;
        const choice = await vscode.window.showInformationMessage(
          `QaaS: calibration of ${data.operator} on ${data.locus} for set ${shortId(data.calibrationSetId)}: amplitude_i ${Number(v.amplitude_i).toFixed(5)}. Save it to the operator?`,
          "Save",
          "Open Result",
        );
        if (choice === "Save") {
          const text = await this.catalog.textOf(op.uri);
          await this.catalog.write(op.uri, applyCalibrationResult(text, data));
          vscode.window.showInformationMessage(`QaaS: ${data.operator} updated for ${data.locus}.`);
        } else if (choice === "Open Result") {
          await vscode.window.showTextDocument(uri);
        }
      } catch (e) {
        this.output.appendLine(`[operators] could not read calibration result ${uri.fsPath}: ${(e as Error).message}`);
      }
    });
    return watcher;
  }
}
