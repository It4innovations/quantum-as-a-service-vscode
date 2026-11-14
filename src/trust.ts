import * as path from "node:path";
import * as vscode from "vscode";
import { cfg, devEnvPath, devOverrides, expandPath } from "./config";
import { type LexisInstance, normalizeInstance, PRODUCTION_AAI_URL, sameInstance } from "./core/devEnv";

/**
 * Values a cloned repository can supply (workspace settings, the dev file, a workspace venv) that
 * would let it run a program, write files outside the workspace, or show a fake login page. Each
 * is used only after the user allowed it once for that folder; declining falls back to the
 * user's own setting (or cancels, for the login).
 */
type Subject = "pythonPath" | "condaPath" | "resultsDirectory" | "interpreter" | "login";

const APPROVED_KEY = "qaas.approvedWorkspaceExecutables";

let state: vscode.Memento | undefined;
/** Values declined in this session (asked again after a restart). */
const declined = new Set<string>();
const asking = new Map<string, Promise<boolean>>();

export function initTrust(globalState: vscode.Memento): void {
  state = globalState;
}

function entry(subject: Subject, value: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "";
  return `${subject}\u0000${folder}\u0000${value}`;
}

function approved(): string[] {
  return state?.get<string[]>(APPROVED_KEY) ?? [];
}

async function approve(subject: Subject, value: string): Promise<void> {
  const e = entry(subject, value);
  declined.delete(e);
  if (state && !approved().includes(e)) {
    await state.update(APPROVED_KEY, [...approved(), e]);
  }
}

/** Ask once per folder and value; concurrent callers share one dialog. */
async function allowed(subject: Subject, value: string, question: () => Thenable<boolean>): Promise<boolean> {
  const e = entry(subject, value);
  if (approved().includes(e)) {
    return true;
  }
  if (declined.has(e)) {
    return false;
  }
  let pending = asking.get(e);
  if (!pending) {
    pending = Promise.resolve(question())
      .then(async (ok) => {
        if (ok) {
          await approve(subject, value);
        } else {
          declined.add(e);
        }
        return ok;
      })
      .finally(() => asking.delete(e));
    asking.set(e, pending);
  }
  return pending;
}

async function confirm(message: string, detail: string, allow = "Allow", deny = "Use My Default"): Promise<boolean> {
  return (await vscode.window.showWarningMessage(message, { modal: true, detail }, allow, deny)) === allow;
}

function insideWorkspace(p: string): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some((f) => {
    const rel = path.relative(f.uri.fsPath, p);
    return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

/** Remember an interpreter the user chose (Select Interpreter) for this workspace. */
export async function approveExecutable(setting: "pythonPath" | "condaPath", value: string): Promise<void> {
  await approve(setting, value);
}

/**
 * Effective value of a setting a workspace can point at something dangerous. A value from
 * workspace settings that differs from the user's own needs a one-time approval; declined, the
 * user's value is used. Results folders inside the workspace need no approval.
 */
export async function trustedSetting(
  setting: "pythonPath" | "condaPath" | "resultsDirectory",
): Promise<string | undefined> {
  const value = cfg().get<string>(setting) || undefined;
  const info = cfg().inspect<string>(setting);
  const user = info?.globalValue || undefined;
  const fromWorkspace = !!(info?.workspaceFolderValue || info?.workspaceValue);
  if (!value || !fromWorkspace || value === user || value === info?.defaultValue) {
    return value;
  }
  if (
    setting === "resultsDirectory" &&
    insideWorkspace(expandPath(value, { jobId: "1", jobName: "job", project: "p" }))
  ) {
    return value;
  }
  const detail: Record<typeof setting, string> = {
    pythonPath: "QaaS runs this Python interpreter and gives it your LEXIS token.",
    condaPath: "QaaS runs this program to create environments.",
    resultsDirectory: "QaaS writes downloaded job results there, outside this workspace.",
  };
  const ok = await allowed(setting, value, () =>
    confirm(
      `This workspace sets qaas.${setting} to a value QaaS has not used here before.`,
      `${value}\n\n${detail[setting]} Allow it only if you trust this workspace and recognise the path.`,
    ),
  );
  return ok ? value : user;
}

/**
 * An interpreter chosen by the Python extension that lives inside the workspace (e.g. a .venv a
 * repository ships) is run with your LEXIS token only after a one-time approval.
 */
export async function trustedInterpreter(exe: string): Promise<boolean> {
  if (!insideWorkspace(exe)) {
    return true;
  }
  return allowed("interpreter", exe, () =>
    confirm(
      "The Python extension selected an interpreter inside this workspace.",
      `${exe}\n\nQaaS runs it and gives it your LEXIS token. Allow it only if you created this environment or trust this workspace.`,
      "Allow",
      "Use Default Python",
    ),
  );
}

/** LEXIS instance from the user's own settings only (no workspace settings, no dev file). */
function userInstance(): LexisInstance | undefined {
  const g = (k: string) => cfg().inspect<string>(k)?.globalValue;
  return normalizeInstance({ aaiUrl: g("lexisAaiUrl"), apiUrl: g("lexisApiUrl"), realm: g("lexisRealm") });
}

/**
 * Browser login on a non-production LEXIS instance that the workspace or dev file selected:
 * the login page comes from that server, so confirm before opening it. Production and
 * instances from the user's own settings need no approval.
 */
export async function trustedLoginInstance(instance?: LexisInstance): Promise<boolean> {
  const i = normalizeInstance(instance ?? {});
  if (!i || sameInstance(i, userInstance())) {
    return true;
  }
  const dev = devOverrides();
  const source =
    dev.PY4LEXIS_AAI_URL || dev.PY4LEXIS_API_URL || dev.PY4LEXIS_REALM ? devEnvPath() : "workspace settings";
  const server = i.aaiUrl ?? PRODUCTION_AAI_URL;
  return allowed("login", `${i.aaiUrl ?? ""}|${i.apiUrl ?? ""}|${i.realm ?? ""}`, () =>
    confirm(
      `Log in to a non-production LEXIS instance at ${server}?`,
      `Set by ${source}${i.realm ? `, realm ${i.realm}` : ""}${i.apiUrl ? `, API ${i.apiUrl}` : ""}.\n\nThe browser login will show that server's page. Enter your LEXIS password only if you know this instance (e.g. the LEXIS test instance).`,
      "Log In",
      "Cancel",
    ),
  );
}
