import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { Analysis } from "./analysis";
import type { Bridge } from "./bridge";
import {
  cfg,
  currentTarget,
  expandPath,
  lexisInstance,
  lexisToken,
  requireProject,
  sanitize,
  type Target,
} from "./config";
import { instanceLabel, type LexisInstance } from "./core/devEnv";
import { formatSeconds } from "./core/estimate";
import type { Counts } from "./core/stats";
import { ResultsPanel } from "./resultsPanel";
import { ensureReady } from "./session";

export const TERMINAL = new Set(["FINISHED", "FAILED", "CANCELED", "CANCELLED"]);

export interface JobRecord {
  jobId: string;
  name: string;
  project: string;
  resource: string;
  backend: string;
  state: string;
  submittedAt: string;
  updatedAt?: string;
  shots?: number;
  circuits?: number;
  calibrationSetId?: string;
  /** File the job was submitted from. */
  source?: string;
  /** Billed-time estimate in seconds at submission. */
  estimate?: { low: number; high: number };
  downloadedTo?: string;
  /** OpenQASM sources as submitted (kept when small), for ideal simulation and re-runs. */
  qasmSources?: string[];
  /** circuit: gate-level job; pulse: compiled with catalog operators through QPulla. */
  kind?: "circuit" | "pulse";
  operators?: { name: string; gate: string; calibrationSetId: string; status: string }[];
  /** Operator specs, values and gate mapping of a pulse job; needed to map its raw results to bits. */
  pulsePayload?: { operators: { spec: object; loci: object }[]; use: Record<string, string> };
  origin: "extension" | "imported";
  /** LEXIS instance the job was submitted to; undefined for production. */
  instance?: LexisInstance;
  /**
   * "foreign": another user's job that HEAppE lists because the signed-in user is a Manager or
   * Administrator somewhere; its details and results are not accessible (HTTP 403).
   */
  access?: "own" | "foreign";
}

/** Group node of the Jobs view. */
export interface JobGroup {
  group: "own" | "foreign";
  resource?: string;
}
export type JobNode = JobRecord | JobGroup;
export const isJob = (n: unknown): n is JobRecord => typeof n === "object" && n !== null && "jobId" in n;
export const isForeign = (r: JobRecord) => r.access === "foreign";

