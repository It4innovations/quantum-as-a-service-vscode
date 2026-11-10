import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { cfg } from "./config";
import { resolvePython } from "./python";

/** qaas supports exactly this Python minor version (requires-python >=3.12,<3.13). */
export const REQUIRED_PYTHON = "3.12";
export const QAAS_REQUIREMENT = ">=1.0.0,<2";

export type EnvKind = "venv" | "conda" | "pyenv" | "system";

export interface PyEnv {
  python: string;
  kind: EnvKind;
  /** Environment name shown in the picker (venv folder, conda env, pyenv version). */
  name: string;
  version?: string;
  qaas?: string | null;
  /** In a venv or conda env, so pip will not hit an externally managed system Python. */
  isolated?: boolean;
}

const isWin = process.platform === "win32";
const home = os.homedir();

function pythonIn(prefix: string): string {
  return isWin ? path.join(prefix, "python.exe") : path.join(prefix, "bin", "python");
}
function venvPython(dir: string): string {
  return isWin ? path.join(dir, "Scripts", "python.exe") : path.join(dir, "bin", "python");
}
function exists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
function subdirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve(err ? undefined : stdout));
  });
}

/** conda executable: CONDA_EXE, qaas.condaPath, common install locations, then PATH. */
export async function findConda(): Promise<string | undefined> {
  const configured = cfg().get<string>("condaPath");
  const bin = isWin ? path.join("Scripts", "conda.exe") : path.join("bin", "conda");
  const candidates = [
    configured,
    process.env.CONDA_EXE,
    ...["miniconda3", "anaconda3", "miniforge3", "mambaforge", "micromamba"].map((d) => path.join(home, d, bin)),
    "/opt/homebrew/Caskroom/miniconda/base/bin/conda",
    "/opt/homebrew/Caskroom/miniforge/base/bin/conda",
    "/opt/conda/bin/conda",
  ].filter((c): c is string => !!c);
  const found = candidates.find(exists);
  if (found) {
    return found;
  }
  return (await run(isWin ? "conda.exe" : "conda", ["--version"])) ? (isWin ? "conda.exe" : "conda") : undefined;
}

async function condaEnvs(): Promise<PyEnv[]> {
  const prefixes = new Set<string>();
  const conda = await findConda();
  if (conda) {
    const out = await run(conda, ["env", "list", "--json"]);
    try {
      for (const p of (JSON.parse(out ?? "{}").envs ?? []) as string[]) {
        prefixes.add(p);
      }
    } catch {
      // fall back to the folder scan below
    }
  }
  for (const base of ["miniconda3", "anaconda3", "miniforge3", "mambaforge"].map((d) => path.join(home, d))) {
    if (fs.existsSync(base)) {
      prefixes.add(base);
      for (const p of subdirs(path.join(base, "envs"))) {
        prefixes.add(p);
      }
    }
  }
  if (process.env.CONDA_PREFIX) {
    prefixes.add(process.env.CONDA_PREFIX);
  }
  return [...prefixes]
    .map((p) => ({ python: pythonIn(p), kind: "conda" as const, name: path.basename(p) }))
    .filter((e) => exists(e.python));
}

function pyenvEnvs(): PyEnv[] {
  const root = process.env.PYENV_ROOT || path.join(home, isWin ? path.join(".pyenv", "pyenv-win") : ".pyenv");
  return subdirs(path.join(root, "versions"))
    .map((dir) => ({ python: venvPython(dir), kind: "pyenv" as const, name: path.basename(dir) }))
    .filter((e) => exists(e.python));
}

function workspaceVenvs(): PyEnv[] {
  const out: PyEnv[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const name of [".venv", "venv", "env", ".env"]) {
      const py = venvPython(path.join(folder.uri.fsPath, name));
      if (exists(py)) {
        out.push({ python: py, kind: "venv", name: `${name} (${folder.name})` });
      }
    }
  }
  if (process.env.VIRTUAL_ENV) {
    out.push({
      python: venvPython(process.env.VIRTUAL_ENV),
      kind: "venv",
      name: path.basename(process.env.VIRTUAL_ENV),
    });
  }
  return out.filter((e) => exists(e.python));
}

