/**
 * Readiness for LEXIS work: a Python 3.12 interpreter with qaas, and a LEXIS sign-in
 * (browser login, a pasted refresh/access token, or the dev connection file).
 */

import * as vscode from "vscode";
import type { Bridge } from "./bridge";
import { currentTarget, devEnvPath, devOverrides, lexisInstance, lexisToken, TOKEN_KEY } from "./config";
import { instanceLabel } from "./core/devEnv";
import { createEnvironment, installQaas, selectInterpreter } from "./environments";

export interface CheckData {
  pythonOk?: boolean;
  python: string;
  executable: string;
  packages: Record<string, string | null>;
  importable: boolean;
  importError?: string;
  qaasOutdated: boolean;
}

export interface WhoAmI {
  user?: string;
  issuer?: string;
  expiresAt?: string;
  tokenKind: "login" | "refresh" | "access";
}

/** "LEXIS test" / "LEXIS" for messages. */
export function lexisName(): string {
  const label = instanceLabel(lexisInstance());
  return label ? `LEXIS ${label}` : "LEXIS";
}

async function offerFix(message: string, d?: CheckData): Promise<void> {
  const actions = ["Select Interpreter", "Create Environment"];
  if (d?.pythonOk && (!d.importable || d.qaasOutdated)) {
    actions.unshift(d.importable ? "Upgrade qaas" : "Install qaas");
  }
  const choice = await vscode.window.showWarningMessage(message, ...actions);
  if (choice === "Select Interpreter") {
    await selectInterpreter();
  } else if (choice === "Create Environment") {
    await createEnvironment();
  } else if (choice) {
    await installQaas(d?.executable);
  }
}

/** Problem with the interpreter, or undefined when it can run qaas. */
function problemOf(d: CheckData): string | undefined {
  if (d.pythonOk === false) {
    return `QaaS needs Python 3.12 with qaas; the selected interpreter is Python ${d.python} (${d.executable}).`;
  }
  if (!d.importable) {
    return `QaaS: qaas is not installed in ${d.executable}${d.importError ? ` (${d.importError})` : ""}.`;
  }
  if (d.qaasOutdated) {
    return `QaaS: qaas ${d.packages.qaas} is older than 1.0.0.`;
  }
  return undefined;
}

/**
 * Check the interpreter once per bridge process. Shows what to do when it cannot run qaas.
 * With `report`, prints the package versions and confirms a working setup.
 */
export async function ensureEnvironment(
  bridge: Bridge,
  output: vscode.OutputChannel,
  report = false,
): Promise<boolean> {
  if (bridge.environmentOk && !report) {
    return true;
  }
  let d: CheckData;
  try {
    d = await bridge.request<CheckData>("check");
  } catch (e) {
    output.appendLine(`[environment] check failed: ${(e as Error).message}`);
    await offerFix(`QaaS: could not run Python (${(e as Error).message}).`);
    return false;
  }
  if (report) {
    output.appendLine(`Python ${d.python} at ${d.executable}`);
    for (const [name, ver] of Object.entries(d.packages)) {
      output.appendLine(`  ${name}: ${ver ?? "not installed"}`);
    }
    if (d.importError) {
      output.appendLine(`  import error: ${d.importError}`);
    }
  }
  const problem = problemOf(d);
  if (problem) {
    output.appendLine(`[environment] ${problem}`);
    await offerFix(problem, d);
    return false;
  }
  bridge.environmentOk = true;
  if (report) {
    vscode.window.showInformationMessage(`QaaS: qaas ${d.packages.qaas} is ready (Python ${d.python}).`);
  }
  return true;
}

type SignInChoice = "browser" | "token" | "devFile";

/**
 * Ask how to sign in, then sign in and verify. Returns false when cancelled or failed.
 * Used by "Sign in to LEXIS…", and by every LEXIS command when no sign-in exists yet.
 */
export async function signIn(
  bridge: Bridge,
  secrets: vscode.SecretStorage,
  output: vscode.OutputChannel,
): Promise<boolean> {
  if (!(await ensureEnvironment(bridge, output))) {
    return false;
  }
  const name = lexisName();
  const items: (vscode.QuickPickItem & { choice: SignInChoice })[] = [
    {
      choice: "browser",
      label: "$(globe) Log in with the browser",
      detail: "Opens the LEXIS login page. The session lasts until VS Code closes.",
    },
    {
      choice: "token",
      label: "$(key) Paste a token",
      detail:
        "A refresh/offline token (renewed automatically) or an access token (expires in minutes). Stored in VS Code secret storage.",
    },
    {
      choice: "devFile",
      label: "$(file) Use a dev connection file",
      detail:
        "Instance URLs, project, resource and token in a git-ignored .qaas/dev.env (e.g. the LEXIS test instance).",
    },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: `Sign in to ${name}`,
    placeHolder: "How do you want to sign in?",
    ignoreFocusOut: true,
  });
  if (!pick) {
    return false;
  }
  if (pick.choice === "devFile") {
    await vscode.commands.executeCommand("qaas.openDevConnection");
    vscode.window.showInformationMessage(
      "QaaS: fill in the dev connection file and save it, then run Synchronize with LEXIS Platform again.",
    );
    return false;
  }
  if (pick.choice === "token") {
    const token = await vscode.window.showInputBox({
      title: `${name} token`,
      prompt: "Refresh/offline token (recommended) or access token",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) =>
        v
          .trim()
          .replace(/^["']|["']$/g, "")
          .split(".").length === 3
          ? undefined
          : "Expected a JWT (three dot-separated parts)",
    });
    if (!token) {
      return false;
    }
    if (devOverrides().QAAS_LEXIS_TOKEN) {
      vscode.window.showWarningMessage(
        `QaaS: ${devEnvPath()} sets QAAS_LEXIS_TOKEN, which takes precedence over the pasted token.`,
      );
    }
    await secrets.store(TOKEN_KEY, token.trim().replace(/^["']|["']$/g, ""));
    bridge.restart();
  }
  return verifySignIn(bridge, secrets, output, pick.choice === "token");
}

async function verifySignIn(
  bridge: Bridge,
  secrets: vscode.SecretStorage,
  output: vscode.OutputChannel,
  pastedToken: boolean,
): Promise<boolean> {
  const name = lexisName();
  try {
    const me = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: pastedToken ? `QaaS: signing in to ${name}…` : `QaaS: waiting for the ${name} login in the browser…`,
        cancellable: true,
      },
      async (_p, token) => bridge.call<WhoAmI>("whoami", await currentTarget(secrets), {}, token),
    );
    output.appendLine(`[session] signed in to ${name} as ${me.user ?? "?"} (${me.tokenKind})`);
    vscode.window.showInformationMessage(`QaaS: signed in to ${name} as ${me.user ?? "?"}.`);
    return true;
  } catch (e) {
    output.appendLine(`[session] sign-in failed: ${(e as Error).message}`);
    if (pastedToken) {
      await secrets.delete(TOKEN_KEY);
    }
    vscode.window.showErrorMessage(`QaaS: sign-in to ${name} failed: ${(e as Error).message}`);
    return false;
  }
}

/** Python with qaas, and a sign-in (token or a login in this session); asks for what is missing. */
export async function ensureReady(
  bridge: Bridge,
  secrets: vscode.SecretStorage,
  output: vscode.OutputChannel,
): Promise<boolean> {
  if (!(await ensureEnvironment(bridge, output))) {
    return false;
  }
  if (bridge.authenticated || (await lexisToken(secrets))) {
    return true;
  }
  return signIn(bridge, secrets, output);
}
