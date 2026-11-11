/**
 * Calibrations view: the current calibration set and every set the extension has seen (on jobs,
 * in operator files, from earlier refreshes), with a panel that plots per-qubit quality metrics.
 * HEAppE/QScheduler cannot list calibration sets, so "available" means known IDs; each is fetched
 * by ID and cached in the extension's global storage.
 */

import * as vscode from "vscode";
import type { Bridge } from "./bridge";
import { currentTarget, lexisInstance, type Target } from "./config";
import { buildTable, type CalibrationMetrics, calibrationCsv } from "./core/calibration";
import type { JobStore } from "./jobs";
import type { OperatorCatalog } from "./operators";
import { ensureReady } from "./session";

const KNOWN_KEY = "qaas.calibrationSets";

export interface KnownSet {
  id: string;
  backend: string;
  apiUrl?: string;
  createdAt?: string | null;
  dutLabel?: string | null;
  firstSeen: string;
  /** Last time this set was the backend's current one. */
  lastCurrent?: string;
}

export interface SetUsage {
  jobs: number;
  operators: string[];
}

export class CalibrationStore {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private currentId?: string;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly storage: vscode.Uri,
    private readonly jobs: JobStore,
    private readonly catalog: OperatorCatalog,
  ) {
    jobs.onDidChange(() => this.changed.fire());
    catalog.onDidChange(() => this.changed.fire());
  }

  private scope(): { backend: string; apiUrl?: string } {
    return { backend: "", apiUrl: lexisInstance()?.apiUrl };
  }

  private recorded(): KnownSet[] {
    return this.memento.get<KnownSet[]>(KNOWN_KEY, []);
  }

  current(): string | undefined {
    return this.currentId;
  }

  /** Known sets for a backend: recorded ones, plus IDs on jobs and in operator files. */
  known(backend: string): (KnownSet & { usage: SetUsage; current: boolean })[] {
    const apiUrl = this.scope().apiUrl;
    const byId = new Map<string, KnownSet>();
    for (const k of this.recorded()) {
      if (k.backend === backend && (k.apiUrl ?? "") === (apiUrl ?? "")) {
        byId.set(k.id, k);
      }
    }
    const usage = new Map<string, SetUsage>();
    const use = (id: string) => {
      let u = usage.get(id);
      if (!u) {
        u = { jobs: 0, operators: [] };
        usage.set(id, u);
      }
      return u;
    };
    for (const j of this.jobs.all()) {
      if (!j.calibrationSetId || j.backend !== backend || (j.instance?.apiUrl ?? "") !== (apiUrl ?? "")) {
        continue;
      }
      use(j.calibrationSetId).jobs++;
      if (!byId.has(j.calibrationSetId)) {
        byId.set(j.calibrationSetId, { id: j.calibrationSetId, backend, apiUrl, firstSeen: j.submittedAt });
      }
    }
    for (const entry of this.catalog.all()) {
      for (const cal of entry.spec?.calibrations ?? []) {
        if (!cal.calibrationSetId || /^0{8}-/.test(cal.calibrationSetId)) {
          continue;
        }
        if (cal.backend && cal.backend !== backend) {
          continue;
        }
        const u = use(cal.calibrationSetId);
        if (entry.spec && !u.operators.includes(entry.spec.name)) {
          u.operators.push(entry.spec.name);
        }
        if (!byId.has(cal.calibrationSetId)) {
          byId.set(cal.calibrationSetId, { id: cal.calibrationSetId, backend, apiUrl, firstSeen: cal.updatedAt ?? "" });
        }
      }
    }
    return [...byId.values()]
      .map((k) => ({
        ...k,
        usage: usage.get(k.id) ?? { jobs: 0, operators: [] },
        current: k.id === this.currentId,
      }))
      .sort(
        (a, b) =>
          Number(b.current) - Number(a.current) ||
          (b.createdAt ?? b.firstSeen ?? "").localeCompare(a.createdAt ?? a.firstSeen ?? ""),
      );
  }

  private file(backend: string, id: string): vscode.Uri {
    const host = (lexisInstance()?.apiUrl ?? "production").replace(/^\w+:\/\//, "").replace(/[^\w.-]+/g, "_");
    return vscode.Uri.joinPath(this.storage, "calibrations", host, `${backend.replace(/[^\w.-]+/g, "_")}-${id}.json`);
  }

  async cached(backend: string, id: string): Promise<CalibrationMetrics | undefined> {
    try {
      return JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(this.file(backend, id))).toString("utf8"));
    } catch {
      return undefined;
    }
  }

  /** Save fetched metrics and record the set; returns the previous current ID when it changed. */
  async save(m: CalibrationMetrics, backend: string): Promise<string | undefined> {
    await vscode.workspace.fs.writeFile(this.file(backend, m.calibrationSetId), Buffer.from(JSON.stringify(m), "utf8"));
    const apiUrl = this.scope().apiUrl;
    const list = this.recorded().filter(
      (k) => !(k.id === m.calibrationSetId && k.backend === backend && (k.apiUrl ?? "") === (apiUrl ?? "")),
    );
    const prev = list.find((k) => k.backend === backend && (k.apiUrl ?? "") === (apiUrl ?? "") && k.lastCurrent);
    const previousCurrent = this.currentId ?? prev?.id;
    const now = new Date().toISOString();
    list.push({
      id: m.calibrationSetId,
      backend,
      apiUrl,
      createdAt: m.createdAt,
      dutLabel: m.dutLabel,
      firstSeen: now,
      lastCurrent: m.current ? now : undefined,
    });
    if (m.current) {
      for (const k of list) {
        if (k.id !== m.calibrationSetId && k.backend === backend) {
          k.lastCurrent = undefined;
        }
      }
      this.currentId = m.calibrationSetId;
    }
    await this.memento.update(KNOWN_KEY, list);
    this.changed.fire();
    return m.current && previousCurrent && previousCurrent !== m.calibrationSetId ? previousCurrent : undefined;
  }

  /** Restore the last known current set after a restart. */
  restoreCurrent(backend: string): void {
    const apiUrl = this.scope().apiUrl;
    this.currentId = this.recorded().find(
      (k) => k.backend === backend && (k.apiUrl ?? "") === (apiUrl ?? "") && k.lastCurrent,
    )?.id;
  }
}

