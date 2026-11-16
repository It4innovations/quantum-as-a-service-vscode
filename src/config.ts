import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { type LexisInstance, normalizeInstance, parseDotenv, sameInstance, tokenKey } from "./core/devEnv";
import { serviceInstance } from "./core/workflowsAuth";
import { currentAuthMode, currentService, workflowsToken } from "./workflows";

export function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("qaas");
}

/** Connection parameters sent with every bridge request. */
export interface Target {
  project: string;
  resource: string;
  backend: string;
  token?: string;
  /** Non-production LEXIS instance; undefined means production. */
  instance?: LexisInstance;
}

/** Path of the developer connection file (may not exist). */
export function devEnvPath(): string {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: expandPath variable
  return expandPath(cfg().get<string>("devConnectionFile") || "${workspaceFolder}/.qaas/dev.env", {});
}

/** Overrides from the developer connection file; {} when it does not exist. */
export function devOverrides(): Record<string, string> {
  try {
    return parseDotenv(fs.readFileSync(devEnvPath(), "utf8"));
  } catch {
    return {};
  }
}

/**
 * LEXIS instance from the dev file, then settings; undefined for production. In workflows mode
 * the instance of the IT4I Workflows service (`qaas.workflowsService`); URLs from the dev file and
 * settings are not used.
 */
export function lexisInstance(dev = devOverrides()): LexisInstance | undefined {
  if (currentAuthMode() === "workflows") {
    return serviceInstance(currentService());
  }
  return normalizeInstance({
    aaiUrl: dev.PY4LEXIS_AAI_URL || cfg().get<string>("lexisAaiUrl"),
    apiUrl: dev.PY4LEXIS_API_URL || cfg().get<string>("lexisApiUrl"),
    realm: dev.PY4LEXIS_REALM || cfg().get<string>("lexisRealm"),
  });
}

export function lexisProject(dev = devOverrides()): string {
  return dev.QAAS_LEXIS_PROJECT || cfg().get<string>("lexisProject") || "";
}

/**
 * Token for a LEXIS instance (default: the current one). A token is only ever returned for the
 * instance it belongs to, so a workspace or dev file that points at another server cannot make
 * the extension send it there:
 * - the dev file's token, when the dev file selects this instance;
 * - the token stored in secret storage for this instance (stored per instance);
 * - the QAAS_LEXIS_TOKEN environment variable, for production only.
 * In workflows mode only the IT4I Workflows access token, and only for its own instance.
 */
export async function lexisToken(
  secrets: vscode.SecretStorage,
  instance: LexisInstance | undefined = lexisInstance(),
  dev = devOverrides(),
): Promise<string | undefined> {
  if (currentAuthMode() === "workflows") {
    const t = await workflowsToken();
    return t && sameInstance(instance, serviceInstance(t.service)) ? t.token : undefined;
  }
  if (dev.QAAS_LEXIS_TOKEN && sameInstance(instance, lexisInstance(dev))) {
    return dev.QAAS_LEXIS_TOKEN;
  }
  const stored = await secrets.get(tokenKey(instance));
  if (stored) {
    return stored;
  }
  return normalizeInstance(instance ?? {}) ? undefined : process.env.QAAS_LEXIS_TOKEN || undefined;
}

export async function currentTarget(secrets: vscode.SecretStorage): Promise<Target> {
  const dev = devOverrides();
  const instance = lexisInstance(dev);
  return {
    project: lexisProject(dev),
    resource: dev.QAAS_LEXIS_RESOURCE || cfg().get<string>("lexisResource") || "",
    backend: dev.QAAS_BACKEND_NAME || cfg().get<string>("backendName") || "VLQ",
    token: await lexisToken(secrets, instance, dev),
    instance,
  };
}

/** Environment variables for scripts and notebooks run against the current target. */
export function targetEnv(t: Target): Record<string, string> {
  const env: Record<string, string> = { LEXIS_PROJECT: t.project, LEXIS_RESOURCE: t.resource, QAAS_BACKEND: t.backend };
  if (t.token) {
    env.LEXIS_TOKEN = t.token;
  }
  if (t.instance?.aaiUrl) {
    env.PY4LEXIS_AAI_URL = t.instance.aaiUrl;
  }
  if (t.instance?.apiUrl) {
    env.PY4LEXIS_API_URL = t.instance.apiUrl;
  }
  if (t.instance?.realm) {
    env.PY4LEXIS_REALM = t.instance.realm;
  }
  return env;
}

/** Ask for the LEXIS project once and save it to user settings. */
export async function requireProject(): Promise<string | undefined> {
  let project: string | undefined = lexisProject();
  if (!project) {
    project = await vscode.window.showInputBox({
      title: "LEXIS project",
      prompt: "LEXIS project identifier (saved to settings)",
      ignoreFocusOut: true,
    });
    if (project) {
      await cfg().update("lexisProject", project, vscode.ConfigurationTarget.Global);
    }
  }
  return project || undefined;
}

export function sanitize(s: string): string {
  return (
    s
      .replace(/[^\w.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "job"
  );
}

/** Expand ${workspaceFolder}, ${userHome}, ${jobId}, ${jobName}, ${date} and a leading ~. */
export function expandPath(template: string, vars: Record<string, string>): string {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.join(os.homedir(), "qaas");
  const all: Record<string, string> = {
    workspaceFolder: ws,
    userHome: os.homedir(),
    date: new Date().toISOString().slice(0, 10),
    ...vars,
  };
  let out = template.replace(/\$\{(\w+)\}/g, (m, k: string) => all[k] ?? m);
  if (out === "~" || out.startsWith("~/")) {
    out = path.join(os.homedir(), out.slice(1));
  }
  return path.resolve(out);
}
