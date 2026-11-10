import * as assert from "node:assert";
import * as vscode from "vscode";

suite("QaaS extension", () => {
  test("registers its commands", async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "qaas-vscode");
    assert.ok(ext, "extension not found");
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of ["qaas.checkEnvironment", "qaas.listBackends", "qaas.runCurrentFile"]) {
      assert.ok(commands.includes(id), `${id} missing`);
    }
  });
});
