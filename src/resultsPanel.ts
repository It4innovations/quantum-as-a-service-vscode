import * as vscode from "vscode";
import type { JobRecord } from "./jobs";

const MAX_BARS = 64;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Histogram of measurement counts, one chart per circuit. Static HTML, no scripts. */
export function showResultsPanel(job: JobRecord, counts: Record<string, number>[]): void {
  const panel = vscode.window.createWebviewPanel("qaas.results", `Results #${job.jobId}`, vscode.ViewColumn.Beside, {
    enableScripts: false,
  });
  const charts = counts
    .map((c, i) => {
      const total = Object.values(c).reduce((a, b) => a + b, 0) || 1;
      const entries = Object.entries(c).sort((a, b) => b[1] - a[1]);
      const shown = entries.slice(0, MAX_BARS).sort((a, b) => a[0].localeCompare(b[0]));
      const max = Math.max(...shown.map(([, v]) => v), 1);
      const rows = shown
        .map(
          ([bits, v]) => `<tr><th><code>${esc(bits)}</code></th>
            <td class="bar"><span style="width:${((v / max) * 100).toFixed(1)}%"></span></td>
            <td class="num">${v.toLocaleString()}</td><td class="num">${((v / total) * 100).toFixed(1)}%</td></tr>`,
        )
        .join("");
      const more =
        entries.length > MAX_BARS ? `<p class="muted">Top ${MAX_BARS} of ${entries.length} outcomes shown.</p>` : "";
      return `<section><h2>Circuit ${i}</h2><p class="muted">${total.toLocaleString()} shots · ${entries.length} distinct outcomes</p>
        <table>${rows}</table>${more}</section>`;
    })
    .join("");
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0 16px 24px; }
  h1 { font-size: 1.2em; } h2 { font-size: 1.05em; margin-top: 24px; }
  .muted { color: var(--vscode-descriptionForeground); }
  table { border-collapse: collapse; width: 100%; max-width: 720px; }
  th { text-align: left; font-weight: normal; padding: 2px 12px 2px 0; white-space: nowrap; }
  td { padding: 2px 0; } td.num { text-align: right; padding-left: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.bar { width: 100%; } td.bar span { display: block; height: 14px; background: var(--vscode-charts-blue); border-radius: 2px; min-width: 1px; }
</style></head><body>
<h1>${esc(job.name)} <span class="muted">#${esc(job.jobId)}</span></h1>
<p class="muted">${esc(job.backend)} · ${esc(job.project)}${job.downloadedTo ? ` · saved in <code>${esc(job.downloadedTo)}</code>` : ""}<br>
Bitstrings use Qiskit order: the rightmost bit is classical bit 0.</p>
${charts || "<p>No counts in this result.</p>"}
</body></html>`;
}
