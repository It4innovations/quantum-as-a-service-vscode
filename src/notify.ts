/** Error notifications with a "Show Output" button for the QaaS output channel (details, tracebacks). */

import * as vscode from "vscode";

const SHOW_OUTPUT = "Show Output";
let channel: vscode.OutputChannel | undefined;

export function setOutputChannel(output: vscode.OutputChannel): void {
  channel = output;
}

/** `vscode.window.showErrorMessage` plus "Show Output"; resolves to the other button chosen, if any. */
export async function showError(message: string, ...items: string[]): Promise<string | undefined> {
  const choice = await vscode.window.showErrorMessage(message, ...items, SHOW_OUTPUT);
  if (choice === SHOW_OUTPUT) {
    channel?.show(true);
    return undefined;
  }
  return choice;
}
