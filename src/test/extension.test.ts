import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

suite("QaaS extension", () => {
  test("activates and registers its commands", async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "qaas-vscode");
    assert.ok(ext, "extension not found");
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    const declared: string[] = ext.packageJSON.contributes.commands.map((c: { command: string }) => c.command);
    for (const id of declared) {
      assert.ok(commands.includes(id), `${id} declared but not registered`);
    }
  });

  test("without IT4I Workflows the user settings it writes are removed, workspace settings stay", async () => {
    const settings = () => vscode.workspace.getConfiguration("qaas");
    await settings().update("workflowsIntegration", true, vscode.ConfigurationTarget.Workspace);
    await settings().update("workflowsService", "efp", vscode.ConfigurationTarget.Global);
    await settings().update("workflowsIntegration", true, vscode.ConfigurationTarget.Global);
    for (let i = 0; i < 50 && settings().inspect("workflowsIntegration")?.globalValue !== undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.strictEqual(settings().inspect("workflowsIntegration")?.globalValue, undefined);
    assert.strictEqual(settings().inspect("workflowsService")?.globalValue, undefined);
    assert.strictEqual(settings().inspect("workflowsIntegration")?.workspaceValue, true);
    await settings().update("workflowsIntegration", undefined, vscode.ConfigurationTarget.Workspace);
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (folder) {
      fs.rmSync(path.join(folder, ".vscode"), { recursive: true, force: true });
    }
  });

  test("shows billed-time estimates for backends with a known billing model", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "python",
      content: [
        "from qheappe_client.qprovider import QProvider",
        "backend = provider.get_backend()",
        "job = backend.run(qc, shots=10000)",
      ].join("\n"),
    });
    const settings = () => vscode.workspace.getConfiguration("qaas");
    const titles = async () =>
      (await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", doc.uri)).map(
        (l) => l.command?.title ?? "",
      );
    try {
      let t = await titles();
      assert.ok(
        t.some((x) => x.includes("no billing model")),
        `no backend configured: ${JSON.stringify(t)}`,
      );
      await settings().update("backendName", "VLQ", vscode.ConfigurationTarget.Global);
      t = await titles();
      assert.ok(
        t.some((x) => x.includes("VLQ billed") && x.includes("3.50–4.00 s")),
        `VLQ: ${JSON.stringify(t)}`,
      );
      await settings().update("backendName", "EQE", vscode.ConfigurationTarget.Global);
      t = await titles();
      assert.ok(
        t.some((x) => x.includes("no billing model for EQE")),
        `EQE: ${JSON.stringify(t)}`,
      );
    } finally {
      await settings().update("backendName", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test("the Jobs view toggles the automatic refresh of active jobs", async () => {
    const setting = () => vscode.workspace.getConfiguration("qaas").get<boolean>("autoRefreshJobs");
    try {
      await vscode.commands.executeCommand("qaas.jobs.autoRefreshOff");
      assert.strictEqual(setting(), false);
      await vscode.commands.executeCommand("qaas.jobs.autoRefreshOn");
      assert.strictEqual(setting(), true);
    } finally {
      await vscode.workspace
        .getConfiguration("qaas")
        .update("autoRefreshJobs", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test("treats .qasm files as OpenQASM", async () => {
    const doc = await vscode.workspace.openTextDocument({ language: "openqasm", content: "OPENQASM 3.0;\nqubit q;\n" });
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", doc.uri);
    assert.ok(lenses.some((l) => l.command?.command === "qaas.runQasm"));
  });

  async function waitFor<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const v = fn();
      if (v) {
        return v;
      }
      if (Date.now() - start > ms) {
        throw new Error("timed out");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  test("operator catalog reports problems in operator files", async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(root, "fixture workspace not open");
    const broken = vscode.Uri.joinPath(root, ".qaas", "operators", "broken.yaml");
    const good = vscode.Uri.joinPath(root, ".qaas", "operators", "hann_drag.yaml");
    const diags = await waitFor(() => {
      const d = vscode.languages.getDiagnostics(broken);
      return d.length > 0 ? d : undefined;
    });
    const messages = diags.map((d) => d.message).join("\n");
    assert.ok(messages.includes("name:"), messages);
    assert.ok(messages.includes("Unknown built-in waveform"), messages);
    const goodErrors = vscode.languages
      .getDiagnostics(good)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.deepEqual(goodErrors, []);
  });

  test("OpenQASM files with an operator directive run at pulse level", async () => {
    const root = vscode.workspace.workspaceFolders![0].uri;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, "bell_pulse.qasm"));
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", doc.uri);
    const titles = lenses.map((l) => l.command?.title ?? "");
    assert.ok(
      titles.some((t) => t.includes("Run on QPU (prx=hann_drag)")),
      JSON.stringify(titles),
    );
    assert.ok(lenses.some((l) => l.command?.command === "qaas.runQasmWithOperator"));
  });

  test("hints at imports a QPU script needs but the WebAssembly runtime does not have", async function () {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "qaas-vscode");
    if (!ext || !fs.existsSync(path.join(ext.extensionPath, "wasm", "manifest.json"))) {
      this.skip();
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(root, "fixture workspace not open");
    const file = vscode.Uri.joinPath(root, "imports_check.py");
    fs.writeFileSync(
      file.fsPath,
      "import numpy as np\nfrom qheappe_client.qprovider import QProvider\nimport torch\nfrom qiskit_aer import AerSimulator\n",
    );
    try {
      const doc = await vscode.workspace.openTextDocument(file);
      const hints = await waitFor(() => {
        const d = vscode.languages.getDiagnostics(doc.uri).filter((x) => x.source === "QaaS");
        return d.length >= 2 ? d : undefined;
      });
      assert.deepStrictEqual(
        hints.map((d) => [d.range.start.line, d.severity]),
        [
          [2, vscode.DiagnosticSeverity.Information],
          [3, vscode.DiagnosticSeverity.Information],
        ],
      );
      assert.match(hints[0].message, /torch is not in the WebAssembly runtime/);
      assert.match(hints[1].message, /StatevectorSampler/);
      const page = await vscode.workspace.openTextDocument(vscode.Uri.parse("qaas-libraries:Python libraries.md"));
      assert.match(page.getText(), /\| `qiskit` \| \d/);
      assert.match(page.getText(), /plt\.show\(\)/);
    } finally {
      fs.rmSync(file.fsPath, { force: true });
    }
  });

  test("the WebAssembly runtime checks OpenQASM without a local Python", async function () {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "qaas-vscode");
    if (!ext || !fs.existsSync(path.join(ext.extensionPath, "wasm", "manifest.json"))) {
      this.skip(); // wasm/ is built by npm run wasm:build
    }
    this.timeout(120_000);
    const settings = () => vscode.workspace.getConfiguration("qaas");
    await settings().update("runtime", "wasm", vscode.ConfigurationTarget.Global);
    // The runtime change restarts the bridge; open the document after that.
    await new Promise((r) => setTimeout(r, 500));
    try {
      // qiskit's OpenQASM 3 importer, in Pyodide in a worker of this extension host, rejects it.
      const doc = await vscode.workspace.openTextDocument({
        language: "openqasm",
        content: 'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nh q[0];\ncx q[0] q[1];\n',
      });
      const errors = () =>
        vscode.languages.getDiagnostics(doc.uri).filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
      try {
        await waitFor(() => (errors().length ? true : undefined), 90_000);
      } catch {
        const all = vscode.languages.getDiagnostics().map(([u, d]) => [u.toString(), d.map((x) => x.message)]);
        throw new Error(`no error diagnostic on ${doc.uri.toString()}; all: ${JSON.stringify(all)}`);
      }
      // "cx q[0] q[1];" is line 5: the bridge reports the offending token's position.
      assert.strictEqual(errors()[0].range.start.line, 4, errors()[0].message);
      assert.match(errors()[0].message, /unexpected 'q'/);
    } finally {
      await settings().update("runtime", undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
