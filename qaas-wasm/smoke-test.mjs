// Checks the extension's WebAssembly runtime (wasm/) through the same worker the extension uses
// (out/wasm/worker.js): startup, the bridge's methods without a LEXIS login, the refusal of
// refresh tokens, a request to the real LEXIS API (expects an auth error, not a transport error),
// and the bridge's Python unit tests inside Pyodide.
//
//   npm run compile && node qaas-wasm/smoke-test.mjs [wasm-dir]
//
// Needs Node 24+ (JSPI). Exit code 0 when everything passed.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = resolve(process.argv[2] ?? join(repo, "wasm"));
const workerFile = join(repo, "out", "wasm", "worker.js");
for (const f of [join(bundleDir, "manifest.json"), workerFile]) {
  if (!existsSync(f)) {
    console.error(`missing ${f} (run "npm run compile" and build or assemble the bundle first)`);
    process.exit(2);
  }
}

const worker = new Worker(workerFile, {
  workerData: { bundleDir, pythonDir: join(repo, "python"), testsDir: join(repo, "python", "tests") },
});
const pending = new Map();
let nextId = 1;
let testsResult;
let testsDone;
const testsFinished = new Promise((r) => (testsDone = r));
const started = new Promise((resolveStart, rejectStart) => {
  worker.on("message", (msg) => {
    if (msg.type === "ready") {
      console.log(`ready in ${msg.seconds.toFixed(1)} s: qaas ${msg.versions.qaas}, Pyodide ${msg.versions.pyodide}`);
      resolveStart();
    } else if (msg.type === "status") {
      console.log(`  ${msg.text}`);
    } else if (msg.type === "line") {
      const r = JSON.parse(msg.line);
      pending.get(r.id)?.(r);
      pending.delete(r.id);
    } else if (msg.type === "tests") {
      testsResult = msg;
      testsDone();
    } else if (msg.type === "fatal") {
      // Before "ready" this fails the start; afterwards it fails whatever is waiting.
      rejectStart(new Error(msg.message));
      for (const [id, res] of pending) {
        res({ id, error: { type: "fatal", message: msg.message } });
      }
      pending.clear();
      testsDone();
      testsResult ??= { ok: false, output: msg.message };
    } else if (msg.type === "log" && process.env.VERBOSE) {
      console.log(`  [py] ${msg.text}`);
    }
  });
  worker.on("error", rejectStart);
});

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, res);
    worker.postMessage({ type: "request", line: JSON.stringify({ id, method, params }) });
  });
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.c2ln`;
const exp = Math.floor(Date.now() / 1000) + 600;
const iss = "https://aai.lexis.tech/auth/realms/LEXIS_AAI_v2";
const BELL =
  'OPENQASM 3.0;\ninclude "stdgates.inc";\nqubit[2] q;\nbit[2] c;\nh q[0];\ncx q[0], q[1];\nc = measure q;\n';
const HANN = {
  schema: "qaas-operator/v1",
  name: "hann_drag",
  gate: "prx",
  parameters: { beta: { default: 1.0 } },
  waveform: { i: { type: "expression", expression: "beta * cos(pi * t) ** 2" }, q: { type: "derivative" } },
};

const checks = [
  ["check", {}, (r) => r.result?.runtime === "wasm" && r.result.importable && !r.result.qaasOutdated],
  ["analyze", { source: BELL }, (r) => r.result?.original?.twoQubitGates === 1],
  ["simulate", { sources: [BELL] }, (r) => Math.abs((r.result?.[0]?.["11"] ?? 0) - 0.5) < 1e-9],
  [
    "pulseSample",
    { spec: HANN, values: { duration: 4e-8, amplitude_i: 0.3 }, sampleRate: 2e9 },
    (r) => r.result?.nSamples === 80,
  ],
  [
    "whoami",
    { project: "p", token: jwt({ typ: "Refresh", exp, iss }) },
    (r) => r.error?.type === "SignInRequired" && /WebAssembly runtime/.test(r.error.message),
  ],
  [
    // Reaches LEXIS through fetch + JSPI; the made-up token must be refused by qaas/LEXIS, not by the transport.
    "backends",
    { project: "p", token: jwt({ typ: "Bearer", exp, iss, sub: "x", azp: "x", preferred_username: "x" }) },
    (r) => r.error && /signature|401|403|auth/i.test(r.error.message) && !/fetch failed|JSPI/.test(r.error.message),
  ],
];

let failed = 0;
try {
  await started;
  for (const [method, params, ok] of checks) {
    const t = Date.now();
    const r = await request(method, params);
    const pass = ok(r);
    failed += pass ? 0 : 1;
    const detail = JSON.stringify(r.result ?? r.error).slice(0, 160);
    console.log(`${pass ? "ok  " : "FAIL"} ${method} (${((Date.now() - t) / 1000).toFixed(2)} s) ${detail}`);
  }
  await testsFinished;
  const summary = testsResult.output.trim().split("\n").slice(-3).join(" | ");
  console.log(`${testsResult.ok ? "ok  " : "FAIL"} python/tests in Pyodide: ${summary}`);
  if (!testsResult.ok) {
    failed++;
    console.log(testsResult.output);
  }
} catch (e) {
  console.error(`FAIL startup: ${e.message}`);
  failed++;
}
await worker.terminate();
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
