/**
 * The IT4I Workflows extension as the sign-in of QaaS (`qaas.workflowsIntegration` on). Its `lexis` CLI
 * keeps the LEXIS session; QaaS asks it for a short-lived access token per use and keeps the token
 * in memory only. py4lexis is not used in this mode.
 */

import * as vscode from "vscode";
import {
  type AuthMode,
  authMode,
  errorCode,
  TokenCache,
  tokenMatchesService,
  WORKFLOWS_EXTENSION_ID,
  type WorkflowsAccessToken,
  type WorkflowsApi,
  type WorkflowsService,
  workflowsService,
} from "./core/workflowsAuth";

const tokens = new TokenCache();

export function currentAuthMode(): AuthMode {
  return authMode(
    vscode.workspace.getConfiguration("qaas").get<boolean>("workflowsIntegration"),
    vscode.extensions.getExtension(WORKFLOWS_EXTENSION_ID) !== undefined,
  );
}

export function currentService(): WorkflowsService {
  return workflowsService(vscode.workspace.getConfiguration("qaas").get<string>("workflowsService"));
}

/** Without IT4I Workflows, removes the settings it writes, so QaaS is back on its own sign-in. */
export async function forgetWorkflowsSettings(): Promise<void> {
  try {
    await forgetSettings();
  } catch (e) {
    // A read-only settings file: the mode still falls back to py4lexis without IT4I Workflows.
    console.warn(`QaaS: could not remove the IT4I Workflows settings: ${(e as Error).message}`);
  }
}

async function forgetSettings(): Promise<void> {
  if (vscode.extensions.getExtension(WORKFLOWS_EXTENSION_ID)) {
    return;
  }
  const settings = vscode.workspace.getConfiguration("qaas");
  for (const key of ["workflowsIntegration", "workflowsService"]) {
    const value = settings.inspect(key);
    // Workspace settings may be committed in a repository: they are left alone, and without
    // IT4I Workflows the mode falls back to py4lexis anyway.
    if (value?.globalValue !== undefined) {
      await settings.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
  }
}

export function invalidateWorkflowsToken(): void {
  tokens.invalidate();
}

async function workflowsApi(): Promise<WorkflowsApi | undefined> {
  const ext = vscode.extensions.getExtension<WorkflowsApi>(WORKFLOWS_EXTENSION_ID);
  if (!ext) {
    return undefined;
  }
  const api = ext.isActive ? ext.exports : await ext.activate();
  return api?.apiVersion === 1 ? api : undefined;
}

function checked(token: WorkflowsAccessToken, service: WorkflowsService): WorkflowsAccessToken {
  if (!tokenMatchesService(token, service)) {
    tokens.invalidate();
    throw new Error(
      `IT4I Workflows returned a token for another LEXIS instance (${token.apiUrl}); QaaS does not use it.`,
    );
  }
  return token;
}

/**
 * Access token of the IT4I Workflows sign-in for `qaas.workflowsService`. Undefined when the
 * extension is missing, signed out, or does not share its sign-in with QaaS.
 */
export async function workflowsToken(): Promise<WorkflowsAccessToken | undefined> {
  const api = await workflowsApi();
  if (!api) {
    return undefined;
  }
  const service = currentService();
  try {
    return checked(await tokens.get(() => api.getAccessToken(service)), service);
  } catch (e) {
    if (errorCode(e) === "auth_required" || errorCode(e) === "not_allowed") {
      return undefined;
    }
    throw e;
  }
}

async function offerInstall(): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "QaaS signs in through the IT4I Workflows extension (setting qaas.workflowsIntegration), which is not installed.",
    "Install",
    "Open Settings",
  );
  if (choice === "Install") {
    await vscode.commands.executeCommand("workbench.extensions.search", `@id:${WORKFLOWS_EXTENSION_ID}`);
  } else if (choice === "Open Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "qaas.workflowsIntegration");
  }
}

/** Show the IT4I Workflows sign-in. True once a token for QaaS is available. */
export async function signInWithWorkflows(): Promise<boolean> {
  const api = await workflowsApi();
  if (!api) {
    await offerInstall();
    return false;
  }
  const service = currentService();
  if (!(await api.signIn(service))) {
    return false;
  }
  tokens.invalidate();
  try {
    checked(await tokens.get(() => api.getAccessToken(service)), service);
    return true;
  } catch (e) {
    if (errorCode(e) === "not_allowed") {
      const choice = await vscode.window.showWarningMessage(
        "QaaS: IT4I Workflows does not share its sign-in with QaaS. Open QaaS again from IT4I Workflows, or turn off qaas.workflowsIntegration.",
        "Open Settings",
      );
      if (choice) {
        await vscode.commands.executeCommand("workbench.action.openSettings", "qaas.workflowsIntegration");
      }
      return false;
    }
    if (errorCode(e) === "auth_required") {
      return false;
    }
    throw e;
  }
}

/**
 * Calls `onChange` when the IT4I Workflows sign-in changes, in workflows mode only. Call the
 * returned `refresh` after the mode changes, including when IT4I Workflows is installed or removed.
 */
export function watchWorkflows(onChange: () => void): vscode.Disposable & { refresh(): void } {
  let sub: { dispose(): unknown } | undefined;
  let attempt = 0;
  const attach = async () => {
    const current = ++attempt;
    sub?.dispose();
    sub = undefined;
    if (currentAuthMode() !== "workflows") {
      return;
    }
    const api = await workflowsApi().catch(() => undefined);
    // A later refresh or a mode change while waiting for the API wins.
    if (current !== attempt || currentAuthMode() !== "workflows") {
      return;
    }
    sub = api?.onDidChangeSession(() => {
      tokens.invalidate();
      onChange();
    });
  };
  void attach();
  return {
    refresh: () => void attach(),
    dispose: () => {
      attempt++;
      sub?.dispose();
    },
  };
}