/** HEAppE times have no zone and are UTC. */
function heappeTime(t?: string): string {
  if (!t) {
    return new Date(0).toISOString();
  }
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

const STORE_KEY = "qaas.jobs";
const key = (r: { project: string; jobId: string; instance?: LexisInstance }) =>
  `${r.instance?.apiUrl ? `${r.instance.apiUrl}|` : ""}${r.project}:${r.jobId}`;
const sameInstance = (a?: LexisInstance, b?: LexisInstance) =>
  (a?.aaiUrl ?? "") === (b?.aaiUrl ?? "") &&
  (a?.apiUrl ?? "") === (b?.apiUrl ?? "") &&
  (a?.realm ?? "") === (b?.realm ?? "");

/** Job history in globalState, so it survives restarts and is shared across workspaces. */
export class JobStore {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly memento: vscode.Memento) {}

  all(): JobRecord[] {
    return [...this.memento.get<JobRecord[]>(STORE_KEY, [])].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  }

  get(project: string, jobId: string, instance?: LexisInstance): JobRecord | undefined {
    return this.all().find((r) => key(r) === key({ project, jobId, instance }));
  }

  async upsert(rec: JobRecord): Promise<void> {
    const map = new Map(this.all().map((r) => [key(r), r]));
    map.set(key(rec), { ...map.get(key(rec)), ...rec });
    await this.save([...map.values()]);
  }

  async update(rec: JobRecord, patch: Partial<JobRecord>): Promise<JobRecord> {
    const next = {
      ...(this.get(rec.project, rec.jobId, rec.instance) ?? rec),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.upsert(next);
    return next;
  }

  async remove(recs: JobRecord[]): Promise<void> {
    const drop = new Set(recs.map(key));
    await this.save(this.all().filter((r) => !drop.has(key(r))));
  }

  private async save(list: JobRecord[]): Promise<void> {
    await this.memento.update(STORE_KEY, list);
    this.changed.fire();
  }
}

function stateIcon(state: string): vscode.ThemeIcon {
  switch (state) {
    case "FINISHED":
      return new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"));
    case "FAILED":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
    case "CANCELED":
    case "CANCELLED":
      return new vscode.ThemeIcon("circle-slash");
    case "RUNNING":
      return new vscode.ThemeIcon("sync~spin");
    default:
      return new vscode.ThemeIcon("clock");
  }
}

export class JobsTreeProvider implements vscode.TreeDataProvider<JobNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly store: JobStore) {
    store.onDidChange(() => this.changed.fire());
  }

  getChildren(element?: JobNode): JobNode[] {
    const all = this.store.all();
    const own = all.filter((r) => !isForeign(r));
    const foreign = all.filter(isForeign);
    if (!element) {
      // Only split into groups when there is something to separate.
      return foreign.length ? [{ group: "own" }, { group: "foreign" }] : own;
    }
    if (isJob(element)) {
      return [];
    }
    if (element.group === "own") {
      return own;
    }
    if (element.resource !== undefined) {
      return foreign.filter((r) => (r.resource || "") === element.resource);
    }
    const resources = [...new Set(foreign.map((r) => r.resource || ""))].sort();
    return resources.length > 1 ? resources.map((resource) => ({ group: "foreign", resource })) : foreign;
  }

  getTreeItem(node: JobNode): vscode.TreeItem {
    if (!isJob(node)) {
      return this.groupItem(node);
    }
    const r = node;
    if (isForeign(r)) {
      return this.foreignItem(r);
    }
    const item = new vscode.TreeItem(r.name || `Job ${r.jobId}`);
    item.id = key(r);
    item.description = `${r.state.toLowerCase()} · #${r.jobId} · ${r.resource || r.backend || "?"}${r.kind === "pulse" ? " · pulse" : ""}${
      r.instance ? ` · LEXIS ${instanceLabel(r.instance)}` : ""
    }`;
    item.iconPath = stateIcon(r.state);
    const done = TERMINAL.has(r.state);
    item.contextValue = [
      "job",
      done ? "terminal" : "active",
      r.state === "FINISHED" ? "finished" : "",
      r.downloadedTo ? "downloaded" : "",
    ]
      .filter(Boolean)
      .join(".");
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${r.name || "Job"}** — ${r.state}\n\n`);
    const rows: [string, string | undefined][] = [
      ["HEAppE job", r.jobId],
      ["LEXIS", r.instance ? (r.instance.apiUrl ?? r.instance.aaiUrl) : undefined],
      ["Project", r.project],
      ["Resource", r.resource || "(auto)"],
      ["Backend", r.backend],
      ["Shots", r.shots?.toLocaleString()],
      ["Circuits", r.circuits?.toString()],
      [
        "Estimated billed",
        r.estimate ? `${formatSeconds(r.estimate.low)} – ${formatSeconds(r.estimate.high)}` : undefined,
      ],
      ["Calibration set", r.calibrationSetId],
      ["Pulse operators", r.operators?.map((o) => `${o.gate}=${o.name} (${o.status})`).join(", ")],
      ["Submitted", new Date(r.submittedAt).toLocaleString()],
      ["Source", r.source],
      ["Results", r.downloadedTo],
    ];
    for (const [k, v] of rows) {
      if (v) {
        md.appendMarkdown(`${k}: \`${v}\`  \n`);
      }
    }
    item.tooltip = md;
    if (r.state === "FINISHED") {
      item.command = { command: "qaas.jobs.showResults", title: "Show Results", arguments: [r] };
    }
    return item;
  }

  private groupItem(g: JobGroup): vscode.TreeItem {
    const all = this.store.all();
    const members = all.filter((r) =>
      g.group === "own"
        ? !isForeign(r)
        : isForeign(r) && (g.resource === undefined || (r.resource || "") === g.resource),
    );
    const label =
      g.group === "own"
        ? "Own and accessible"
        : g.resource !== undefined
          ? g.resource || "Unknown resource"
          : "Other users' jobs (no access)";
    const item = new vscode.TreeItem(
      label,
      g.group === "own" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `group:${g.group}:${g.resource ?? ""}`;
    item.description = `${members.length}`;
    item.iconPath = new vscode.ThemeIcon(
      g.group === "own" ? "account" : g.resource !== undefined ? "server-environment" : "lock",
    );
    item.tooltip = groupTooltip(g);
    item.contextValue = g.group === "foreign" && g.resource === undefined ? "jobGroupForeign" : "jobGroup";
    return item;
  }

  /** Another user's job: identification only, no actions. */
  private foreignItem(r: JobRecord): vscode.TreeItem {
    const item = new vscode.TreeItem(r.name || `Job ${r.jobId}`);
    item.id = `foreign:${key(r)}`;
    item.description = `${r.state.toLowerCase()} · #${r.jobId} · ${r.resource || "?"}`;
    item.iconPath = new vscode.ThemeIcon("lock", new vscode.ThemeColor("disabledForeground"));
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${r.name || "Job"}** — ${r.state} (as last listed by HEAppE)\n\n`);
    md.appendMarkdown(`HEAppE job: \`${r.jobId}\`  \nResource: \`${r.resource || "?"}\`  \n`);
    md.appendMarkdown(`Listed: ${new Date(r.submittedAt).toLocaleString()}\n\n`);
    md.appendMarkdown(
      "Submitted by another user. HEAppE lists it because you are a Manager or Administrator in a HEAppE project, " +
        "but only the submitter or an Administrator of its project can read its status and results.",
    );
    item.tooltip = md;
    item.contextValue = "foreignJob";
    return item;
  }
}