/** Environments known to the Python extension, when it is installed. */
async function pythonExtensionEnvs(): Promise<PyEnv[]> {
  const ext = vscode.extensions.getExtension("ms-python.python");
  if (!ext) {
    return [];
  }
  try {
    const api = ext.isActive ? ext.exports : await ext.activate();
    const known = (api?.environments?.known ?? []) as {
      executable?: { uri?: vscode.Uri };
      environment?: { name?: string; folderUri?: vscode.Uri };
      tools?: string[];
    }[];
    return known
      .filter((k) => k.executable?.uri)
      .map((k) => {
        const tools = (k.tools ?? []).map((t) => t.toLowerCase());
        const kind: EnvKind = tools.includes("conda")
          ? "conda"
          : tools.includes("pyenv")
            ? "pyenv"
            : tools.some((t) => t.includes("venv") || t === "poetry" || t === "pipenv")
              ? "venv"
              : "system";
        const p = k.executable!.uri!.fsPath;
        return { python: p, kind, name: k.environment?.name ?? path.basename(path.dirname(path.dirname(p))) };
      });
  } catch {
    return [];
  }
}

async function systemPythons(): Promise<PyEnv[]> {
  const names = isWin ? ["py", "python"] : [`python${REQUIRED_PYTHON}`, "python3"];
  const out: PyEnv[] = [];
  for (const n of names) {
    const exe = await run(n, ["-c", "import sys; print(sys.executable)"]);
    if (exe?.trim()) {
      out.push({ python: exe.trim(), kind: "system", name: n });
    }
  }
  return out;
}

const PROBE = [
  "import json, os, sys",
  "from importlib import metadata as m",
  "try:\n    q = m.version('qaas')\nexcept Exception:\n    q = None",
  "iso = sys.prefix != sys.base_prefix or os.path.isdir(os.path.join(sys.prefix, 'conda-meta'))",
  "print(json.dumps([sys.version.split()[0], q, iso]))",
].join("\n");

/** Python version, installed qaas and whether the interpreter is in a venv/conda env. */
export async function probe(python: string): Promise<{ version?: string; qaas?: string | null; isolated?: boolean }> {
  const out = await run(python, ["-I", "-c", PROBE]);
  try {
    const [version, qaas, isolated] = JSON.parse(out?.trim().split("\n").pop() ?? "");
    return { version, qaas, isolated };
  } catch {
    return {};
  }
}

export async function discoverEnvironments(): Promise<PyEnv[]> {
  const groups = await Promise.all([
    Promise.resolve(workspaceVenvs()),
    condaEnvs(),
    Promise.resolve(pyenvEnvs()),
    pythonExtensionEnvs(),
    systemPythons(),
  ]);
  // First source wins for kind/name. Dedupe on the literal path: a venv's python is a
  // symlink to its base interpreter, so resolving symlinks would merge distinct envs.
  const seen = new Map<string, PyEnv>();
  for (const env of groups.flat()) {
    const k = path.normalize(env.python);
    if (!seen.has(k)) {
      seen.set(k, env);
    }
  }
  const envs = [...seen.values()];
  await Promise.all(envs.map(async (e) => Object.assign(e, await probe(e.python))));
  return envs.filter((e) => e.version);
}

function supported(e: { version?: string }): boolean {
  return !!e.version && (e.version === REQUIRED_PYTHON || e.version.startsWith(`${REQUIRED_PYTHON}.`));
}

async function setInterpreter(python: string): Promise<void> {
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await cfg().update("pythonPath", python, target);
}

const KIND_LABEL: Record<EnvKind, string> = {
  venv: "Virtual environments",
  conda: "Conda",
  pyenv: "pyenv",
  system: "System",
};

