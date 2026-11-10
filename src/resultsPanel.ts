import * as vscode from "vscode";
import {
  type CountStats,
  type Counts,
  countStats,
  hellingerFidelity,
  normalizeCounts,
  toProbabilities,
  totalVariationDistance,
} from "./core/stats";
import type { JobRecord } from "./jobs";

const MAX_BARS = 64;
const MAX_HEATMAP_BITS = 16;

export interface Reference {
  /** e.g. "ideal simulation" or "job #123" */
  label: string;
  /** One distribution per circuit; counts or probabilities. */
  counts: Counts[];
}

export interface ResultsActions {
  compareIdeal(job: JobRecord): Promise<Reference | undefined>;
  compareJob(job: JobRecord): Promise<Reference | undefined>;
  openDataWrangler(job: JobRecord): Promise<void>;
  openNotebook(job: JobRecord): Promise<void>;
  revealFolder(job: JobRecord): void;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const num = (x: number, d = 3) => (Math.abs(x) < 5e-4 ? "0" : x.toFixed(d));

/** One panel per job: statistics, histogram, marginals, correlations and comparison. */
export class ResultsPanel {
  private static readonly panels = new Map<string, ResultsPanel>();
  private reference?: Reference;

  static show(job: JobRecord, counts: Counts[], actions: ResultsActions): void {
    const key = `${job.project}:${job.jobId}`;
    const existing = ResultsPanel.panels.get(key);
    if (existing) {
      existing.job = job;
      existing.counts = counts;
      existing.render();
      existing.panel.reveal();
      return;
    }
    ResultsPanel.panels.set(key, new ResultsPanel(key, job, counts, actions));
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    key: string,
    private job: JobRecord,
    private counts: Counts[],
    private readonly actions: ResultsActions,
  ) {
    this.panel = vscode.window.createWebviewPanel("qaas.results", `Results #${job.jobId}`, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: false,
    });
    this.panel.onDidDispose(() => ResultsPanel.panels.delete(key));
    this.panel.webview.onDidReceiveMessage(async (msg: { type?: string }) => {
      try {
        switch (msg.type) {
          case "compareIdeal":
          case "compareJob": {
            const ref = await (msg.type === "compareIdeal"
              ? this.actions.compareIdeal(this.job)
              : this.actions.compareJob(this.job));
            if (ref) {
              this.reference = ref;
              this.render();
            }
            break;
          }
          case "clearCompare":
            this.reference = undefined;
            this.render();
            break;
          case "dataWrangler":
            await this.actions.openDataWrangler(this.job);
            break;
          case "notebook":
            await this.actions.openNotebook(this.job);
            break;
          case "reveal":
            this.actions.revealFolder(this.job);
            break;
        }
      } catch (e) {
        vscode.window.showErrorMessage(`QaaS: ${(e as Error).message}`);
      }
    });
    this.render();
  }

