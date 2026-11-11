import * as vscode from "vscode";
import type { Bridge } from "./bridge";
import { cfg } from "./config";
import {
  entryStatus,
  type LocusValues,
  type OperatorSpec,
  setLocusValues,
  shapeOnly,
  unverifyLocus,
} from "./core/operators";
import { type CatalogEntry, describeShape, type OperatorCatalog, type OperatorNode, shortId } from "./operators";

type Valid = CatalogEntry & { spec: OperatorSpec };

interface Message {
  type: string;
  seq?: number;
  entry?: string;
  locus?: string;
  values?: LocusValues;
  name?: string;
}

/** One editor per operator file: live I/Q preview, per-qubit values, hardware checks. */
export class WaveformEditor {
  private static readonly panels = new Map<string, WaveformEditor>();

  static open(catalog: OperatorCatalog, bridge: Bridge, entry: Valid, calibrationSetId?: string, locus?: string): void {
    const key = entry.uri.toString();
    const existing = WaveformEditor.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      existing.select(calibrationSetId, locus);
      return;
    }
    WaveformEditor.panels.set(key, new WaveformEditor(catalog, bridge, entry, calibrationSetId, locus));
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private selected: { entry?: string; locus?: string };

  private constructor(
    private readonly catalog: OperatorCatalog,
    private readonly bridge: Bridge,
    private entry: Valid,
    calibrationSetId?: string,
    locus?: string,
  ) {
    this.selected = { entry: calibrationSetId, locus };
    this.panel = vscode.window.createWebviewPanel(
      "qaas.waveformEditor",
      `Operator ${entry.spec.name}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = this.html();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m: Message) => void this.onMessage(m)),
      catalog.onDidChange(() => {
        const next = catalog.get(this.entry.uri);
        if (next?.spec) {
          this.entry = next as Valid;
          this.panel.title = `Operator ${this.entry.spec.name}`;
          this.postState();
        }
      }),
    );
    this.panel.onDidDispose(() => {
      WaveformEditor.panels.delete(this.entry.uri.toString());
      for (const d of this.disposables) {
        d.dispose();
      }
    });
  }

  private node(): OperatorNode {
    return { kind: "operator", entry: this.entry };
  }

  private select(entry?: string, locus?: string): void {
    this.selected = { entry: entry ?? this.selected.entry, locus: locus ?? this.selected.locus };
    this.postState();
  }

  private postState(): void {
    const spec = this.entry.spec;
    const info = this.catalog.pulseInfo();
    const params = Object.entries(spec.parameters ?? {}).map(([name, p]) =>
      typeof p === "number" ? { name, unit: "", default: p } : { name, unit: p.unit ?? "", default: p.default },
    );
    void this.panel.webview.postMessage({
      type: "state",
      operator: {
        name: spec.name,
        gate: spec.gate ?? "prx",
        description: spec.description ?? "",
        shape: describeShape(spec),
        file: vscode.workspace.asRelativePath(this.entry.uri),
        params,
      },
      entries: (spec.calibrations ?? []).map((c) => ({
        id: c.calibrationSetId,
        label: `${shortId(c.calibrationSetId)} · ${c.status ?? "draft"}`,
        status: c.status ?? "draft",
        relation: entryStatus(c, info?.calibrationSetId),
        loci: c.loci,
        verified: c.verifiedLoci ?? [],
        note: c.note ?? "",
      })),
      info: info
        ? {
            calibrationSetId: info.calibrationSetId,
            nativeImplementation: info.nativeImplementation,
            sampleRate: info.sampleRate,
            granularity: info.granularity,
            minSamples: info.minSamples,
            native: info.loci,
            qubits: info.qubits,
          }
        : null,
      defaultSampleRate: cfg().get<number>("pulseSampleRate") ?? 2e9,
      select: this.selected,
    });
  }

  private async onMessage(m: Message): Promise<void> {
    switch (m.type) {
      case "ready":
        this.postState();
        break;
      case "selected":
        this.selected = { entry: m.entry, locus: m.locus };
        break;
      case "preview": {
        const rate = this.catalog.pulseInfo()?.sampleRate ?? cfg().get<number>("pulseSampleRate") ?? 2e9;
        try {
          const result = await this.bridge.request("pulseSample", {
            spec: shapeOnly(this.entry.spec),
            values: m.values,
            sampleRate: rate,
          });
          void this.panel.webview.postMessage({ type: "preview", seq: m.seq, result, sampleRate: rate });
        } catch (e) {
          void this.panel.webview.postMessage({ type: "previewError", seq: m.seq, message: (e as Error).message });
        }
        break;
      }
      case "save": {
        if (!m.entry || !m.locus || !m.values) {
          return;
        }
        try {
          let text = await this.catalog.textOf(this.entry.uri);
          text = setLocusValues(text, m.entry, m.locus, m.values);
          text = unverifyLocus(text, m.entry, m.locus);
          await this.catalog.write(this.entry.uri, text);
          vscode.window.setStatusBarMessage(
            `QaaS: saved ${m.locus} of ${this.entry.spec.name} (draft until verified)`,
            4000,
          );
        } catch (e) {
          vscode.window.showErrorMessage(`QaaS: ${(e as Error).message}`);
        }
        break;
      }
      case "addLocus": {
        if (!m.entry || !m.values) {
          return;
        }
        const name = await vscode.window.showInputBox({
          title: "Add qubit",
          prompt: "Qubit name, e.g. QB2. Starts with the values of the selected qubit.",
          validateInput: (v) =>
            /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(v) ? undefined : "Letters, digits and underscores",
        });
        if (!name) {
          return;
        }
        const text = setLocusValues(await this.catalog.textOf(this.entry.uri), m.entry, name, m.values, {
          status: "draft",
        });
        this.selected = { entry: m.entry, locus: name };
        await this.catalog.write(this.entry.uri, text);
        break;
      }
      case "command": {
        const node = this.node();
        const entryNode = this.entry.spec.calibrations?.find((c) => c.calibrationSetId === m.entry);
        const commands: Record<string, () => Thenable<unknown>> = {
          openFile: () => vscode.window.showTextDocument(this.entry.uri, { viewColumn: vscode.ViewColumn.Beside }),
          refreshCalibration: () => vscode.commands.executeCommand("qaas.operators.refreshCalibration"),
          seed: () => vscode.commands.executeCommand("qaas.operators.seed", node),
          insertCode: () =>
            vscode.commands.executeCommand(
              "qaas.operators.insertCode",
              entryNode ? { kind: "calibration", entry: this.entry, cal: entryNode } : node,
            ),
          calibrate: () => vscode.commands.executeCommand("qaas.operators.calibrate", node),
          migrate: () =>
            vscode.commands.executeCommand(
              "qaas.operators.migrate",
              entryNode ? { kind: "calibration", entry: this.entry, cal: entryNode } : node,
            ),
          markCalibrated: () =>
            entryNode
              ? vscode.commands.executeCommand("qaas.operators.markCalibrated", {
                  kind: "calibration",
                  entry: this.entry,
                  cal: entryNode,
                })
              : Promise.resolve(),
        };
        await commands[m.name ?? ""]?.();
        break;
      }
    }
  }

  private html(): string {
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --i: var(--vscode-charts-blue); --q: var(--vscode-charts-orange); --lim: var(--vscode-charts-red); }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); padding: 0 16px 24px; max-width: 1000px; }
  h1 { font-size: 1.25em; margin: 14px 0 2px; } h2 { font-size: 1em; margin: 18px 0 6px; }
  .muted { color: var(--vscode-descriptionForeground); }
  code { font-family: var(--vscode-editor-font-family); }
  .row { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: end; margin: 10px 0; }
  label { display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  input, select { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; border-radius: 2px; min-width: 110px; }
  input[type=number] { width: 130px; }
  button { font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
    border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:disabled { opacity: .5; cursor: default; }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 9px; border: 1px solid var(--vscode-panel-border); }
  .badge.current { border-color: var(--vscode-testing-iconPassed); } .badge.stale, .badge.draft { border-color: var(--vscode-editorWarning-foreground); }
  svg { width: 100%; height: auto; background: var(--vscode-textBlockQuote-background); border-radius: 3px; }
  svg text { fill: var(--vscode-descriptionForeground); font-size: 10px; }
  .legend i { display: inline-block; width: 14px; height: 3px; margin: 0 4px 3px 10px; vertical-align: middle; }
  ul.checks { list-style: none; padding: 0; margin: 6px 0; } ul.checks li { padding: 2px 0; }
  .err { color: var(--vscode-errorForeground); } .warn { color: var(--vscode-editorWarning-foreground); } .ok { color: var(--vscode-testing-iconPassed); }
  .empty { padding: 16px; background: var(--vscode-textBlockQuote-background); border-radius: 3px; }
</style></head><body>
<h1 id="title"></h1>
<div class="muted" id="sub"></div>
<div class="row">
  <button data-cmd="openFile">Open file</button>
  <button data-cmd="insertCode">Insert Python code</button>
  <button data-cmd="calibrate">Calibrate (Rabi notebook)…</button>
  <button data-cmd="refreshCalibration">Refresh calibration set</button>
</div>
<div id="empty" class="empty" hidden>
  No calibration values yet. <button data-cmd="seed" class="primary">Start from the native gate</button>
  <div class="muted">Creates a draft entry for the current calibration set with the native pulse duration and amplitude.</div>
</div>
<div id="main" hidden>
  <div class="row">
    <label>Calibration set<select id="entry"></select></label>
    <label>Qubit<select id="locus"></select></label>
    <button id="addLocus">Add qubit…</button>
    <span id="badges"></span>
  </div>
  <div class="row" id="fields"></div>
  <div class="row">
    <button class="primary" id="save" disabled>Save</button>
    <button id="revert" disabled>Revert</button>
    <button data-cmd="markCalibrated" id="mark">Mark calibrated…</button>
    <button data-cmd="migrate" id="migrate">Migrate to current set…</button>
  </div>
  <h2>Waveform <span class="legend muted"><i style="background:var(--i)"></i>I × amplitude_i<i style="background:var(--q)"></i>Q × amplitude_q<i style="background:var(--lim)"></i>limit ±1</span></h2>
  <svg id="plot" viewBox="0 0 640 240" role="img" aria-label="I and Q waveforms"></svg>
  <h2>Checks</h2>
  <ul class="checks" id="checks"></ul>
  <div class="muted" id="note"></div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let state = null, values = {}, saved = {}, seq = 0, latest = 0, preview = null, previewError = null, timer = null;
const CORE = [["duration", "Duration (ns)", "s"], ["amplitude_i", "amplitude_i", ""], ["amplitude_q", "amplitude_q", ""]];
const toUi = (v, unit) => unit === "s" ? v * 1e9 : unit === "Hz" ? v / 1e6 : v;
const fromUi = (v, unit) => unit === "s" ? v / 1e9 : unit === "Hz" ? v * 1e6 : v;
const unitLabel = (u) => u === "s" ? " (ns)" : u === "Hz" ? " (MHz)" : "";
const fmt = (x, d = 4) => (Math.abs(x) >= 1e4 || (Math.abs(x) < 1e-3 && x !== 0)) ? x.toExponential(3) : (+x.toFixed(d)).toString();

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-cmd]");
  if (b) vscode.postMessage({ type: "command", name: b.dataset.cmd, entry: $("entry").value });
});
$("entry").addEventListener("change", () => { fillLoci(); loadValues(); });
$("locus").addEventListener("change", loadValues);
$("save").addEventListener("click", () => vscode.postMessage({ type: "save", entry: $("entry").value, locus: $("locus").value, values }));
$("revert").addEventListener("click", () => { values = { ...saved }; renderFields(); requestPreview(); });
$("addLocus").addEventListener("click", () => vscode.postMessage({ type: "addLocus", entry: $("entry").value, values }));

function currentEntry() { return state.entries.find((e) => e.id === $("entry").value); }

function fillLoci() {
  const e = currentEntry(), sel = $("locus"), prev = sel.value || (state.select && state.select.locus);
  sel.replaceChildren(...Object.keys(e ? e.loci : {}).sort().map((l) => new Option(l, l)));
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function loadValues() {
  const e = currentEntry();
  saved = { ...(e && e.loci[$("locus").value] || {}) };
  values = { ...saved };
  vscode.postMessage({ type: "selected", entry: $("entry").value, locus: $("locus").value });
  renderFields(); renderBadges(); requestPreview();
}

function renderBadges() {
  const e = currentEntry(); const b = $("badges"); b.replaceChildren();
  if (!e) return;
  const add = (text, cls) => { const s = document.createElement("span"); s.className = "badge " + cls; s.textContent = text; b.append(s, " "); };
  add(e.relation === "current" ? "current set" : e.relation === "stale" ? "older calibration set" : e.relation === "draft" ? "current set" : "set unknown", e.relation);
  add(e.status, e.status === "calibrated" ? "current" : "draft");
  if (e.verified.includes($("locus").value)) add("verified", "current");
  $("migrate").hidden = e.relation !== "stale";
  $("mark").hidden = e.status === "calibrated";
  $("note").textContent = e.note;
}

function renderFields() {
  const f = $("fields"); f.replaceChildren();
  const params = state.operator.params.map((p) => [p.name, p.name + unitLabel(p.unit), p.unit, p.default]);
  const extra = Object.keys(values).filter((k) => !CORE.some((c) => c[0] === k) && !params.some((p) => p[0] === k)).map((k) => [k, k, ""]);
  for (const [key, label, unit, def] of [...CORE, ...params, ...extra]) {
    const l = document.createElement("label"); l.textContent = label;
    const inp = document.createElement("input"); inp.type = "number"; inp.step = "any";
    if (values[key] !== undefined) inp.value = +toUi(values[key], unit).toPrecision(8);
    if (values[key] === undefined && def !== undefined) inp.placeholder = "default " + fmt(toUi(def, unit));
    inp.addEventListener("input", () => {
      if (inp.value === "") delete values[key]; else values[key] = fromUi(parseFloat(inp.value), unit);
      dirty(); requestPreview();
    });
    l.append(inp); f.append(l);
  }
  dirty();
}

function dirty() {
  const changed = JSON.stringify(values) !== JSON.stringify(saved);
  $("save").disabled = !changed; $("revert").disabled = !changed;
}

function requestPreview() {
  clearTimeout(timer);
  timer = setTimeout(() => { latest = ++seq; vscode.postMessage({ type: "preview", seq: latest, values }); }, 150);
}

function renderPlot() {
  const svg = $("plot"), W = 640, H = 240, L = 40, R = 10, T = 10, B = 26;
  const parts = [];
  const y = (v) => T + (1 - (v + 1.2) / 2.4) * (H - T - B);
  const lim = (v) => '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--lim)" stroke-dasharray="4 3" stroke-width="1"/>';
  parts.push(lim(1), lim(-1), '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(0) + '" y2="' + y(0) + '" stroke="var(--vscode-panel-border)"/>');
  for (const v of [-1, 0, 1]) parts.push('<text x="' + (L - 6) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + v + "</text>");
  if (preview) {
    const n = preview.timeNs.length, tEnd = n ? preview.timeNs[n - 1] + (preview.timeNs[1] || 0) - (preview.timeNs[0] || 0) : 1;
    const x = (t) => L + (t / (tEnd || 1)) * (W - L - R);
    const line = (arr, color) => '<polyline fill="none" stroke="' + color + '" stroke-width="1.6" points="' + arr.map((v, k) => x(preview.timeNs[k]).toFixed(1) + "," + y(Math.max(-1.2, Math.min(1.2, v))).toFixed(1)).join(" ") + '"/>';
    parts.push(line(preview.q, "var(--q)"), line(preview.i, "var(--i)"));
    for (const f of [0, 0.5, 1]) parts.push('<text x="' + x(f * tEnd) + '" y="' + (H - 8) + '" text-anchor="middle">' + fmt(f * tEnd, 1) + " ns</text>");
  }
  svg.innerHTML = parts.join("");
}

function renderChecks() {
  const ul = $("checks"); ul.replaceChildren();
  const add = (cls, text) => { const li = document.createElement("li"); li.className = cls; li.textContent = text; ul.append(li); };
  const info = state.info, e = currentEntry(), locus = $("locus").value;
  if (previewError) { add("err", "✖ " + previewError); return; }
  if (!preview) return;
  const rate = info ? info.sampleRate : state.defaultSampleRate;
  add(preview.peak > 1 ? "err" : "ok", (preview.peak > 1 ? "✖ " : "✔ ") + "Peak amplitude " + fmt(preview.peak, 3) + (preview.peak > 1 ? " exceeds 1" : " (limit 1)"));
  add("muted", "• " + preview.nSamples + " samples at " + fmt(rate / 1e9, 2) + " GS/s" + (info ? "" : " (default rate; refresh the calibration set for the hardware value)"));
  if (info && info.minSamples && preview.nSamples < info.minSamples) add("err", "✖ Shorter than the minimum instruction length (" + info.minSamples + " samples)");
  if (info && info.granularity && preview.nSamples % info.granularity) add("warn", "⚠ " + preview.nSamples + " samples is not a multiple of the granularity (" + info.granularity + "); choose a duration of " + fmt(Math.round(preview.nSamples / info.granularity) * info.granularity / rate * 1e9, 2) + " ns");
  const native = info && info.native[locus];
  if (native && native.duration) add("muted", "• Native " + info.nativeImplementation + " on " + locus + ": " + fmt(native.duration * 1e9, 1) + " ns, amplitude_i " + fmt(native.amplitude_i ?? NaN));
  if (e && e.relation === "stale") add("warn", "⚠ Tuned on an older calibration set; migrate before running.");
  if (e && e.status !== "calibrated") add("warn", "⚠ Draft values: verify them, e.g. with the Rabi calibration notebook.");
  if (preview.shapePeakI > 1.0001 || preview.shapePeakQ > 1.0001) add("warn", "⚠ The normalized shape exceeds 1 (I " + fmt(preview.shapePeakI, 3) + ", Q " + fmt(preview.shapePeakQ, 3) + "); waveforms should stay within [-1, 1].");
}

window.addEventListener("message", (ev) => {
  const m = ev.data;
  if (m.type === "state") {
    state = m;
    $("title").textContent = m.operator.name + " · " + m.operator.gate;
    $("sub").textContent = (m.operator.description ? m.operator.description + " — " : "") + m.operator.shape + " — " + m.operator.file;
    const has = m.entries.length > 0;
    $("empty").hidden = has; $("main").hidden = !has;
    if (!has) return;
    const sel = $("entry"), prev = sel.value || (m.select && m.select.entry) || (m.info && m.info.calibrationSetId);
    sel.replaceChildren(...m.entries.map((e) => new Option(e.label + (e.relation === "current" || e.relation === "draft" ? " (current)" : ""), e.id)));
    if (prev && m.entries.some((e) => e.id === prev)) sel.value = prev;
    fillLoci();
    const keep = JSON.stringify(values) !== JSON.stringify(saved);
    if (!keep) loadValues(); else { renderBadges(); requestPreview(); }
  } else if (m.type === "preview" && m.seq === latest) {
    preview = m.result; previewError = null; renderPlot(); renderChecks();
  } else if (m.type === "previewError" && m.seq === latest) {
    preview = null; previewError = m.message; renderPlot(); renderChecks();
  }
});
renderPlot();
vscode.postMessage({ type: "ready" });
</script></body></html>`;
  }
}
