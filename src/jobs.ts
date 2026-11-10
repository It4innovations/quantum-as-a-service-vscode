import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Bridge } from "./bridge";
import { cfg, currentTarget, expandPath, sanitize, type Target, TOKEN_KEY } from "./config";
import { formatSeconds } from "./core/estimate";
import { showResultsPanel } from "./resultsPanel";

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
  origin: "extension" | "imported";
}

const STORE_KEY = "qaas.jobs";
const key = (r: { project: string; jobId: string }) => `${r.project}:${r.jobId}`;

/** Job history in globalState, so it survives restarts and is shared across workspaces. */
export class JobStore {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly memento: vscode.Memento) {}

  all(): JobRecord[] {
    return [...this.memento.get<JobRecord[]>(STORE_KEY, [])].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  }

  get(project: string, jobId: string): JobRecord | undefined {
    return this.all().find((r) => key(r) === key({ project, jobId }));
  }

  async upsert(rec: JobRecord): Promise<void> {
    const map = new Map(this.all().map((r) => [key(r), r]));
    map.set(key(rec), { ...map.get(key(rec)), ...rec });
    await this.save([...map.values()]);
  }

  async update(rec: JobRecord, patch: Partial<JobRecord>): Promise<JobRecord> {
    const next = { ...(this.get(rec.project, rec.jobId) ?? rec), ...patch, updatedAt: new Date().toISOString() };
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

export class JobsTreeProvider implements vscode.TreeDataProvider<JobRecord> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly store: JobStore) {
    store.onDidChange(() => this.changed.fire());
  }

  getChildren(element?: JobRecord): JobRecord[] {
    return element ? [] : this.store.all();
  }

  getTreeItem(r: JobRecord): vscode.TreeItem {
    const item = new vscode.TreeItem(r.name || `Job ${r.jobId}`);
    item.id = key(r);
    item.description = `${r.state.toLowerCase()} · #${r.jobId} · ${r.backend || "?"}`;
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

export class JobManager implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(
    private readonly store: JobStore,
    private readonly bridge: Bridge,
    private readonly secrets: vscode.SecretStorage,
    private readonly output: vscode.OutputChannel,
  ) {
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

  private async targetFor(r: JobRecord): Promise<Target> {
    return {
      project: r.project,
      resource: r.resource,
      backend: r.backend,
      token: (await this.secrets.get(TOKEN_KEY)) || undefined,
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
    const active = this.store.all().filter((r) => !TERMINAL.has(r.state));
    if (active.length === 0) {
      return;
    }
    if (!userInitiated && !this.bridge.authenticated && !(await this.secrets.get(TOKEN_KEY))) {
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

  async download(r: JobRecord, directory = this.defaultDirectory(r)): Promise<JobRecord | undefined> {
    try {
      const res = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `QaaS: downloading results of #${r.jobId}…`,
          cancellable: true,
        },
        async (_p, token) =>
          this.bridge.call<DownloadResult>(
            "download",
            await this.targetFor(r),
            { jobId: r.jobId, shots: r.shots, directory, withMeasurements: cfg().get<boolean>("downloadMeasurements") },
            token,
          ),
      );
      const next = await this.store.update(r, { downloadedTo: res.directory, state: "FINISHED" });
      const choice = await vscode.window.showInformationMessage(
        `QaaS: results saved to ${res.directory}`,
        "Show Results",
        "Reveal Folder",
      );
      if (choice === "Show Results") {
        showResultsPanel(next, res.counts);
      } else if (choice === "Reveal Folder") {
        void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(path.join(res.directory, "counts.json")));
      }
      return next;
    } catch (e) {
      vscode.window.showErrorMessage(`QaaS: download of #${r.jobId} failed: ${(e as Error).message}`);
      return undefined;
    }
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
        showResultsPanel(r, JSON.parse(text));
        return;
      } catch {
        // file moved or deleted: download again
      }
    }
    await this.download(r);
  }

  async cancel(r: JobRecord): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      `Cancel job "${r.name}" (#${r.jobId})?`,
      { modal: true },
      "Cancel Job",
    );
    if (!ok) {
      return;
    }
    try {
      await this.bridge.call("cancel", await this.targetFor(r), { jobId: r.jobId, shots: r.shots });
      await this.store.update(r, { state: "CANCELED" });
    } catch (e) {
      vscode.window.showErrorMessage(`QaaS: cancel failed: ${(e as Error).message}`);
    }
  }

  /** Pull the user's job list from HEAppE, e.g. jobs submitted from scripts or notebooks. */
  async importFromHeappe(): Promise<void> {
    const target = await currentTarget(this.secrets);
    if (!target.project) {
      vscode.window.showWarningMessage("QaaS: set qaas.lexisProject first.");
      return;
    }
    try {
      const jobs = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "QaaS: importing jobs from HEAppE…",
          cancellable: true,
        },
        (_p, token) =>
          this.bridge.call<{ jobId: string; name?: string; state: string; createdAt?: string; tasks: number }[]>(
            "listJobs",
            target,
            { limit: cfg().get<number>("importJobLimit") ?? 50 },
            token,
          ),
      );
      let added = 0;
      for (const j of jobs) {
        const existing = this.store.get(target.project, j.jobId);
        if (existing) {
          if (existing.state !== j.state) {
            await this.store.update(existing, { state: j.state });
          }
          continue;
        }
        added++;
        await this.store.upsert({
          jobId: j.jobId,
          name: j.name || `Job ${j.jobId}`,
          project: target.project,
          resource: target.resource,
          backend: target.backend,
          state: j.state,
          circuits: j.tasks || undefined,
          submittedAt: j.createdAt ? new Date(j.createdAt).toISOString() : new Date(0).toISOString(),
          origin: "imported",
        });
      }
      vscode.window.showInformationMessage(`QaaS: ${jobs.length} jobs found on HEAppE, ${added} new.`);
    } catch (e) {
      vscode.window.showErrorMessage(`QaaS: import failed: ${(e as Error).message}`);
    }
  }
}
