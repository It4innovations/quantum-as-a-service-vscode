/**
 * Panel for one script run (Run Python File on QPU, WebAssembly runtime): the jobs the script
 * submitted, their live state and their results. Opens when the script submits its first job;
 * the jobs are also in the Jobs view. Finished jobs' results are fetched into the usual results
 * folder and summarised here.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { cfg, type Target } from "./config";
import { nonce as makeNonce } from "./core/nonce";
import type { Counts } from "./core/stats";
import { type JobManager, type JobRecord, type JobStore, TERMINAL } from "./jobs";
import type { ScriptJob } from "./wasm/protocol";

interface Row {
  key: string;
  jobId: string;
  name: string;
  kind: string;
  shots: string;
  state: string;
  terminal: boolean;
  submitted: string;
  results: string;
  canShow: boolean;
  problem?: string;
}

export class ScriptRunPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly keys: { project: string; jobId: string; instance?: JobRecord["instance"] }[] = [];
  private readonly fetching = new Set<string>();
  private readonly summaries = new Map<string, string>();
  private status = "running";
  private readonly started = new Date();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly file: string,
    private readonly target: Target,
    private readonly store: JobStore,
    private readonly jobs: JobManager,
  ) {
    this.disposables.push(store.onDidChange(() => this.update()));
  }

  /** A job the script submitted: track it and show the panel. */
  async addJob(job: ScriptJob): Promise<void> {
    const source = vscode.workspace.asRelativePath(this.file);
    const rec = await this.jobs.trackScriptJob(job, this.target, source);
    this.keys.push({ project: rec.project, jobId: rec.jobId, instance: rec.instance });
    this.show();
    this.update();
  }

  /** The script ended: show how, and read the jobs' states once. */
  finished(code: number, how: string): void {
    this.status = how === "exited" ? `finished (exit code ${code})` : how;
    this.update();
    if (this.keys.length) {
      void this.jobs.poll(false);
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.panel?.dispose();
  }

  private records(): JobRecord[] {
    return this.keys
      .map((k) => this.store.get(k.project, k.jobId, k.instance))
      .filter((r): r is JobRecord => r !== undefined);
  }

  private show(): void {
    if (this.panel) {
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      "qaas.scriptRun",
      `QaaS run: ${path.basename(this.file)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.panel.webview.onDidReceiveMessage(async (msg: { type: string; jobId?: string }) => {
      const rec = this.records().find((r) => r.jobId === msg.jobId);
      if (msg.type === "refresh") {
        await this.jobs.poll(true);
      } else if (msg.type === "jobsView") {
        await vscode.commands.executeCommand("qaas.jobs.focus");
      } else if (msg.type === "results" && rec) {
        await this.jobs.showResults(rec);
      } else if (msg.type === "cancel" && rec) {
        await this.jobs.cancel(rec);
      } else if (msg.type === "ready") {
        this.update();
      }
    });
  }

  private update(): void {
    if (!this.panel) {
      return;
    }
    const recs = this.records();
    for (const r of recs) {
      this.fetchWhenFinished(r);
    }
    void Promise.all(recs.map((r) => this.row(r))).then((rows) =>
      this.panel?.webview.postMessage({
        type: "rows",
        status: this.status,
        autoRefresh: cfg().get<boolean>("autoRefreshJobs", true),
        rows,
      }),
    );
  }

  /** Results of a finished job, fetched once into the results folder (no notification). */
  private fetchWhenFinished(r: JobRecord): void {
    const id = `${r.project}|${r.jobId}`;
    if (r.state !== "FINISHED" || r.downloadedTo || r.problem || this.fetching.has(id)) {
      return;
    }
    this.fetching.add(id);
    void this.jobs.download(r, undefined, false, true);
  }

  private async row(r: JobRecord): Promise<Row> {
    return {
      key: `${r.project}|${r.jobId}`,
      jobId: r.jobId,
      name: r.name,
      kind: r.kind === "pulse" ? "pulse-level" : "circuit",
      shots: [r.shots ? `${r.shots.toLocaleString()} shots` : "", r.circuits ? `${r.circuits} circuit(s)` : ""]
        .filter(Boolean)
        .join(" × "),
      state: r.state,
      terminal: TERMINAL.has(r.state),
      submitted: new Date(r.submittedAt).toLocaleTimeString(),
      results: await this.summary(r),
      canShow: r.state === "FINISHED",
      problem: r.problem?.message,
    };
  }

  /** "00: 511 (50%) · 11: 447 (44%) · …" for the first circuit (and how many more). */
  private async summary(r: JobRecord): Promise<string> {
    if (!r.downloadedTo) {
      return r.state === "FINISHED" ? (r.problem ? "" : "fetching…") : "";
    }
    const cached = this.summaries.get(r.downloadedTo);
    if (cached) {
      return cached;
    }
    try {
      const counts = JSON.parse(await fs.readFile(path.join(r.downloadedTo, "counts.json"), "utf8")) as Counts[];
      const first = counts[0] ?? {};
      const total = Object.values(first).reduce((a, b) => a + b, 0) || 1;
      const top = Object.entries(first)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `${k}: ${v} (${Math.round((100 * v) / total)}%)`)
        .join(" · ");
      const text = `${top}${Object.keys(first).length > 4 ? " · …" : ""}${
        counts.length > 1 ? ` (circuit 1 of ${counts.length})` : ""
      }`;
      this.summaries.set(r.downloadedTo, text);
      return text;
    } catch {
      return "results folder not readable";
    }
  }

  private html(): string {
    const nonce = makeNonce();
    const csp = this.panel?.webview.cspSource ?? "";
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 12px 16px; }
  .head { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; margin-bottom: 10px; }
  .muted { color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { font-weight: 600; color: var(--vscode-descriptionForeground); font-size: 11px; text-transform: uppercase; }
  .state { font-weight: 600; }
  .FINISHED { color: var(--vscode-testing-iconPassed); } .FAILED, .DELETED { color: var(--vscode-testing-iconFailed); }
  .CANCELED, .CANCELLED { color: var(--vscode-descriptionForeground); }
  .active { color: var(--vscode-charts-blue); }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none;
    padding: 2px 8px; border-radius: 2px; cursor: pointer; margin-right: 4px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .problem { color: var(--vscode-errorForeground); font-size: 11px; }
  code { font-family: var(--vscode-editor-font-family); }
</style></head><body>
<div class="head">
  <strong>${path.basename(this.file).replace(/</g, "&lt;")}</strong>
  <span class="muted">started ${this.started.toLocaleTimeString()}</span>
  <span id="status" class="muted"></span>
  <span style="flex:1"></span>
  <span id="auto" class="muted"></span>
  <button id="refresh">Refresh</button><button id="jobsView">Jobs View</button>
</div>
<table><thead><tr><th>Job</th><th>Name</th><th>Kind</th><th>Shots</th><th>State</th><th>Submitted</th><th>Results</th><th></th></tr></thead>
<tbody id="rows"><tr><td colspan="8" class="muted">No jobs submitted yet.</td></tr></tbody></table>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const cell = (text, cls) => { const td = document.createElement("td"); td.textContent = text; if (cls) td.className = cls; return td; };
const button = (label, type, jobId) => { const b = document.createElement("button"); b.textContent = label;
  b.addEventListener("click", () => vscode.postMessage({ type, jobId })); return b; };
$("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
$("jobsView").addEventListener("click", () => vscode.postMessage({ type: "jobsView" }));
window.addEventListener("message", (ev) => {
  const m = ev.data;
  if (m.type !== "rows") return;
  $("status").textContent = "· " + m.status;
  $("auto").textContent = m.autoRefresh ? "states refresh automatically" : "automatic refresh is off";
  const body = $("rows");
  body.replaceChildren();
  if (!m.rows.length) { const tr = document.createElement("tr"); tr.append(cell("No jobs submitted yet.", "muted")); body.append(tr); return; }
  for (const r of m.rows) {
    const tr = document.createElement("tr");
    const id = cell("#" + r.jobId); id.style.fontFamily = "var(--vscode-editor-font-family)";
    const results = cell(r.results);
    if (r.problem) { const p = document.createElement("div"); p.className = "problem"; p.textContent = r.problem; results.append(p); }
    const actions = document.createElement("td");
    if (r.canShow) actions.append(button("Results", "results", r.jobId));
    if (!r.terminal) actions.append(button("Cancel", "cancel", r.jobId));
    tr.append(id, cell(r.name), cell(r.kind), cell(r.shots), cell(r.state, "state " + (r.terminal ? r.state : "active")),
      cell(r.submitted, "muted"), results, actions);
    body.append(tr);
  }
});
vscode.postMessage({ type: "ready" });
</script></body></html>`;
  }
}
