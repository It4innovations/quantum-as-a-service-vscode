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
});