/** QuickPick of discovered interpreters; writes qaas.pythonPath. */
export async function selectInterpreter(): Promise<string | undefined> {
  type Item = vscode.QuickPickItem & { env?: PyEnv; action?: "create" | "browse" };
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = "Python interpreter for QaaS";
  qp.placeholder = `qaas needs Python ${REQUIRED_PYTHON}`;
  qp.busy = true;
  qp.show();
  const current = await resolvePython();
  const envs = await discoverEnvironments();
  const order: EnvKind[] = ["venv", "conda", "pyenv", "system"];
  const items: Item[] = [
    { label: "$(add) Create new environment…", action: "create" },
    { label: "$(folder) Enter interpreter path…", action: "browse" },
  ];
  for (const kind of order) {
    const group = envs
      .filter((e) => e.kind === kind)
      .sort((a, b) => Number(!!b.qaas) - Number(!!a.qaas) || Number(supported(b)) - Number(supported(a)));
    if (group.length === 0) {
      continue;
    }
    items.push({ label: KIND_LABEL[kind], kind: vscode.QuickPickItemKind.Separator });
    for (const e of group) {
      const notes = [
        e.qaas ? `qaas ${e.qaas}` : "qaas not installed",
        supported(e) ? undefined : `$(warning) Python ${REQUIRED_PYTHON} required`,
        e.python === current ? "current" : undefined,
      ].filter(Boolean);
      items.push({
        label: `${e.python === current ? "$(check) " : ""}Python ${e.version} · ${e.name}`,
        description: notes.join(" · "),
        detail: e.python,
        env: e,
      });
    }
  }
  qp.items = items;
  qp.busy = false;
  const picked = await new Promise<Item | undefined>((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]));
    qp.onDidHide(() => resolve(undefined));
  });
  qp.dispose();
  if (!picked) {
    return undefined;
  }
  if (picked.action === "create") {
    return createEnvironment(envs);
  }
  let python = picked.env?.python;
  if (picked.action === "browse") {
    const uri = await vscode.window.showOpenDialog({
      title: "Python interpreter",
      canSelectMany: false,
      openLabel: "Use Interpreter",
    });
    python = uri?.[0]?.fsPath;
  }
  if (!python) {
    return undefined;
  }
  await setInterpreter(python);
  const info = picked.env ?? (await probe(python));
  if (!info.qaas) {
    const choice = await vscode.window.showInformationMessage(
      `QaaS: qaas is not installed in ${python}.`,
      "Install qaas",
    );
    if (choice) {
      await installQaas(python);
    }
  }
  return python;
}

/** Run a process as a VS Code task (no shell quoting issues) and wait for its exit code. */
async function runTask(name: string, command: string, args: string[], cwd?: string): Promise<number | undefined> {
  const task = new vscode.Task(
    { type: "qaas", task: name },
    vscode.TaskScope.Workspace,
    name,
    "QaaS",
    new vscode.ProcessExecution(command, args, cwd ? { cwd } : undefined),
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
  const execution = await vscode.tasks.executeTask(task);
  return new Promise((resolve) => {
    const sub = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution === execution) {
        sub.dispose();
        resolve(e.exitCode);
      }
    });
  });
}

