// Calibration panel: per-qubit metrics of a calibration set, optionally compared with another set.
// Data arrives as {type: "data", payload} messages; see src/calibrations.ts.
(() => {
  const vscode = acquireVsCodeApi();
  const SVG = "http://www.w3.org/2000/svg";
  const saved = vscode.getState() || {};
  const state = { payload: null, metric: saved.metric || null, sort: saved.sort || null, view: saved.view || "values" };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) {
      if (c !== null && c !== undefined && c !== false)
        node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  };
  const svg = (tag, attrs, ...children) => {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v !== undefined && v !== null) node.setAttribute(k, String(v));
    }
    for (const c of children.flat()) {
      if (c !== null && c !== undefined) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  };

  // --- numbers -------------------------------------------------------------
  const fmt = (info, v) => (v * info.scale).toFixed(info.digits);
  const fmtUnit = (info, v) => `${fmt(info, v)}${info.unit === "%" ? "%" : info.unit ? ` ${info.unit}` : ""}`;
  const fmtDelta = (info, d) => {
    const r = Number(d.toFixed(info.digits));
    const sign = r > 0 ? "+" : r < 0 ? "−" : "±";
    return `${sign}${Math.abs(r).toFixed(info.digits)}${info.unit === "%" ? " pp" : info.unit ? ` ${info.unit}` : ""}`;
  };
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  function stats(col) {
    const entries = Object.entries(col.values);
    if (!entries.length) return null;
    const vals = entries.map(([, v]) => v.value);
    const sign = col.info.better === "higher" ? 1 : -1;
    const ranking = entries.sort((a, b) => sign * (a[1].value - b[1].value)).map(([q]) => q);
    return { min: Math.min(...vals), max: Math.max(...vals), median: median(vals), ranking };
  }
  const goodness = (info, v, min, max) =>
    max === min ? 1 : info.better === "higher" ? (v - min) / (max - min) : (max - v) / (max - min);
  const improvement = (info, before, after) => (info.better === "higher" ? 1 : -1) * (after - before) * info.scale;

  // --- colors (sequential blue: darker = better; diverging blue = better / red = worse) ---
  const SEQ = ["--seq-100", "--seq-200", "--seq-300", "--seq-400", "--seq-500", "--seq-600", "--seq-700"];
  const seqVar = (g) => `var(${SEQ[Math.max(0, Math.min(SEQ.length - 1, Math.round(g * (SEQ.length - 1))))]})`;
  const seqInk = (g) => (Math.round(g * (SEQ.length - 1)) >= 4 ? "var(--ink-on-dark)" : "var(--ink-on-light)");
  const DIV = ["--div-neg-3", "--div-neg-2", "--div-neg-1", "--div-mid", "--div-pos-1", "--div-pos-2", "--div-pos-3"];
  function divVar(d, scale) {
    if (!scale) return "var(--div-mid)";
    const step = Math.max(-3, Math.min(3, Math.round((d / scale) * 3)));
    return `var(${DIV[step + 3]})`;
  }

  // --- tooltip -------------------------------------------------------------
  const tip = $("#tip");
  function showTip(evt, lines) {
    tip.replaceChildren(...lines.map((l, i) => el("div", { class: i === 0 ? "tip-title" : "" }, l)));
    tip.hidden = false;
    const pad = 12;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    if (x + w > window.innerWidth - 4) x = evt.clientX - w - pad;
    if (y + h > window.innerHeight - 4) y = evt.clientY - h - pad;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, y)}px`;
  }
  const hideTip = () => {
    tip.hidden = true;
  };
  const hover = (node, lines) => {
    node.addEventListener("mousemove", (e) => showTip(e, typeof lines === "function" ? lines() : lines));
    node.addEventListener("mouseleave", hideTip);
    return node;
  };

  function persist() {
    vscode.setState({ metric: state.metric, sort: state.sort, view: state.view });
  }

  // --- rendering -----------------------------------------------------------
  function render() {
    const p = state.payload;
    if (!p) return;
    const t = p.set.table;
    const cmp = p.compare ? p.compare.table : null;
    if (!state.metric || !t.columns.some((c) => c.id === state.metric)) {
      const prefer = ["metrics.rb.prx.drag_crf.fidelity:par=d1", "characterization.model.t1_time"];
      state.metric = (prefer.map((id) => t.columns.find((c) => c.id === id)).find(Boolean) || t.columns[0])?.id || null;
    }
    const col = t.columns.find((c) => c.id === state.metric);
    const cmpCol = cmp && col ? cmp.columns.find((c) => c.id === col.id) : null;

    renderHeader(p);
    renderControls(p, t);
    renderTiles(t, cmp);
    renderChart(t, col, cmpCol, p);
    renderChip(t, col, cmpCol);
    renderTable(t, cmp);
    renderOthers(t, cmp);
    persist();
  }

  function setMeta(set) {
    const bits = [];
    if (set.backend) bits.push(set.backend);
    if (set.dutLabel) bits.push(`chip ${set.dutLabel}`);
    if (set.createdAt) bits.push(`calibrated ${new Date(set.createdAt).toLocaleString()}`);
    bits.push(`${set.observationCount} observations`);
    return bits.join(" · ");
  }

  function renderHeader(p) {
    const s = p.set;
    const chips = [];
    if (s.current) chips.push(el("span", { class: "chip" }, "current"));
    if (s.invalid) chips.push(el("span", { class: "chip warn" }, "⚠ marked invalid"));
    if (s.fetchedAt)
      chips.push(el("span", { class: "muted small" }, `fetched ${new Date(s.fetchedAt).toLocaleString()}`));
    $("#header").replaceChildren(
      el("h2", {}, "Calibration set ", el("code", {}, s.calibrationSetId)),
      el("div", { class: "row" }, el("span", { class: "muted" }, setMeta(s)), ...chips),
      el(
        "div",
        { class: "row" },
        el(
          "button",
          { class: "primary", onclick: () => vscode.postMessage({ type: "refresh" }) },
          s.current ? "Refresh current" : "Reload",
        ),
        el("button", { onclick: () => vscode.postMessage({ type: "export" }) }, "Export CSV…"),
        el("button", { onclick: () => vscode.postMessage({ type: "copy" }) }, "Copy ID"),
      ),
    );
  }

  function renderControls(p, t) {
    const groups = new Map();
    for (const c of t.columns) {
      if (!groups.has(c.info.group)) groups.set(c.info.group, []);
      groups.get(c.info.group).push(c);
    }
    const metricSel = el(
      "select",
      {
        id: "metric",
        onchange: (e) => {
          state.metric = e.target.value;
          render();
        },
      },
      [...groups].map(([g, cols]) =>
        el(
          "optgroup",
          { label: g },
          cols.map((c) =>
            el("option", { value: c.id, selected: c.id === state.metric }, `${c.info.label} (${c.info.unit || "—"})`),
          ),
        ),
      ),
    );
    const others = p.known.filter((k) => k.id !== p.set.calibrationSetId);
    const cmpSel = el(
      "select",
      {
        id: "compare",
        onchange: (e) => vscode.postMessage({ type: "compare", id: e.target.value || null }),
      },
      el("option", { value: "" }, "(none)"),
      others.map((k) =>
        el("option", { value: k.id, selected: p.compare && p.compare.calibrationSetId === k.id }, k.label),
      ),
    );
    const viewSel = p.compare
      ? el(
          "label",
          {},
          "Table shows ",
          el(
            "select",
            {
              onchange: (e) => {
                state.view = e.target.value;
                render();
              },
            },
            el("option", { value: "values", selected: state.view === "values" }, "values"),
            el("option", { value: "change", selected: state.view === "change" }, "change vs. compared set"),
          ),
        )
      : null;
    $("#controls").replaceChildren(
      ...[
        el("label", {}, "Metric ", metricSel),
        el("label", {}, "Compare with ", cmpSel),
        viewSel,
        p.compare ? el("span", { class: "muted small" }, `compared set: ${setMeta(p.compare)}`) : null,
      ].filter(Boolean),
    );
  }

  const TILE_METRICS = [
    "characterization.model.t1_time",
    "characterization.model.t2_echo_time",
    "metrics.rb.prx.drag_crf.fidelity:par=d1",
    "metrics.irb.cz.crf_crf.fidelity@COMPR1",
    "metrics.irb.move.crf_crf.fidelity:n_interleaved_gates=2@COMPR1",
    "metrics.ssro.measure.constant.fidelity",
  ];
  function renderTiles(t, cmp) {
    const tiles = [];
    const ids = TILE_METRICS.filter((id) => t.columns.some((c) => c.id === id));
    for (const id of ids.length ? ids : t.columns.slice(0, 6).map((c) => c.id)) {
      const col = t.columns.find((c) => c.id === id);
      const st = stats(col);
      if (!st) continue;
      const worst = st.ranking[0];
      const cmpCol = cmp ? cmp.columns.find((c) => c.id === id) : null;
      const cst = cmpCol ? stats(cmpCol) : null;
      tiles.push(
        el(
          "button",
          {
            class: `tile${id === state.metric ? " selected" : ""}`,
            title: `Show ${col.info.label}`,
            onclick: () => {
              state.metric = id;
              render();
            },
          },
          el("span", { class: "tile-label" }, `${col.info.label} · median`),
          el("span", { class: "tile-value" }, fmtUnit(col.info, st.median)),
          cst
            ? el(
                "span",
                { class: "small" },
                `${fmtDelta(col.info, improvement(col.info, cst.median, st.median))} vs. compared`,
              )
            : null,
          el("span", { class: "small muted" }, `worst ${worst}: ${fmtUnit(col.info, col.values[worst].value)}`),
        ),
      );
    }
    const ghz = t.multi.find((r) => r.metric === "metrics.ghz_state.population");
    if (ghz) {
      tiles.push(
        el(
          "div",
          { class: "tile static" },
          el("span", { class: "tile-label" }, `GHZ population, ${ghz.locus.length} qubits`),
          el("span", { class: "tile-value" }, fmtUnit(ghz.info, ghz.value)),
        ),
      );
    }
    $("#tiles").replaceChildren(...tiles);
  }

  function renderChart(t, col, cmpCol, p) {
    const host = $("#chart");
    if (!col) {
      host.replaceChildren(el("p", { class: "muted" }, "No per-qubit metrics in this calibration set."));
      return;
    }
    const qubits = t.qubits.filter((q) => col.values[q] || cmpCol?.values[q]);
    const W = Math.max(560, host.clientWidth || 760);
    const H = 260;
    const m = { l: 64, r: 16, t: 16, b: 44 };
    const all = [];
    for (const c of [col, cmpCol]) {
      if (!c) continue;
      for (const q of qubits) {
        const v = c.values[q];
        if (!v) continue;
        all.push(v.value - (v.uncertainty || 0), v.value + (v.uncertainty || 0));
      }
    }
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (col.info.unit === "%") hi = Math.min(hi, 1);
    const padv = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 0.01;
    lo -= padv;
    hi += padv;
    const x = (i) => m.l + ((i + 0.5) * (W - m.l - m.r)) / qubits.length;
    const y = (v) => m.t + ((hi - Math.max(lo, Math.min(hi, v))) * (H - m.t - m.b)) / (hi - lo);
    const g = svg("svg", {
      viewBox: `0 0 ${W} ${H}`,
      width: "100%",
      role: "img",
      "aria-label": `${col.info.label} per qubit`,
    });
    // grid + y axis
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const v = lo + ((hi - lo) * i) / ticks;
      g.append(svg("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "grid" }));
      g.append(svg("text", { x: m.l - 6, y: y(v) + 4, class: "axis", "text-anchor": "end" }, fmt(col.info, v)));
    }
    g.append(
      svg(
        "text",
        {
          x: 12,
          y: m.t + (H - m.t - m.b) / 2,
          class: "axis",
          transform: `rotate(-90 12 ${m.t + (H - m.t - m.b) / 2})`,
          "text-anchor": "middle",
        },
        col.info.unit || col.info.label,
      ),
    );
    // median line
    const st = stats(col);
    if (st) {
      g.append(svg("line", { x1: m.l, x2: W - m.r, y1: y(st.median), y2: y(st.median), class: "median" }));
    }
    const series = [{ c: col, cls: "s1", dx: cmpCol ? -5 : 0, name: "this set" }];
    if (cmpCol) series.push({ c: cmpCol, cls: "s2", dx: 5, name: "compared set" });
    qubits.forEach((q, i) => {
      g.append(svg("text", { x: x(i), y: H - m.b + 16, class: "axis", "text-anchor": "middle" }, q.replace(/^QB/, "")));
      for (const s of series) {
        const v = s.c.values[q];
        if (!v) continue;
        const cx = x(i) + s.dx;
        if (v.uncertainty) {
          g.append(
            svg("line", {
              x1: cx,
              x2: cx,
              y1: y(Math.min(hi, v.value + v.uncertainty)),
              y2: y(Math.max(lo, v.value - v.uncertainty)),
              class: `whisker ${s.cls}`,
            }),
          );
        }
        g.append(svg("circle", { cx, cy: y(v.value), r: 4.5, class: `dot ${s.cls}` }));
        const hit = svg("rect", { x: cx - 9, y: m.t, width: 18, height: H - m.t - m.b, class: "hit" });
        hover(hit, () => {
          const lines = [
            `${q} · ${col.info.label}`,
            `${s.name}: ${fmtUnit(col.info, v.value)}${v.uncertainty ? ` ± ${fmt(col.info, v.uncertainty)}` : ""}`,
          ];
          const other = series.find((o) => o !== s);
          const ov = other?.c.values[q];
          if (ov) lines.push(`${other.name}: ${fmtUnit(col.info, ov.value)}`);
          if (cmpCol && col.values[q] && cmpCol.values[q])
            lines.push(
              `change: ${fmtDelta(col.info, improvement(col.info, cmpCol.values[q].value, col.values[q].value))} (positive = better)`,
            );
          if (st) lines.push(`rank: ${st.ranking.length - st.ranking.indexOf(q)} of ${st.ranking.length} (1 = best)`);
          return lines;
        });
        g.append(hit);
      }
    });
    g.append(
      svg(
        "text",
        { x: m.l + (W - m.l - m.r) / 2, y: H - 6, class: "axis", "text-anchor": "middle" },
        "qubit (QB number)",
      ),
    );
    const legend = cmpCol
      ? el(
          "div",
          { class: "legend" },
          el("span", {}, el("i", { class: "swatch s1" }), "this set"),
          el("span", {}, el("i", { class: "swatch s2" }), `compared set ${p.compare.calibrationSetId.slice(0, 8)}…`),
          el(
            "span",
            { class: "muted" },
            `whiskers: ± uncertainty · dashed: median of this set (${st ? fmtUnit(col.info, st.median) : "—"})`,
          ),
        )
      : el(
          "div",
          { class: "legend muted" },
          `${col.info.label}${col.info.better === "lower" ? " (lower is better)" : " (higher is better)"} · whiskers: ± uncertainty · dashed: median${st ? ` (${fmtUnit(col.info, st.median)})` : ""}`,
        );
    host.replaceChildren(g, legend);
  }

  function renderChip(t, col, cmpCol) {
    const host = $("#chip");
    if (!col || !t.qubits.length) {
      host.replaceChildren();
      return;
    }
    const st = stats(col);
    const W = 420;
    const H = 420;
    const cx = W / 2;
    const cy = H / 2;
    const R = 165;
    const g = svg("svg", {
      viewBox: `0 0 ${W} ${H}`,
      width: "100%",
      style: "max-width:460px",
      role: "img",
      "aria-label": `Chip layout coloured by ${col.info.label}`,
    });
    const pos = {};
    t.qubits.forEach((q, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / t.qubits.length;
      pos[q] = [cx + R * Math.cos(a), cy + R * Math.sin(a)];
    });
    const hubs = t.others;
    hubs.forEach((h, i) => {
      pos[h] =
        hubs.length === 1
          ? [cx, cy]
          : [cx + 40 * Math.cos((2 * Math.PI * i) / hubs.length), cy + 40 * Math.sin((2 * Math.PI * i) / hubs.length)];
    });
    // edges: qubit–partner columns (e.g. CZ / MOVE through the resonator)
    const edgeCols = t.columns.filter((c) => c.partner);
    const edgeCol = col.partner ? col : edgeCols[0];
    if (edgeCol) {
      const est = stats(edgeCol);
      for (const [q, v] of Object.entries(edgeCol.values)) {
        if (!pos[q] || !pos[edgeCol.partner]) continue;
        const gd = est ? goodness(edgeCol.info, v.value, est.min, est.max) : 1;
        const line = svg("line", {
          x1: pos[q][0],
          y1: pos[q][1],
          x2: pos[edgeCol.partner][0],
          y2: pos[edgeCol.partner][1],
          class: "edge",
          style: `stroke:${col.partner ? seqVar(gd) : "var(--edge)"}`,
        });
        hover(line, [`${q} – ${edgeCol.partner}`, `${edgeCol.info.label}: ${fmtUnit(edgeCol.info, v.value)}`]);
        g.append(line);
      }
    }
    for (const h of hubs) {
      const node = svg(
        "g",
        { transform: `translate(${pos[h][0]} ${pos[h][1]})` },
        svg("rect", { x: -30, y: -14, width: 60, height: 28, rx: 6, class: "hub" }),
        svg("text", { y: 4, class: "node-label", "text-anchor": "middle" }, h),
      );
      const rows = t.otherRows
        .filter((r) => r.locus[0] === h)
        .map((r) => `${r.info.label}: ${fmtUnit(r.info, r.value)}`);
      hover(node, [h, ...rows]);
      g.append(node);
    }
    for (const q of t.qubits) {
      const v = col.partner ? null : col.values[q];
      const gd = v && st ? goodness(col.info, v.value, st.min, st.max) : null;
      const fill = gd === null ? "var(--node-empty)" : seqVar(gd);
      const node = svg(
        "g",
        { transform: `translate(${pos[q][0]} ${pos[q][1]})` },
        svg("circle", { r: 17, class: "node", style: `fill:${fill}` }),
        svg(
          "text",
          {
            y: 4,
            class: "node-label",
            "text-anchor": "middle",
            style: `fill:${gd === null ? "var(--ink-on-light)" : seqInk(gd)}`,
          },
          q.replace(/^QB/, ""),
        ),
      );
      hover(node, () => {
        const lines = [q];
        for (const c of t.columns) {
          const cv = c.values[q];
          if (!cv) continue;
          const prev = cmpCol && c.id === col.id ? cmpCol.values[q] : null;
          lines.push(
            `${c.info.label}: ${fmtUnit(c.info, cv.value)}${prev ? ` (${fmtDelta(c.info, improvement(c.info, prev.value, cv.value))})` : ""}`,
          );
        }
        return lines;
      });
      node.style.cursor = "default";
      g.append(node);
    }
    const scaleCol = col.partner ? edgeCol : col;
    const sst = stats(scaleCol);
    const legend = el(
      "div",
      { class: "legend" },
      el("span", { class: "muted" }, `${col.partner ? "Links" : "Qubits"} coloured by ${scaleCol.info.label}:`),
      sst
        ? el("span", {}, `${fmtUnit(scaleCol.info, scaleCol.info.better === "higher" ? sst.min : sst.max)} (worst)`)
        : null,
      el(
        "span",
        { class: "ramp" },
        SEQ.map((v) => el("i", { style: `background:var(${v})` })),
      ),
      sst
        ? el("span", {}, `${fmtUnit(scaleCol.info, scaleCol.info.better === "higher" ? sst.max : sst.min)} (best)`)
        : null,
    );
    host.replaceChildren(g, legend);
  }

  function renderTable(t, cmp) {
    const host = $("#table");
    const showChange = cmp && state.view === "change";
    const cols = t.columns;
    const statsById = Object.fromEntries(cols.map((c) => [c.id, stats(c)]));
    const cmpById = cmp ? Object.fromEntries(cmp.columns.map((c) => [c.id, c])) : {};
    const rows = [...t.qubits];
    if (state.sort) {
      const c = cols.find((x) => x.id === state.sort.id);
      if (c) {
        const val = (q) => {
          const v = c.values[q];
          if (!v) return Number.NaN;
          if (showChange) {
            const pv = cmpById[c.id] && cmpById[c.id].values[q];
            return pv ? improvement(c.info, pv.value, v.value) : Number.NaN;
          }
          return c.info.better === "higher" ? v.value : -v.value;
        };
        rows.sort((a, b) => {
          const va = val(a);
          const vb = val(b);
          if (Number.isNaN(va)) return 1;
          if (Number.isNaN(vb)) return -1;
          return state.sort.dir * (va - vb);
        });
      }
    }
    const head = el(
      "tr",
      {},
      el("th", { class: "sticky" }, "Qubit"),
      cols.map((c) =>
        el(
          "th",
          {
            title: `${c.info.label} (${c.info.unit || "—"}, ${c.info.better} is better). Click to sort; again to reverse.`,
            class: `${c.id === state.metric ? "selected" : ""} sortable`,
            onclick: () => {
              state.sort =
                state.sort && state.sort.id === c.id ? { id: c.id, dir: -state.sort.dir } : { id: c.id, dir: 1 };
              state.metric = c.id;
              render();
            },
          },
          c.info.short,
          el("div", { class: "unit" }, showChange ? (c.info.unit === "%" ? "pp" : c.info.unit) : c.info.unit),
          state.sort && state.sort.id === c.id ? (state.sort.dir > 0 ? " ▲" : " ▼") : "",
        ),
      ),
    );
    const body = rows.map((q) =>
      el(
        "tr",
        {},
        el("th", { class: "sticky" }, q),
        cols.map((c) => {
          const v = c.values[q];
          if (!v) return el("td", { class: "empty" }, "—");
          const st = statsById[c.id];
          if (showChange) {
            const pv = cmpById[c.id] && cmpById[c.id].values[q];
            if (!pv) return el("td", { class: "empty", title: "not in the compared set" }, "new");
            const d = improvement(c.info, pv.value, v.value);
            const range = st ? (st.max - st.min) * c.info.scale : 0;
            const td = el(
              "td",
              { style: `background:${divVar(d, range)}` },
              fmtDelta(c.info, d).replace(/ (pp|µs|.+)$/, ""),
            );
            return hover(td, [
              `${q} · ${c.info.label}`,
              `now ${fmtUnit(c.info, v.value)}`,
              `before ${fmtUnit(c.info, pv.value)}`,
              `change ${fmtDelta(c.info, d)} (positive = better)`,
            ]);
          }
          const gd = st ? goodness(c.info, v.value, st.min, st.max) : 1;
          const worst = st && st.ranking.length >= 5 && st.ranking.indexOf(q) < 2;
          const td = el(
            "td",
            { style: `background:${seqVar(gd)};color:${seqInk(gd)}` },
            `${worst ? "⚠ " : ""}${fmt(c.info, v.value)}`,
          );
          return hover(
            td,
            [
              `${q} · ${c.info.label}`,
              `${fmtUnit(c.info, v.value)}${v.uncertainty ? ` ± ${fmt(c.info, v.uncertainty)}` : ""}`,
              st
                ? `median ${fmtUnit(c.info, st.median)} · rank ${st.ranking.length - st.ranking.indexOf(q)} of ${st.ranking.length}`
                : "",
              worst ? "⚠ among the two worst qubits for this metric" : "",
            ].filter(Boolean),
          );
        }),
      ),
    );
    const foot = el(
      "tr",
      { class: "foot" },
      el("th", { class: "sticky" }, "median"),
      cols.map((c) => {
        const st = statsById[c.id];
        return el("td", {}, st ? fmt(c.info, st.median) : "—");
      }),
    );
    host.replaceChildren(
      el(
        "p",
        { class: "muted small" },
        showChange
          ? "Change from the compared set to this one, in display units; blue = better, red = worse, grey ≈ no change."
          : "Darker = better within each column. ⚠ marks the two worst qubits per metric. Click a header to sort and plot it.",
      ),
      el(
        "div",
        { class: "scroll" },
        el("table", { class: "grid-table" }, el("thead", {}, head), el("tbody", {}, body, foot)),
      ),
    );
  }

  function renderOthers(t, cmp) {
    const host = $("#others");
    const rows = [...t.otherRows, ...t.multi];
    if (!rows.length) {
      host.replaceChildren();
      return;
    }
    const key = (r) => `${r.metric}|${r.locus.join("__")}`;
    const prev = cmp ? new Map([...cmp.otherRows, ...cmp.multi].map((r) => [key(r), r])) : new Map();
    const loc = (l) => (l.length > 6 ? `${l.slice(0, 3).join(", ")}, … (${l.length})` : l.join(", "));
    host.replaceChildren(
      el("h3", {}, "Other components and multi-qubit metrics"),
      el(
        "div",
        { class: "scroll" },
        el(
          "table",
          { class: "plain" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", {}, "Metric"),
              el("th", {}, "Components"),
              el("th", { class: "num" }, "Value"),
              cmp ? el("th", { class: "num" }, "Change") : null,
            ),
          ),
          el(
            "tbody",
            {},
            rows.map((r) => {
              const p = prev.get(key(r));
              return el(
                "tr",
                {},
                el("td", { title: r.metric }, r.info.label),
                el("td", { title: r.locus.join(", ") }, loc(r.locus)),
                el(
                  "td",
                  { class: "num" },
                  `${fmtUnit(r.info, r.value)}${r.uncertainty ? ` ± ${fmt(r.info, r.uncertainty)}` : ""}`,
                ),
                cmp
                  ? el("td", { class: "num" }, p ? fmtDelta(r.info, improvement(r.info, p.value, r.value)) : "—")
                  : null,
              );
            }),
          ),
        ),
      ),
    );
  }

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg && msg.type === "data") {
      state.payload = msg.payload;
      $("#loading").hidden = true;
      render();
    } else if (msg && msg.type === "busy") {
      $("#loading").hidden = !msg.busy;
      $("#loading").textContent = msg.text || "Loading…";
    }
  });
  window.addEventListener("resize", () => render());
  vscode.postMessage({ type: "ready" });
})();