type Node =
  | { kind: "set"; set: ReturnType<CalibrationStore["known"]>[number] }
  | { kind: "hint"; text: string; command?: vscode.Command };

export class CalibrationsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private backend = "VLQ";

  constructor(
    private readonly store: CalibrationStore,
    private readonly secrets: vscode.SecretStorage,
  ) {
    store.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.changed.fire();
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node) {
      return [];
    }
    this.backend = (await currentTarget(this.secrets)).backend;
    const sets = this.store.known(this.backend);
    if (sets.length === 0) {
      return [
        {
          kind: "hint",
          text: "Fetch the current calibration set",
          command: { command: "qaas.calibrations.refresh", title: "Fetch" },
        },
      ];
    }
    return sets.map((set) => ({ kind: "set", set }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "hint") {
      const item = new vscode.TreeItem(node.text);
      item.iconPath = new vscode.ThemeIcon("cloud-download");
      item.command = node.command;
      return item;
    }
    const s = node.set;
    const item = new vscode.TreeItem(`${s.id.slice(0, 8)}…`);
    const bits: string[] = [];
    if (s.current) {
      bits.push("current");
    }
    if (s.createdAt) {
      bits.push(new Date(s.createdAt).toLocaleString());
    }
    if (s.usage.jobs) {
      bits.push(`${s.usage.jobs} job${s.usage.jobs === 1 ? "" : "s"}`);
    }
    if (s.usage.operators.length) {
      bits.push(`operators: ${s.usage.operators.join(", ")}`);
    }
    item.description = bits.join(" · ");
    item.iconPath = new vscode.ThemeIcon(s.current ? "star-full" : "history");
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**Calibration set** \`${s.id}\`  \n`);
    md.appendMarkdown(`Backend: ${s.backend}${s.dutLabel ? ` · chip ${s.dutLabel}` : ""}  \n`);
    if (s.createdAt) {
      md.appendMarkdown(`Calibrated: ${new Date(s.createdAt).toLocaleString()}  \n`);
    }
    md.appendMarkdown(
      `Used by: ${s.usage.jobs} job(s)${s.usage.operators.length ? `, operators ${s.usage.operators.join(", ")}` : ""}`,
    );
    item.tooltip = md;
    item.contextValue = s.current ? "calset.current" : "calset";
    item.command = { command: "qaas.calibrations.open", title: "Open", arguments: [node] };
    return item;
  }
}

