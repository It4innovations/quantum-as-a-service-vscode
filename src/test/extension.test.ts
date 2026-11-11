import * as assert from "node:assert";
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

  test("shows billed-time estimates above qaas run calls", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "python",
      content: [
        "from qheappe_client.qprovider import QProvider",
        "backend = provider.get_backend(backend_name='VLQ')",
        "job = backend.run(qc, shots=10000)",
      ].join("\n"),
    });
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", doc.uri);
    const titles = lenses.map((l) => l.command?.title ?? "");
    assert.ok(
      titles.some((t) => t.includes("3.50–4.00 s")),
      `no estimate lens in ${JSON.stringify(titles)}`,
    );
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
      titles.some((t) => t.includes("Run on VLQ (prx=hann_drag)")),
      JSON.stringify(titles),
    );
    assert.ok(lenses.some((l) => l.command?.command === "qaas.runQasmWithOperator"));
  });
});