  private render(): void {
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    const j = this.job;
    const ref = this.reference;
    const sections = this.counts.map((c, i) => this.circuitSection(c, i, ref?.counts[i])).join("");
    const compareBar = ref
      ? `<span class="chip">Compared with ${esc(ref.label)} <button class="link" data-action="clearCompare" title="Remove comparison">✕</button></span>`
      : "";
    this.panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --ref: var(--vscode-charts-orange); --meas: var(--vscode-charts-blue); --neg: var(--vscode-charts-red); }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); padding: 0 16px 32px; max-width: 980px; }
  h1 { font-size: 1.25em; margin: 16px 0 4px; } h2 { font-size: 1.1em; margin: 28px 0 8px; } h3 { font-size: .95em; margin: 18px 0 6px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .toolbar { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; align-items: center; }
  button { font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
    border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.link { background: none; padding: 0 2px; color: var(--vscode-textLink-foreground); }
  .chip { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 1px 8px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  .kpi { background: var(--vscode-textBlockQuote-background); padding: 6px 10px; border-radius: 3px; }
  .kpi b { display: block; font-size: 1.2em; font-variant-numeric: tabular-nums; }
  .kpi span { font-size: 11px; color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; } td, th { padding: 2px 6px; font-variant-numeric: tabular-nums; }
  th { text-align: left; font-weight: normal; white-space: nowrap; }
  td.num { text-align: right; white-space: nowrap; }
  table.hist { width: 100%; } td.bar { width: 100%; }
  .b { display: block; height: 11px; background: var(--meas); border-radius: 2px; min-width: 1px; }
  .b.ref { height: 5px; margin-top: 2px; background: var(--ref); }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 4px 0 10px; vertical-align: -1px; }
  table.heat td { width: 34px; height: 24px; text-align: center; font-size: 11px; border: 1px solid var(--vscode-editor-background); }
  code { font-family: var(--vscode-editor-font-family); }
  @media (max-width: 520px) { body { padding: 0 8px 24px; } }
</style></head><body>
<h1>${esc(j.name)} <span class="muted">#${esc(j.jobId)}</span></h1>
<div class="muted">${esc(j.backend)} · ${esc(j.project)}${j.calibrationSetId ? ` · calibration ${esc(j.calibrationSetId)}` : ""}${
      j.downloadedTo ? ` · <code>${esc(j.downloadedTo)}</code>` : ""
    }</div>
<div class="toolbar">
  <button class="primary" data-action="compareIdeal" title="Exact noiseless probabilities of the submitted OpenQASM circuits">Compare with ideal simulation</button>
  <button data-action="compareJob">Compare with another job…</button>
  <button data-action="dataWrangler">Open in Data Wrangler</button>
  <button data-action="notebook">Open analysis notebook</button>
  <button data-action="reveal">Reveal folder</button>
  ${compareBar}
</div>
<div class="muted">Bit order as in Qiskit: the rightmost bit is classical bit c0. ⟨Z⟩ = P(0) − P(1).</div>
${sections || "<p>No counts in this result.</p>"}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-action]");
    if (b) vscode.postMessage({ type: b.dataset.action });
  });
