import * as vscode from "vscode";
import { cfg } from "./config";
import { estimate, formatRange, VLQ_BILLING } from "./core/estimate";
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
  low: number;
  high: number;
}

/** qaas submissions in a Python file or notebook cell, with estimates. */
export function detectCalls(doc: vscode.TextDocument): DetectedCall[] {
  const prelude = notebookPrelude(doc);
  const text = doc.getText();
  if (!mentionsQaas(`${prelude}\n${text}`)) {
    return [];
  }
  return scanRunCalls(text, prelude).map((c) => {
    const e = estimate({ shots: c.shots, circuits: c.circuits ?? 1 });
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
    return detectCalls(doc).map((c) => {
      const range = new vscode.Range(c.line, 0, c.line, 0);
      const e = estimate({ shots: c.shots, circuits: c.circuits ?? 1 });
      return new vscode.CodeLens(range, {
        title: `$(watch) VLQ billed ≈ ${formatRange(e)} · ${describeCall(c)}`,
        tooltip:
          `Estimated VLQ consumption: VLQ jobs × max(shots × (350 µs + circuit time ≤ 50 µs), 0.9 s). ` +
          `Each circuit counts as one VLQ job. Click to open the estimator.`,
        command: "qaas.openEstimator",
        arguments: [{ shots: c.shots, circuits: c.circuits ?? 1 }],
      });
    });
  }

  private qasmLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const shots = cfg().get<number>("defaultShots") ?? 1024;
    const e = estimate({ shots, circuits: 1 });
    const range = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(range, { title: "$(play) Run on VLQ", command: "qaas.runQasm", arguments: [doc.uri] }),
      new vscode.CodeLens(range, {
        title: "$(git-compare) Transpile",
        command: "qaas.transpileQasm",
        arguments: [doc.uri],
      }),
      new vscode.CodeLens(range, {
        title: `$(watch) ≈ ${formatRange(e)} billed at ${shots.toLocaleString()} shots`,
        tooltip: `Estimate per ${VLQ_BILLING.docsUrl}. Change the default with qaas.defaultShots.`,
        command: "qaas.openEstimator",
        arguments: [{ shots, circuits: 1 }],
      }),
    ];
  }
}