/** Webview with per-qubit charts, chip diagram and table; one panel per calibration set. */
class CalibrationPanel {
  private readonly panel: vscode.WebviewPanel;
  private compareId?: string;
  private ready = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private metrics: CalibrationMetrics,
    private readonly owner: CalibrationCommands,
    onDispose: () => void,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "qaas.calibration",
      `Calibration ${metrics.calibrationSetId.slice(0, 8)}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "qaas.svg");
    this.panel.onDidDispose(onDispose);
    this.panel.webview.onDidReceiveMessage((msg: { type: string; id?: string | null }) => this.onMessage(msg));
    this.panel.webview.html = this.html();
  }

  get id(): string {
    return this.metrics.calibrationSetId;
  }

  reveal(): void {
    this.panel.reveal();
  }

  /** Compare with another set; applied when the webview is ready, or right away. */
  setCompare(id: string): void {
    this.compareId = id;
    void this.update();
  }

  async update(metrics?: CalibrationMetrics): Promise<void> {
    if (metrics) {
      this.metrics = metrics;
    }
    if (!this.ready) {
      return;
    }
    const compare = this.compareId ? await this.owner.load(this.compareId, false) : undefined;
    const known = (await this.owner.knownSets()).map((k) => ({
      id: k.id,
      label: `${k.id.slice(0, 8)}…${k.current ? " (current)" : ""}${k.createdAt ? ` · ${new Date(k.createdAt).toLocaleDateString()}` : ""}`,
    }));
    const pack = (m: CalibrationMetrics) => ({
      calibrationSetId: m.calibrationSetId,
      dutLabel: m.dutLabel,
      createdAt: m.createdAt,
      invalid: m.invalid,
      backend: m.backend,
      current: m.calibrationSetId === this.owner.currentId(),
      fetchedAt: m.fetchedAt,
      observationCount: m.observations.length,
      table: buildTable(m),
    });
    await this.panel.webview.postMessage({
      type: "data",
      payload: { set: pack(this.metrics), compare: compare ? pack(compare) : null, known },
    });
  }

  private busy(text: string | false): void {
    void this.panel.webview.postMessage({ type: "busy", busy: Boolean(text), text: text || "" });
  }

  private async onMessage(msg: { type: string; id?: string | null }): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.ready = true;
        await this.update();
        break;
      case "compare":
        this.compareId = msg.id || undefined;
        if (this.compareId) {
          this.busy("Loading the compared calibration set…");
        }
        try {
          await this.update();
        } catch (e) {
          this.compareId = undefined;
          vscode.window.showErrorMessage(`QaaS: ${(e as Error).message}`);
          await this.update();
        } finally {
          this.busy(false);
        }
        break;
      case "refresh": {
        this.busy("Fetching…");
        try {
          const fresh = await this.owner.load(this.metrics.current ? undefined : this.id, true);
          if (fresh) {
            await this.update(fresh);
          }
        } finally {
          this.busy(false);
        }
        break;
      }
      case "export":
        await this.owner.exportCsv(this.metrics);
        break;
      case "copy":
        await vscode.env.clipboard.writeText(this.id);
        vscode.window.showInformationMessage(`QaaS: copied calibration set ID ${this.id}.`);
        break;
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "calibration.js"));
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  /* Sequential blue (darker = better), diverging blue/red with grey midpoint, series 1 blue / 2 orange. */
  :root {
    --seq-100:#cde2fb; --seq-200:#9ec5f4; --seq-300:#6da7ec; --seq-400:#3987e5; --seq-500:#256abf; --seq-600:#184f95; --seq-700:#0d366b;
    --div-neg-3:#c43c3b; --div-neg-2:#e07a79; --div-neg-1:#f2b9b8; --div-mid:#f0efec; --div-pos-1:#b7d3f6; --div-pos-2:#6da7ec; --div-pos-3:#256abf;
    --series-1:#2a78d6; --series-2:#eb6834; --ink-on-light:#0b0b0b; --ink-on-dark:#ffffff;
    --edge: var(--vscode-panel-border); --node-empty: var(--vscode-editorWidget-background);
  }
  body.vscode-dark, body.vscode-high-contrast {
    --div-neg-3:#e66767; --div-neg-2:#a94545; --div-neg-1:#6b3636; --div-mid:#383835; --div-pos-1:#1c3f6b; --div-pos-2:#256abf; --div-pos-3:#5598e7;
    --series-1:#3987e5; --series-2:#d95926;
  }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); padding: 0 16px 32px; max-width: 1180px; }
  h2 { font-size: 1.25em; margin: 16px 0 4px; } h3 { font-size: 1.05em; margin: 24px 0 8px; }
  code { font-family: var(--vscode-editor-font-family); }
  .muted { color: var(--vscode-descriptionForeground); } .small { font-size: 11px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 6px 0; }
  .chip { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 1px 8px; }
  .chip.warn { border-color: var(--vscode-editorWarning-foreground); }
  button { font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
    border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  select { font: inherit; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border); padding: 2px 4px; max-width: 360px; }
  #controls { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; margin: 12px 0; }
  #tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; }
  .tile { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left;
    background: var(--vscode-textBlockQuote-background); color: var(--vscode-foreground); padding: 8px 10px; border-radius: 4px;
    border: 1px solid transparent; }
  .tile.selected { border-color: var(--vscode-focusBorder); }
  .tile-label { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .tile-value { font-size: 1.35em; font-variant-numeric: tabular-nums; }
  .panels { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 16px; align-items: start; }
  @media (max-width: 900px) { .panels { grid-template-columns: 1fr; } }
  svg text.axis { fill: var(--vscode-descriptionForeground); font-size: 11px; }
  svg line.grid { stroke: var(--vscode-panel-border); stroke-width: 1; opacity: .6; }
  svg line.median { stroke: var(--vscode-descriptionForeground); stroke-dasharray: 4 4; }
  svg circle.dot { stroke: var(--vscode-editor-background); stroke-width: 2; }
  svg .s1 { fill: var(--series-1); stroke: var(--series-1); } svg .s2 { fill: var(--series-2); stroke: var(--series-2); }
  svg circle.dot.s1, svg circle.dot.s2 { stroke: var(--vscode-editor-background); }
  svg line.whisker { stroke-width: 2; opacity: .55; }
  svg rect.hit { fill: transparent; }
  svg line.edge { stroke-width: 3; stroke-linecap: round; }
  svg circle.node { stroke: var(--vscode-editor-background); stroke-width: 2; }
  svg rect.hub { fill: var(--vscode-textBlockQuote-background); stroke: var(--vscode-panel-border); }
  svg text.node-label { font-size: 11px; fill: var(--vscode-foreground); pointer-events: none; }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; font-size: 11px; margin: 4px 0 0; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; vertical-align: -1px; }
  .swatch.s1 { background: var(--series-1); } .swatch.s2 { background: var(--series-2); }
  .ramp { display: inline-flex; } .ramp i { width: 14px; height: 10px; display: inline-block; }
  .scroll { overflow-x: auto; }
  table.grid-table { border-collapse: separate; border-spacing: 2px; font-size: 11px; font-variant-numeric: tabular-nums; }
  table.grid-table th { font-weight: 600; padding: 2px 6px; white-space: nowrap; text-align: center; }
  table.grid-table th .unit { font-weight: 400; color: var(--vscode-descriptionForeground); }
  table.grid-table th.sortable { cursor: pointer; } table.grid-table th.selected { text-decoration: underline; }
  table.grid-table th.sticky { position: sticky; left: 0; background: var(--vscode-editor-background); text-align: left; }
  table.grid-table td { padding: 3px 6px; text-align: right; border-radius: 3px; min-width: 48px; }
  table.grid-table td.empty { color: var(--vscode-descriptionForeground); text-align: center; }
  table.grid-table tr.foot td { color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }
  table.plain { border-collapse: collapse; font-size: 12px; } table.plain th, table.plain td { padding: 3px 10px; text-align: left;
    border-bottom: 1px solid var(--vscode-panel-border); } table.plain .num { text-align: right; font-variant-numeric: tabular-nums; }
  #tip { position: fixed; z-index: 10; pointer-events: none; background: var(--vscode-editorHoverWidget-background);
    color: var(--vscode-editorHoverWidget-foreground); border: 1px solid var(--vscode-editorHoverWidget-border);
    padding: 6px 8px; border-radius: 3px; font-size: 12px; max-width: 360px; }
  .tip-title { font-weight: 600; margin-bottom: 2px; }
  #loading { padding: 6px 10px; background: var(--vscode-inputValidation-infoBackground); border-radius: 3px; margin: 8px 0; }
</style></head>
<body>
<div id="loading">Loading…</div>
<div id="header"></div>
<div id="controls"></div>
<div id="tiles"></div>
<h3>Per qubit</h3>
<div class="panels"><div id="chart"></div><div id="chip"></div></div>
<h3>All metrics per qubit</h3>
<div id="table"></div>
<div id="others"></div>
<div id="tip" hidden></div>
<script nonce="${nonce}" src="${script}"></script>
</body></html>`;
  }
}

