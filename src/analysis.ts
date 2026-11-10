import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Bridge } from "./bridge";
import { buildAnalysisNotebook } from "./core/notebook";
import { type Counts, countsToCsv } from "./core/stats";
import type { JobRecord, JobStore } from "./jobs";
import type { Reference, ResultsActions } from "./resultsPanel";

const DATA_WRANGLER = "ms-toolsai.datawrangler";
/** Custom editor contributed by Data Wrangler for csv/tsv/parquet/xlsx/jsonl. */
const DATA_WRANGLER_EDITOR = "jupyter-data-wrangler";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Analysis of downloaded results: CSV export, Data Wrangler, notebook, comparisons. */
export class Analysis implements ResultsActions {
  constructor(
    private readonly bridge: Bridge,
    private readonly store: JobStore,
  ) {}

  private dir(job: JobRecord): string {
    if (!job.downloadedTo) {
      throw new Error(`Results of job #${job.jobId} are not downloaded yet.`);
    }
    return job.downloadedTo;
  }

  async loadCounts(job: JobRecord): Promise<Counts[]> {
    return JSON.parse(await fs.readFile(path.join(this.dir(job), "counts.json"), "utf8"));
  }

  /** Write the files used by Data Wrangler and the notebook (also for older downloads). */
  async writeExports(job: JobRecord, counts?: Counts[]): Promise<void> {
    const dir = this.dir(job);
    await fs.writeFile(
      path.join(dir, "counts.csv"),
      countsToCsv(job.jobId, counts ?? (await this.loadCounts(job))),
      "utf8",
    );
    if (job.qasmSources?.length) {
      await fs.mkdir(path.join(dir, "circuits"), { recursive: true });
      await Promise.all(
        job.qasmSources.map((src, i) => fs.writeFile(path.join(dir, "circuits", `circuit_${i}.qasm`), src, "utf8")),
      );
    }
  }

  async openDataWrangler(job: JobRecord): Promise<void> {
    const dir = this.dir(job);
    if (!(await exists(path.join(dir, "counts.csv")))) {
      await this.writeExports(job);
    }
    const files = [
      { label: "counts.csv", description: "one row per outcome, with a 0/1 column per bit" },
      { label: "shots.csv", description: "one row per shot" },
    ];
    const available = [];
    for (const f of files) {
      if (await exists(path.join(dir, f.label))) {
        available.push(f);
      }
    }
    const pick =
      available.length > 1
        ? await vscode.window.showQuickPick(available, { title: "Open in Data Wrangler" })
        : available[0];
    if (!pick) {
      return;
    }
    const uri = vscode.Uri.file(path.join(dir, pick.label));
    if (!vscode.extensions.getExtension(DATA_WRANGLER)) {
      const choice = await vscode.window.showInformationMessage(
        "QaaS: Data Wrangler is not installed. It gives column statistics, filters and charts for the CSV files.",
        "Install Data Wrangler",
        "Open as Text",
      );
      if (choice === "Install Data Wrangler") {
        await vscode.commands.executeCommand("workbench.extensions.installExtension", DATA_WRANGLER);
      } else {
        if (choice === "Open as Text") {
          await vscode.commands.executeCommand("vscode.open", uri);
        }
        return;
      }
    }
    await vscode.commands.executeCommand("vscode.openWith", uri, DATA_WRANGLER_EDITOR);
  }

  async openNotebook(job: JobRecord): Promise<void> {
    const dir = this.dir(job);
    await this.writeExports(job);
    const file = path.join(dir, "analysis.ipynb");
    if (!(await exists(file))) {
      const content = buildAnalysisNotebook({
        directory: dir,
        jobId: job.jobId,
        jobName: job.name,
        backend: job.backend,
        project: job.project,
        hasShots: await exists(path.join(dir, "shots.csv")),
        hasCircuits: await exists(path.join(dir, "circuits", "circuit_0.qasm")),
      });
      await fs.writeFile(file, content, "utf8");
    }
    const nb = await vscode.workspace.openNotebookDocument(vscode.Uri.file(file));
    await vscode.window.showNotebookDocument(nb);
  }

  /** Sources: saved at submission, saved next to the results, or picked by the user. */
  private async circuitSources(job: JobRecord, circuits: number): Promise<string[] | undefined> {
    if (job.qasmSources?.length) {
      return job.qasmSources;
    }
    const saved = path.join(this.dir(job), "circuits");
    const fromDir = [];
    for (let i = 0; i < circuits; i++) {
      const f = path.join(saved, `circuit_${i}.qasm`);
      if (!(await exists(f))) {
        break;
      }
      fromDir.push(await fs.readFile(f, "utf8"));
    }
    if (fromDir.length === circuits) {
      return fromDir;
    }
    const picked = await vscode.window.showOpenDialog({
      title: `OpenQASM 3 file${circuits === 1 ? "" : "s"} of job #${job.jobId} (${circuits} circuit${circuits === 1 ? "" : "s"}, in order)`,
      canSelectMany: circuits > 1,
      filters: { OpenQASM: ["qasm"] },
    });
    if (!picked?.length) {
      return undefined;
    }
    const sorted = [...picked].sort((a, b) => a.fsPath.localeCompare(b.fsPath));
    return Promise.all(sorted.map(async (u) => Buffer.from(await vscode.workspace.fs.readFile(u)).toString("utf8")));
  }

  async compareIdeal(job: JobRecord): Promise<Reference | undefined> {
    const counts = await this.loadCounts(job);
    const sources = await this.circuitSources(job, counts.length);
    if (!sources) {
      return undefined;
    }
    const dists = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "QaaS: simulating ideal circuits…" },
      () => this.bridge.request<Counts[]>("simulate", { sources }),
    );
    return { label: "ideal simulation", counts: dists };
  }

  async compareJob(job: JobRecord): Promise<Reference | undefined> {
    const others = this.store
      .all()
      .filter((r) => r.downloadedTo && !(r.jobId === job.jobId && r.project === job.project));
    if (others.length === 0) {
      vscode.window.showInformationMessage("QaaS: download the results of another job first.");
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      others.map((r) => ({
        label: r.name,
        description: `#${r.jobId} · ${r.backend}`,
        detail: [r.shots && `${r.shots} shots`, r.calibrationSetId && `calibration ${r.calibrationSetId}`]
          .filter(Boolean)
          .join(" · "),
        r,
      })),
      { title: `Compare job #${job.jobId} with…` },
    );
    if (!pick) {
      return undefined;
    }
    return { label: `job #${pick.r.jobId}`, counts: await this.loadCounts(pick.r) };
  }

  revealFolder(job: JobRecord): void {
    void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(path.join(this.dir(job), "counts.json")));
  }
}