/** Create a Python 3.12 venv (from any discovered 3.12 interpreter, incl. pyenv) or conda env, then install qaas. */
export async function createEnvironment(known?: PyEnv[]): Promise<string | undefined> {
  const envs = known ?? (await discoverEnvironments());
  const bases = envs.filter(supported);
  const conda = await findConda();
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  type Item = vscode.QuickPickItem & { make: "venv" | "conda"; base?: PyEnv };
  const items: Item[] = [];
  for (const b of bases) {
    items.push({
      label: `$(folder) venv from Python ${b.version} (${b.kind} · ${b.name})`,
      description: ws ? `${path.basename(ws)}/.venv` : "choose a folder",
      detail: b.python,
      make: "venv",
      base: b,
    });
  }
  if (conda) {
    items.push({ label: `$(package) conda env with Python ${REQUIRED_PYTHON}`, detail: conda, make: "conda" });
  }
  if (items.length === 0) {
    vscode.window.showErrorMessage(
      `QaaS: no Python ${REQUIRED_PYTHON} found and no conda. Install Python ${REQUIRED_PYTHON} (e.g. \`pyenv install ${REQUIRED_PYTHON}\`) or Miniconda, then try again.`,
    );
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(items, { title: "Create environment for qaas" });
  if (!pick) {
    return undefined;
  }

  let python: string;
  if (pick.make === "venv") {
    let dir = ws ? path.join(ws, ".venv") : undefined;
    if (!dir || fs.existsSync(dir)) {
      const chosen = await vscode.window.showSaveDialog({
        title: "Location of the new virtual environment",
        defaultUri: vscode.Uri.file(dir ? `${dir}-qaas` : path.join(home, ".venvs", "qaas")),
      });
      if (!chosen) {
        return undefined;
      }
      dir = chosen.fsPath;
    }
    if ((await runTask("Create venv", pick.base!.python, ["-m", "venv", dir])) !== 0) {
      vscode.window.showErrorMessage("QaaS: creating the virtual environment failed. See the terminal.");
      return undefined;
    }
    python = venvPython(dir);
  } else {
    const name = await vscode.window.showInputBox({
      title: "Conda environment name",
      value: "qaas",
      ignoreFocusOut: true,
    });
    if (!name) {
      return undefined;
    }
    if (
      (await runTask("Create conda env", conda!, ["create", "-y", "-n", name, `python=${REQUIRED_PYTHON}`, "pip"])) !==
      0
    ) {
      vscode.window.showErrorMessage("QaaS: creating the conda environment failed. See the terminal.");
      return undefined;
    }
    const out = await run(conda!, ["env", "list", "--json"]);
    const prefix = ((JSON.parse(out ?? "{}").envs ?? []) as string[]).find((p) => path.basename(p) === name);
    if (!prefix) {
      vscode.window.showErrorMessage(`QaaS: conda env "${name}" was not found after creation.`);
      return undefined;
    }
    python = pythonIn(prefix);
  }
  await setInterpreter(python);
  await installQaas(python);
  return python;
}

/**
 * pip install qaas into `python` (default: the resolved interpreter). Uses `python -m pip`,
 * which is correct for venv, pyenv and conda envs alike.
 * @returns true when pip exited with 0
 */
export async function installQaas(python?: string): Promise<boolean> {
  const exe = python ?? (await resolvePython());
  const info = await probe(exe);
  if (!info.version) {
    const c = await vscode.window.showErrorMessage(`QaaS: cannot run ${exe}.`, "Select Interpreter");
    if (c) {
      await selectInterpreter();
    }
    return false;
  }
  if (!supported(info)) {
    const c = await vscode.window.showWarningMessage(
      `QaaS: qaas needs Python ${REQUIRED_PYTHON}, but ${exe} is Python ${info.version}.`,
      "Select Interpreter",
      "Create Environment",
    );
    if (c === "Select Interpreter") {
      await selectInterpreter();
    } else if (c === "Create Environment") {
      await createEnvironment();
    }
    return false;
  }
  if (!info.isolated) {
    const c = await vscode.window.showWarningMessage(
      `QaaS: ${exe} is not in a virtual or conda environment. Installing there can fail (externally managed Python) or affect other projects.`,
      { modal: true },
      "Install Anyway",
      "Create Environment",
    );
    if (c === "Create Environment") {
      return !!(await createEnvironment());
    }
    if (c !== "Install Anyway") {
      return false;
    }
  }
  const extra = cfg().get<string>("packageExtra") || "iqm_qiskit";
  const code = await runTask("Install qaas", exe, [
    "-m",
    "pip",
    "install",
    "--upgrade",
    `qaas[${extra}]${QAAS_REQUIREMENT}`,
  ]);
  if (code === 0) {
    vscode.window.showInformationMessage(`QaaS: qaas installed in ${exe}.`);
    void vscode.commands.executeCommand("qaas.restartBridge");
    return true;
  }
  vscode.window.showErrorMessage("QaaS: pip install failed. See the terminal for details.");
  return false;
}