export class CalibrationCommands {
  private readonly panels = new Map<string, CalibrationPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: CalibrationStore,
    private readonly bridge: Bridge,
    private readonly output: vscode.OutputChannel,
  ) {}

  currentId(): string | undefined {
    return this.store.current();
  }

  private async target(): Promise<Target> {
    return currentTarget(this.context.secrets);
  }

  async knownSets() {
    return this.store.known((await this.target()).backend);
  }

  /**
   * Metrics of a calibration set: from the cache unless `force`; the current set (id undefined)
   * is always fetched. Returns undefined when the user cancels the sign-in.
   */
  async load(id: string | undefined, force: boolean): Promise<CalibrationMetrics | undefined> {
    const target = await this.target();
    if (id && !force) {
      const cached = await this.store.cached(target.backend, id);
      if (cached) {
        return cached;
      }
    }
    if (!(await ensureReady(this.bridge, this.context.secrets, this.output))) {
      return undefined;
    }
    const metrics = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: id ? `QaaS: fetching calibration set ${id.slice(0, 8)}…` : "QaaS: fetching the current calibration set…",
        cancellable: true,
      },
      (_p, token) =>
        this.bridge.call<CalibrationMetrics>("calibrationMetrics", target, { calibrationSetId: id ?? null }, token),
    );
    const previous = await this.store.save(metrics, target.backend);
    if (previous) {
      vscode.window
        .showInformationMessage(
          `QaaS: ${target.backend} has a new calibration set (${metrics.calibrationSetId.slice(0, 8)}…, was ${previous.slice(0, 8)}…).`,
          "Compare",
        )
        .then((c) => c && this.open(metrics.calibrationSetId, previous));
    }
    return metrics;
  }

  /** Fetch the current set (used by the view's refresh button and by Synchronize). */
  async refreshCurrent(quiet = false): Promise<CalibrationMetrics | undefined> {
    try {
      const m = await this.load(undefined, true);
      if (m && !quiet) {
        await this.open(m.calibrationSetId);
      }
      return m;
    } catch (e) {
      if (quiet) {
        throw e;
      }
      vscode.window.showErrorMessage(`QaaS: ${(e as Error).message}`);
      return undefined;
    }
  }

  async open(id: string, compareWith?: string): Promise<void> {
    try {
      const existing = this.panels.get(id);
      if (existing) {
        existing.reveal();
        if (compareWith) {
          existing.setCompare(compareWith);
        }
        return;
      }
      const metrics = await this.load(id, false);
      if (!metrics) {
        return;
      }
      const panel = new CalibrationPanel(this.context.extensionUri, metrics, this, () => this.panels.delete(id));
      this.panels.set(id, panel);
      if (compareWith) {
        panel.setCompare(compareWith);
      }
    } catch (e) {
      vscode.window.showErrorMessage(`QaaS: ${(e as Error).message}`);
    }
  }

  async addById(): Promise<void> {
    const id = await vscode.window.showInputBox({
      title: "Open a calibration set by ID",
      prompt: "Calibration set ID (UUID), e.g. from a job or an operator file",
      validateInput: (v) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim())
          ? undefined
          : "Expected a UUID",
      ignoreFocusOut: true,
    });
    if (id) {
      await this.open(id.trim().toLowerCase());
    }
  }

  async exportCsv(m: CalibrationMetrics): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      defaultUri: ws
        ? vscode.Uri.joinPath(ws, "qaas-results", `calibration-${m.calibrationSetId.slice(0, 8)}.csv`)
        : undefined,
      filters: { CSV: ["csv"] },
      saveLabel: "Export Calibration",
    });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(calibrationCsv(m), "utf8"));
    const hasWrangler = Boolean(vscode.extensions.getExtension("ms-toolsai.datawrangler"));
    const choice = await vscode.window.showInformationMessage(
      `QaaS: saved ${vscode.workspace.asRelativePath(target)}.`,
      hasWrangler ? "Open in Data Wrangler" : "Open",
    );
    if (choice === "Open in Data Wrangler") {
      await vscode.commands.executeCommand("vscode.openWith", target, "jupyter-data-wrangler");
    } else if (choice) {
      await vscode.window.showTextDocument(target);
    }
  }

  register(tree: CalibrationsTreeProvider): vscode.Disposable[] {
    const idOf = (node?: { kind: string; set?: { id: string } }) => node?.set?.id;
    void this.target().then((t) => this.store.restoreCurrent(t.backend));
    return [
      vscode.commands.registerCommand("qaas.calibrations.refresh", () => this.refreshCurrent()),
      vscode.commands.registerCommand("qaas.calibrations.add", () => this.addById()),
      vscode.commands.registerCommand("qaas.calibrations.open", (node) => {
        const id = idOf(node);
        return id ? this.open(id) : this.refreshCurrent();
      }),
      vscode.commands.registerCommand("qaas.calibrations.copyId", async (node) => {
        const id = idOf(node);
        if (id) {
          await vscode.env.clipboard.writeText(id);
          vscode.window.showInformationMessage(`QaaS: copied calibration set ID ${id}.`);
        }
      }),
      vscode.commands.registerCommand("qaas.calibrations.export", async (node) => {
        const id = idOf(node);
        const m = id ? await this.load(id, false) : undefined;
        if (m) {
          await this.exportCsv(m);
        }
      }),
      vscode.commands.registerCommand("qaas.calibrations.reload", async (node) => {
        const id = idOf(node);
        if (id) {
          await this.load(id === this.currentId() ? undefined : id, true);
          tree.refresh();
        }
      }),
    ];
  }
}
