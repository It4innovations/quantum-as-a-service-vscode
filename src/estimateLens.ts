import * as vscode from "vscode";
import { backendLabel, backendName, cfg } from "./config";
import { billingModel, estimate, formatRange, formulaText } from "./core/estimate";
import { parseOperatorDirectives } from "./core/operators";
import { mentionsQaas, type RunCall, scanRunCalls } from "./core/runScanner";

export const PYTHON_SELECTOR: vscode.DocumentSelector = [
  { language: "python", scheme: "file" },
  { language: "python", scheme: "untitled" },
  { language: "python", scheme: "vscode-notebook-cell" },
];
export const QASM_SELECTOR: vscode.DocumentSelector = [{ language: "openqasm" }, { pattern: "**/*.qasm" }];

export function isQasm(doc: vscode.TextDocument): boolean {
  return doc.languageId === "openqasm" || doc.fileName.toLowerCase().endsWith(".qasm");
}

/** Text of the notebook cells before `doc`, used to resolve names defined earlier. */
function notebookPrelude(doc: vscode.TextDocument): string {
  if (doc.uri.scheme !== "vscode-notebook-cell") {
    return "";
  }
  for (const nb of vscode.workspace.notebookDocuments) {
    const cells = nb.getCells();
    const idx = cells.findIndex((c) => c.document === doc);
    if (idx >= 0) {
      return cells
        .slice(0, idx)
        .filter((c) => c.kind === vscode.NotebookCellKind.Code)
        .map((c) => c.document.getText())
        .join("\n");
    }
  }
  return "";
}

export interface DetectedCall extends RunCall {
  /** Billed-time range; undefined when no billing model is known for the backend. */
  low?: number;
  high?: number;
}

/** qaas submissions in a Python file or notebook cell, with estimates where a billing model is known. */
export function detectCalls(doc: vscode.TextDocument): DetectedCall[] {
  const prelude = notebookPrelude(doc);
  const text = doc.getText();
  if (!mentionsQaas(`${prelude}\n${text}`)) {
    return [];
  }
  const model = billingModel(backendName());
  return scanRunCalls(text, prelude).map((c) => {
    if (!model) {
      return c;
    }
    const e = estimate({ shots: c.shots, circuits: c.circuits ?? 1 }, model);
    return { ...c, low: e.low, high: e.high };
  });
}

export function describeCall(c: RunCall): string {
  const circuits = c.circuits === undefined ? "per circuit" : `${c.circuits} circuit${c.circuits === 1 ? "" : "s"}`;
  const shots = `${c.shots.toLocaleString()} shots${c.shotsKnown ? "" : " (default)"}`;
  return `${circuits} × ${shots}`;
}

export class EstimateCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  refresh(): void {
    this.changed.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!cfg().get<boolean>("showEstimates", true)) {
      return [];
    }
    return isQasm(doc) ? this.qasmLenses(doc) : this.pythonLenses(doc);
  }

  private pythonLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const model = billingModel(backendName());
    return detectCalls(doc).map((c) => {
      const range = new vscode.Range(c.line, 0, c.line, 0);
      const args = [{ shots: c.shots, circuits: c.circuits ?? 1 }];
      if (!model) {
        return new vscode.CodeLens(range, {
          title: `$(watch) ${describeCall(c)} · no billing model for ${backendLabel()}`,
          tooltip: "QaaS knows the billing rules of some backends only; this one's cost cannot be estimated.",
          command: "qaas.openEstimator",
          arguments: args,
        });
      }
      const e = estimate(args[0], model);
      return new vscode.CodeLens(range, {
        title: `$(watch) ${model.backend} billed ≈ ${formatRange(e)} · ${describeCall(c)}`,
        tooltip:
          `Estimated ${model.backend} consumption: ${formulaText(model)}. ` +
          `Each circuit counts as one job. Click to open the estimator.`,
        command: "qaas.openEstimator",
        arguments: args,
      });
    });
  }

  private qasmLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const shots = cfg().get<number>("defaultShots") ?? 1024;
    const model = billingModel(backendName());
    const range = new vscode.Range(0, 0, 0, 0);
    const use = parseOperatorDirectives(doc.getText()).use;
    const pulse = Object.entries(use)
      .map(([g, n]) => `${g}=${n}`)
      .join(", ");
    return [
      new vscode.CodeLens(range, {
        title: `$(play) Run on ${backendName() ?? "QPU"}${pulse ? ` (${pulse})` : ""}`,
        tooltip: pulse ? "Pulse-level run with operators from .qaas/operators" : undefined,
        command: "qaas.runQasm",
        arguments: [doc.uri],
      }),
      new vscode.CodeLens(range, {
        title: "$(pulse) Run with operator…",
        tooltip: "Pulse-level run with a custom prx operator from the catalog",
        command: "qaas.runQasmWithOperator",
        arguments: [doc.uri],
      }),
      new vscode.CodeLens(range, {
        title: "$(git-compare) Transpile",
        command: "qaas.transpileQasm",
        arguments: [doc.uri],
      }),
      ...(model
        ? [
            new vscode.CodeLens(range, {
              title: `$(watch) ≈ ${formatRange(estimate({ shots, circuits: 1 }, model))} billed at ${shots.toLocaleString()} shots`,
              tooltip: `Estimate per ${model.docsUrl}. Change the default with qaas.defaultShots.`,
              command: "qaas.openEstimator",
              arguments: [{ shots, circuits: 1 }],
            }),
          ]
        : []),
    ];
  }
}
