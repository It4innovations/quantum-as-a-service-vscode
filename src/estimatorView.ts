import * as path from "node:path";
import * as vscode from "vscode";
import { cfg } from "./config";
import { estimate, formatRange, formatSeconds, VLQ_BILLING } from "./core/estimate";
import { describeCall, detectCalls, isQasm } from "./estimateLens";

export interface EstimatorPreset {
  shots?: number;
  circuits?: number;
  submissions?: number;
}

/** Sidebar calculator for VLQ billed time, plus the submissions found in the active editor. */
export class EstimatorViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "qaas.estimator";
  private view?: vscode.WebviewView;
  private pendingPreset?: EstimatorPreset;
  private readonly disposables: vscode.Disposable[] = [];
  private debounce?: NodeJS.Timeout;

  constructor() {
    const update = () => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.postDetected(), 300);
    };
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(update),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document) {
          update();
        }
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, enableCommandUris: false };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === "ready") {
        if (this.pendingPreset) {
          this.post({ type: "preset", preset: this.pendingPreset });
          this.pendingPreset = undefined;
        }
        this.postDetected();
      } else if (msg?.type === "openDocs") {
        void vscode.env.openExternal(vscode.Uri.parse(VLQ_BILLING.docsUrl));
      } else if (msg?.type === "reveal" && typeof msg.line === "number") {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const pos = new vscode.Position(msg.line, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
      }
    });
    view.onDidChangeVisibility(() => view.visible && this.postDetected());
  }

  async open(preset?: EstimatorPreset): Promise<void> {
    if (preset) {
      this.pendingPreset = preset;
    }
    await vscode.commands.executeCommand(`${EstimatorViewProvider.viewId}.focus`);
    if (this.view && this.pendingPreset) {
      this.post({ type: "preset", preset: this.pendingPreset });
      this.pendingPreset = undefined;
    }
  }

  private post(msg: unknown): void {
    void this.view?.webview.postMessage(msg);
  }

  private postDetected(): void {
    if (!this.view?.visible) {
      return;
    }
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc) {
      this.post({ type: "detected", file: null, rows: [] });
      return;
    }
    let rows: { line: number; label: string; range: string; high: number }[] = [];
    if (isQasm(doc)) {
      const shots = cfg().get<number>("defaultShots") ?? 1024;
      const e = estimate({ shots, circuits: 1 });
      rows = [
        {
          line: 0,
          label: `1 circuit × ${shots.toLocaleString()} shots (qaas.defaultShots)`,
          range: formatRange(e),
          high: e.high,
        },
      ];
    } else if (doc.languageId === "python") {
      rows = detectCalls(doc).map((c) => ({
        line: c.line,
        label: `line ${c.line + 1}: ${c.kind === "playlist" ? "pulla playlist, " : ""}${describeCall(c)}`,
        range: formatRange({ low: c.low, high: c.high, vlqJobs: 0, shots: c.shots, minimumApplies: false }),
        high: c.high,
      }));
    }
    const total = rows.reduce((a, r) => a + r.high, 0);
    this.post({
      type: "detected",
      file: path.basename(doc.fileName),
      rows,
      total: rows.length > 1 ? formatSeconds(total) : null,
    });
  }

  private html(): string {
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    const consts = JSON.stringify(VLQ_BILLING);
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 4px 12px 16px; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin: 16px 0 6px; }
  label { display: block; margin: 8px 0 2px; }
  input[type=number] { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; border-radius: 2px; }
  input[type=range] { width: 100%; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .result { margin-top: 12px; padding: 8px 10px; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-charts-blue); }
  .big { font-size: 1.4em; font-weight: 600; font-variant-numeric: tabular-nums; }
  ul { list-style: none; padding: 0; margin: 0; } li { padding: 3px 0; cursor: pointer; display: flex; justify-content: space-between; gap: 8px; }
  li:hover { color: var(--vscode-textLink-activeForeground); } li span:last-child { white-space: nowrap; font-variant-numeric: tabular-nums; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  code { font-family: var(--vscode-editor-font-family); font-size: 11px; }
</style></head><body>
<h3>Active editor</h3>
<div id="detected" class="hint">Open a Python file, notebook or .qasm file that submits to VLQ.</div>

<h3>Calculator</h3>
<label for="shots">Shots per circuit</label><input id="shots" type="number" min="1" step="1" value="1024">
<label for="circuits">Circuits per submission</label><input id="circuits" type="number" min="1" step="1" value="1">
<div class="hint">Each circuit runs as its own VLQ job.</div>
<label for="subs">Submissions</label><input id="subs" type="number" min="1" step="1" value="1">
<label for="cus">Circuit time: <span id="cusv"></span></label>
<input id="cus" type="range" min="0" max="50" step="1" value="50">
<label><input id="unknown" type="checkbox" checked> Unknown circuit time (show 0–50 µs range)</label>
<div class="result"><div class="hint">Billed QPU time</div><div class="big" id="total"></div><div class="hint" id="detail"></div></div>
<p class="hint">billed = VLQ jobs × max(shots × (350 µs + circuit time), 0.9 s).<br>Job latency (3–15 s) is not billed. <a id="docs">VLQ consumption guide</a></p>
<script nonce="${nonce}">
const B = ${consts};
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const per = (shots, us) => Math.max(shots * (B.postprocessingUs + us) * 1e-6, B.minPerJobSeconds);
const fmt = (s) => s < 60 ? s.toFixed(s < 10 ? 2 : 1) + " s" : s < 3600 ? Math.floor(s / 60) + " min " + Math.round(s % 60) + " s" : (s / 3600).toFixed(2) + " h";
function calc() {
  const shots = Math.max(0, Math.floor(+$("shots").value || 0));
  const jobs = Math.max(1, Math.floor(+$("circuits").value || 1)) * Math.max(1, Math.floor(+$("subs").value || 1));
  const unknown = $("unknown").checked;
  $("cus").disabled = unknown;
  const us = +$("cus").value;
  $("cusv").textContent = unknown ? "0–50 µs" : us + " µs";
  const lo = jobs * per(shots, unknown ? 0 : us), hi = jobs * per(shots, unknown ? B.maxCircuitUs : us);
  const a = fmt(lo), b = fmt(hi);
  $("total").textContent = a === b ? b : a.replace(/ s$/, "") + "–" + b;
  const floor = shots * (B.postprocessingUs + (unknown ? B.maxCircuitUs : us)) * 1e-6 < B.minPerJobSeconds;
  $("detail").textContent = jobs + " VLQ job" + (jobs === 1 ? "" : "s") + (floor ? " · 0.9 s minimum per job applies" : "");
  vscode.setState({ shots: $("shots").value, circuits: $("circuits").value, subs: $("subs").value, cus: $("cus").value, unknown });
}
for (const id of ["shots", "circuits", "subs", "cus", "unknown"]) $(id).addEventListener("input", calc);
$("docs").addEventListener("click", () => vscode.postMessage({ type: "openDocs" }));
const st = vscode.getState();
if (st) { $("shots").value = st.shots; $("circuits").value = st.circuits; $("subs").value = st.subs; $("cus").value = st.cus; $("unknown").checked = st.unknown; }
window.addEventListener("message", (ev) => {
  const m = ev.data;
  if (m.type === "preset") {
    if (m.preset.shots) $("shots").value = m.preset.shots;
    if (m.preset.circuits) $("circuits").value = m.preset.circuits;
    $("subs").value = m.preset.submissions || 1;
    calc();
  } else if (m.type === "detected") {
    const el = $("detected");
    el.replaceChildren();
    if (!m.file || m.rows.length === 0) {
      el.className = "hint";
      el.textContent = m.file ? "No VLQ submissions found in " + m.file + "." : "No active editor.";
      return;
    }
    el.className = "";
    const head = document.createElement("div"); head.className = "hint"; head.textContent = m.file; el.append(head);
    const ul = document.createElement("ul");
    for (const r of m.rows) {
      const li = document.createElement("li");
      const l = document.createElement("span"); l.textContent = r.label;
      const v = document.createElement("span"); v.textContent = r.range;
      li.append(l, v); li.title = "Go to line"; li.addEventListener("click", () => vscode.postMessage({ type: "reveal", line: r.line }));
      ul.append(li);
    }
    el.append(ul);
    if (m.total) { const t = document.createElement("div"); t.className = "hint"; t.textContent = "All submissions, worst case: " + m.total; el.append(t); }
  }
});
calc();
vscode.postMessage({ type: "ready" });
</script></body></html>`;
  }
}
