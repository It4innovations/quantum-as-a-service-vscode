import * as os from "node:os";
import * as path from "node:path";
import { defineConfig } from "@vscode/test-cli";

// Integration tests only; out/test/unit/ runs with `node --test` (npm run test:unit).
// User data lives in the temp dir: macOS limits socket paths to ~104 characters.
export default defineConfig({
  files: "out/test/*.test.js",
  launchArgs: ["--user-data-dir", path.join(os.tmpdir(), "qaas-vscode-test"), "--disable-extensions"],
});