interface JobInfo {
  state: string;
  name?: string;
  tasks: number;
}

interface DownloadResult {
  directory: string;
  counts: Record<string, number>[];
}

function groupTooltip(g: JobGroup): string {
  return g.group === "own"
    ? "Jobs you submitted (or imported as yours): status, results and downloads are available."
    : "Jobs of other users that HEAppE lists because you are a Manager or Administrator in a HEAppE project. " +
        "HEAppE allows only the submitter or a project Administrator to read them, so status updates and results are not available.";
}

export class JobManager implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  readonly analysis: Analysis;
  private polling = false;

  constructor(
    private readonly store: JobStore,
    private readonly bridge: Bridge,
    private readonly secrets: vscode.SecretStorage,
    private readonly output: vscode.OutputChannel,
  ) {
    this.analysis = new Analysis(bridge, store);
    this.schedule();
  }

  schedule(): void {
    clearInterval(this.timer);
    const seconds = Math.max(5, cfg().get<number>("jobPollSeconds") ?? 20);
    this.timer = setInterval(() => void this.poll(false), seconds * 1000);
  }

  dispose(): void {
    clearInterval(this.timer);
  }

  /** Target of a stored job. The current token is used only if it belongs to the job's LEXIS instance. */
  private async targetFor(r: JobRecord): Promise<Target> {
    return {
      project: r.project,
      resource: r.resource,
      backend: r.backend,
      token: sameInstance(r.instance, lexisInstance()) ? await lexisToken(this.secrets) : undefined,
      instance: r.instance,
    };
  }

  /**
   * Refresh active jobs. Background polls only run when no browser login can pop up
   * (a token is stored or this session already logged in).
   */
  async poll(userInitiated: boolean): Promise<void> {
    if (this.polling) {
      return;
    }
    const active = this.store.all().filter((r) => !TERMINAL.has(r.state) && !isForeign(r));
    if (active.length === 0) {
      return;
    }
    if (!userInitiated && !this.bridge.authenticated && !(await lexisToken(this.secrets))) {
      return;
    }
    if (userInitiated && !(await ensureReady(this.bridge, this.secrets, this.output))) {
      return;
    }
    this.polling = true;
    try {
      for (const r of active) {
        try {
          const info = await this.bridge.call<JobInfo>("jobInfo", await this.targetFor(r), { jobId: r.jobId });
          if (info.state !== r.state) {
            const next = await this.store.update(r, { state: info.state });
            if (TERMINAL.has(info.state)) {
              void this.onFinished(next);
            }
          }
        } catch (e) {
          this.output.appendLine(`[jobs] status of ${r.jobId} failed: ${(e as Error).message}`);
          if (await this.markForeignIfDenied(r, e)) {
            continue;
          }
          if (userInitiated) {
            vscode.window.showErrorMessage(`QaaS: could not refresh job ${r.jobId}: ${(e as Error).message}`);
            break;
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async onFinished(r: JobRecord): Promise<void> {
    if (r.state === "FINISHED" && cfg().get<boolean>("autoDownloadResults")) {
      await this.download(r);
      return;
    }
    const actions = r.state === "FINISHED" ? ["Show Results", "Download To…"] : [];
    const choice = await vscode.window.showInformationMessage(
      `QaaS: job "${r.name}" (#${r.jobId}) ${r.state.toLowerCase()}.`,
      ...actions,
    );
    if (choice === "Show Results") {
      await this.showResults(r);
    } else if (choice === "Download To…") {
      await this.downloadTo([r]);
    }
  }

  async track(r: JobRecord): Promise<void> {
    await this.store.upsert(r);
    void vscode.commands.executeCommand("qaas.jobs.focus");
  }

  defaultDirectory(r: JobRecord): string {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code-style variables, expanded by expandPath
    const template = cfg().get<string>("resultsDirectory") || "${workspaceFolder}/qaas-results/${jobId}-${jobName}";
    return expandPath(template, { jobId: r.jobId, jobName: sanitize(r.name || "job"), project: sanitize(r.project) });
  }

  /** Download results; with openAfter the results view opens directly instead of a notification. */
  async download(
    r: JobRecord,
    directory = this.defaultDirectory(r),
    openAfter = false,
  ): Promise<JobRecord | undefined> {
    if (!(await ensureReady(this.bridge, this.secrets, this.output))) {
      return undefined;
    }
    try {
      const res = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `QaaS: downloading results of #${r.jobId}…`,
          cancellable: true,
        },
        async (_p, token) =>
          this.bridge.call<DownloadResult>(
            r.kind === "pulse" ? "downloadPulse" : "download",
            await this.targetFor(r),
            {
              jobId: r.jobId,
              shots: r.shots,
              directory,
              withMeasurements: cfg().get<boolean>("downloadMeasurements"),
              ...(r.kind === "pulse" ? { sources: r.qasmSources, ...r.pulsePayload } : {}),
            },
            token,
          ),
      );
      const next = await this.store.update(r, { downloadedTo: res.directory, state: "FINISHED" });
      try {
        await this.analysis.writeExports(next, res.counts);
      } catch (e) {
        this.output.appendLine(`[jobs] CSV export for ${r.jobId} failed: ${(e as Error).message}`);
      }
      if (openAfter) {
        this.openResults(next, res.counts);
        return next;
      }
      const choice = await vscode.window.showInformationMessage(
        `QaaS: results saved to ${res.directory}`,
        "Show Results",
        "Reveal Folder",
      );
      if (choice === "Show Results") {
        this.openResults(next, res.counts);
      } else if (choice === "Reveal Folder") {
        void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(path.join(res.directory, "counts.json")));
      }
      return next;
    } catch (e) {
      if (await this.markForeignIfDenied(r, e)) {
        vscode.window.showWarningMessage(
          `QaaS: job #${r.jobId} belongs to another user; HEAppE does not give access to its results. It was moved to "Other users' jobs".`,
        );
        return undefined;
      }
      vscode.window.showErrorMessage(`QaaS: download of #${r.jobId} failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** HEAppE's 403 on a job means it is another user's: move it to the no-access group. */
  private async markForeignIfDenied(r: JobRecord, e: unknown): Promise<boolean> {
    if (r.origin !== "imported" || !/HTTP 403/.test((e as Error)?.message ?? "")) {
      return false;
    }
    await this.store.update(r, { access: "foreign" });
    return true;
  }

  openResults(r: JobRecord, counts: Counts[]): void {
    ResultsPanel.show(r, counts, this.analysis);
  }

  async downloadTo(recs: JobRecord[]): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      openLabel: "Download Here",
      title: "Folder for job results",
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (!picked?.[0]) {
      return;
    }
    for (const r of recs) {
      await this.download(r, path.join(picked[0].fsPath, `${r.jobId}-${sanitize(r.name || "job")}`));
    }
  }

  async showResults(r: JobRecord): Promise<void> {
    if (r.downloadedTo) {
      try {
        const text = await fs.readFile(path.join(r.downloadedTo, "counts.json"), "utf8");
        this.openResults(r, JSON.parse(text));
        return;
      } catch {
        // file moved or deleted: download again
      }
    }
    await this.download(r, undefined, true);
  }

  async cancel(r: JobRecord): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      `Cancel job "${r.name}" (#${r.jobId})?`,
      { modal: true },
      "Cancel Job",
    );
    if (!ok || !(await ensureReady(this.bridge, this.secrets, this.output))) {
      return;
    }
    try {
      await this.bridge.call("cancel", await this.targetFor(r), { jobId: r.jobId, shots: r.shots });
      // HEAppE accepted the request; the job may still finish first, so read the real state.
      vscode.window.showInformationMessage(`QaaS: cancellation of #${r.jobId} requested.`);
      await this.poll(true);
    } catch (e) {
      vscode.window.showErrorMessage(`QaaS: cancel failed: ${(e as Error).message}`);
    }
  }

  /** Pull the user's job list from HEAppE, e.g. jobs submitted from scripts or notebooks. */
  async importFromHeappe(
    opts: { quiet?: boolean } = {},
  ): Promise<{ found: number; added: number; foreign: number } | undefined> {
    if (!(await requireProject()) || !(await ensureReady(this.bridge, this.secrets, this.output))) {
      return undefined;
    }
    const target = await currentTarget(this.secrets);
    try {
      const jobs = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "QaaS: importing jobs from HEAppE…",
          cancellable: true,
        },
        (_p, token) =>
          this.bridge.call<
            {
              jobId: string;
              name?: string;
              state: string;
              createdAt?: string;
              tasks: number;
              resource?: string | null;
              own: boolean;
            }[]
          >("listJobs", target, { limit: cfg().get<number>("importJobLimit") ?? 50 }, token),
      );
      let added = 0;
      for (const j of jobs) {
        const access = j.own ? "own" : "foreign";
        const existing = this.store.get(target.project, j.jobId, target.instance);
        if (existing) {
          const patch: Partial<JobRecord> = {};
          if (existing.state !== j.state) {
            patch.state = j.state;
          }
          if ((existing.access ?? "own") !== access) {
            patch.access = access;
          }
          if (j.resource && existing.resource !== j.resource) {
            patch.resource = j.resource;
          }
          if (Object.keys(patch).length) {
            await this.store.update(existing, patch);
          }
          continue;
        }
        added++;
        await this.store.upsert({
          jobId: j.jobId,
          name: j.name || `Job ${j.jobId}`,
          project: target.project,
          resource: j.resource || target.resource,
          backend: target.backend,
          instance: target.instance,
          state: j.state,
          circuits: j.tasks || undefined,
          submittedAt: heappeTime(j.createdAt),
          origin: "imported",
          access,
        });
      }
      const foreign = jobs.filter((j) => !j.own).length;
      if (!opts.quiet) {
        vscode.window.showInformationMessage(
          `QaaS: ${jobs.length - foreign} own jobs found on HEAppE, ${added} new${
            foreign ? `; ${foreign} other users' jobs listed without access` : ""
          }.`,
        );
      }
      return { found: jobs.length - foreign, added, foreign };
    } catch (e) {
      if (opts.quiet) {
        throw e;
      }
      vscode.window.showErrorMessage(`QaaS: import failed: ${(e as Error).message}`);
      return undefined;
    }
  }
}