</script>
</body></html>`;
  }

  private circuitSection(raw: Counts, index: number, refRaw?: Counts): string {
    const s = countStats(raw, MAX_HEATMAP_BITS);
    const ref = refRaw ? toProbabilities(normalizeCounts(refRaw)) : undefined;
    const kpis: [string, string, string?][] = [
      ["Shots", s.shots.toLocaleString()],
      [
        "Distinct outcomes",
        s.outcomes.toLocaleString(),
        s.numBits ? `of ${2 ** Math.min(s.numBits, 52)} possible` : undefined,
      ],
      ["Entropy", `${num(s.entropy, 2)} bits`, `max ${s.numBits}`],
      ["Most frequent", `|${s.topOutcome}⟩`, pct(s.topProbability)],
      ["Parity ⟨Z…Z⟩", num(s.parity)],
    ];
    if (refRaw && ref) {
      kpis.push(
        ["Hellinger fidelity", num(hellingerFidelity(raw, refRaw), 4), `vs ${this.reference?.label}`],
        ["Total variation distance", num(totalVariationDistance(raw, refRaw), 4), `vs ${this.reference?.label}`],
      );
    }
    const kpiHtml = kpis
      .map(
        ([k, v, sub]) =>
          `<div class="kpi"><span>${esc(k)}</span><b>${esc(v)}</b>${sub ? `<span>${esc(sub)}</span>` : ""}</div>`,
      )
      .join("");
    return `<section><h2>Circuit ${index}</h2><div class="kpis">${kpiHtml}</div>
      ${this.histogram(raw, s, ref)}${this.marginals(s)}${this.heatmap(s)}</section>`;
  }

  private histogram(raw: Counts, s: CountStats, ref?: Counts): string {
    const p = toProbabilities(normalizeCounts(raw));
    const width = s.numBits;
    const keys = new Set(Object.keys(p));
    for (const k of Object.keys(ref ?? {})) {
      keys.add(k);
    }
    const ranked = [...keys].sort((a, b) => Math.max(p[b] ?? 0, ref?.[b] ?? 0) - Math.max(p[a] ?? 0, ref?.[a] ?? 0));
    const shown = ranked.slice(0, MAX_BARS).sort();
    const max = Math.max(...shown.map((k) => Math.max(p[k] ?? 0, ref?.[k] ?? 0)), 1e-12);
    const rows = shown
      .map((k) => {
        const v = p[k] ?? 0;
        const r = ref?.[k];
        const refBar = ref ? `<span class="b ref" style="width:${(((r ?? 0) / max) * 100).toFixed(1)}%"></span>` : "";
        return `<tr><th><code>${esc(k.padStart(width, "0"))}</code></th>
          <td class="bar"><span class="b" style="width:${((v / max) * 100).toFixed(1)}%"></span>${refBar}</td>
          <td class="num">${pct(v)}</td>${ref ? `<td class="num muted">${pct(r ?? 0)}</td>` : ""}</tr>`;
      })
      .join("");
    const legend = ref
      ? `<span class="legend"><i style="background:var(--meas)"></i>measured<i style="background:var(--ref)"></i>${esc(this.reference?.label ?? "")}</span>`
      : "";
    const more =
      ranked.length > MAX_BARS ? `<div class="muted">Top ${MAX_BARS} of ${ranked.length} outcomes shown.</div>` : "";
    return `<h3>Outcomes ${legend}</h3><table class="hist">${rows}</table>${more}`;
  }

  private marginals(s: CountStats): string {
    if (s.numBits === 0) {
      return "";
    }
    const rows = s.marginals
      .map(
        (m) => `<tr><th>c${m.clbit}</th><td class="num">${num(m.p1)}</td>
        <td style="width:160px"><span class="b" style="width:${(m.p1 * 100).toFixed(1)}%"></span></td><td class="num">${num(m.z)}</td></tr>`,
      )
      .join("");
    return `<h3>Per-bit statistics</h3><table><tr><th>Bit</th><th>P(1)</th><th></th><th>⟨Z⟩</th></tr>${rows}</table>`;
  }

  private heatmap(s: CountStats): string {
    if (s.numBits < 2) {
      return "";
    }
    if (s.correlations.length === 0) {
      return `<h3>Correlations</h3><div class="muted">Shown for up to ${MAX_HEATMAP_BITS} bits. Use Data Wrangler or the notebook for larger registers.</div>`;
    }
    const at = new Map(s.correlations.map((c) => [`${c.i},${c.j}`, c]));
    const n = s.numBits;
    let rows = `<tr><th></th>${Array.from({ length: n }, (_, j) => `<th>c${j}</th>`).join("")}</tr>`;
    for (let i = 0; i < n; i++) {
      rows += `<tr><th>c${i}</th>`;
      for (let j = 0; j < n; j++) {
        if (i === j) {
          rows += `<td class="muted">—</td>`;
          continue;
        }
        const c = at.get(i < j ? `${i},${j}` : `${j},${i}`)!;
        const v = c.connected;
        const color = v >= 0 ? "var(--meas)" : "var(--neg)";
        const strength = Math.round(Math.min(1, Math.abs(v)) * 85);
        rows += `<td title="c${i}, c${j}: ⟨ZZ⟩ = ${num(c.zz)}, connected = ${num(v)}"
          style="background:color-mix(in srgb, ${color} ${strength}%, transparent)">${num(v, 2)}</td>`;
      }
      rows += "</tr>";
    }
    return `<h3>Correlations <span class="muted">connected ⟨ZᵢZⱼ⟩ − ⟨Zᵢ⟩⟨Zⱼ⟩; 0 means independent bits</span></h3><table class="heat">${rows}</table>`;
  }
}
