import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  authMode,
  EXPIRY_MARGIN_MS,
  errorCode,
  serviceInstance,
  signInChanged,
  TokenCache,
  tokenMatchesService,
  type WorkflowsAccessToken,
  workflowsService,
} from "../../core/workflowsAuth";

const NOW = Date.parse("2026-11-16T10:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
const token = (expiresAt: string | undefined, n = 1): WorkflowsAccessToken => ({
  token: `a.b.${n}`,
  expiresAt,
  apiUrl: "https://api.lexis.tech/",
  service: "core",
});

test("authMode and workflowsService default to py4lexis and core", () => {
  assert.equal(authMode(undefined, true), "py4lexis");
  assert.equal(authMode(false, true), "py4lexis");
  assert.equal(authMode("true", true), "py4lexis");
  assert.equal(authMode(true, true), "workflows");
  assert.equal(authMode(true, false), "py4lexis");
  assert.equal(workflowsService(undefined), "core");
  assert.equal(workflowsService("efp"), "efp");
});

test("core is LEXIS production, efp its own instance", () => {
  assert.equal(serviceInstance("core"), undefined);
  assert.equal(serviceInstance("efp")?.apiUrl, "https://api.workflows.my-eurohpc.eu");
});

test("a token is used only for its own service and API", () => {
  assert.ok(tokenMatchesService(token(at(60_000)), "core"));
  assert.ok(!tokenMatchesService(token(at(60_000)), "efp"));
  assert.ok(!tokenMatchesService({ ...token(at(60_000)), apiUrl: "https://evil.example.org" }, "core"));
  assert.ok(!tokenMatchesService({ ...token(at(60_000)), token: "" }, "core"));
  assert.ok(
    tokenMatchesService(
      { ...token(at(60_000)), service: "efp", apiUrl: "https://api.workflows.my-eurohpc.eu/" },
      "efp",
    ),
  );
});

test("errorCode reads the code of a rejected API call", () => {
  assert.equal(errorCode(Object.assign(new Error("x"), { code: "auth_required" })), "auth_required");
  assert.equal(errorCode(new Error("x")), undefined);
  assert.equal(errorCode(undefined), undefined);
});

test("TokenCache reuses a token until 30 s before it expires", async () => {
  let now = NOW;
  let fetches = 0;
  const cache = new TokenCache(() => now);
  const fetch = async () => token(at(5 * 60_000), ++fetches);

  assert.equal((await cache.get(fetch)).token, "a.b.1");
  now = NOW + 5 * 60_000 - EXPIRY_MARGIN_MS - 1;
  assert.equal((await cache.get(fetch)).token, "a.b.1");
  now = NOW + 5 * 60_000 - EXPIRY_MARGIN_MS;
  assert.equal((await cache.get(fetch)).token, "a.b.2");
  assert.equal(fetches, 2);
});

test("TokenCache never caches a token without expiry", async () => {
  let fetches = 0;
  const cache = new TokenCache(() => NOW);
  const fetch = async () => token(undefined, ++fetches);
  await cache.get(fetch);
  await cache.get(fetch);
  assert.equal(fetches, 2);
});

test("TokenCache shares one fetch between concurrent callers", async () => {
  let fetches = 0;
  const cache = new TokenCache(() => NOW);
  const fetch = async () => token(at(60_000), ++fetches);
  const [a, b] = await Promise.all([cache.get(fetch), cache.get(fetch)]);
  assert.equal(a, b);
  assert.equal(fetches, 1);
});

test("TokenCache invalidate forgets the token, also one still being fetched", async () => {
  let fetches = 0;
  const cache = new TokenCache(() => NOW);
  const fetch = async () => token(at(60_000), ++fetches);
  await cache.get(fetch);
  cache.invalidate();
  assert.equal((await cache.get(fetch)).token, "a.b.2");

  cache.invalidate();
  const late = cache.get(fetch);
  cache.invalidate();
  assert.equal((await late).token, "a.b.4");
  assert.equal((await cache.get(fetch)).token, "a.b.4");
  assert.equal(fetches, 4);
});

test("TokenCache does not keep a failed fetch", async () => {
  const cache = new TokenCache(() => NOW);
  await assert.rejects(
    cache.get(async () => {
      throw Object.assign(new Error("signed out"), { code: "auth_required" });
    }),
  );
  assert.equal((await cache.get(async () => token(at(60_000), 7))).token, "a.b.7");
});

test("signInChanged restarts only for a new mode, or a new service in workflows mode", () => {
  const py = { mode: "py4lexis", service: "core" } as const;
  assert.equal(signInChanged(py, py), false);
  assert.equal(signInChanged(py, { mode: "py4lexis", service: "efp" }), false);
  assert.equal(signInChanged(py, { mode: "workflows", service: "core" }), true);
  assert.equal(signInChanged({ mode: "workflows", service: "core" }, { mode: "workflows", service: "efp" }), true);
  assert.equal(signInChanged({ mode: "workflows", service: "efp" }, { mode: "workflows", service: "efp" }), false);
});
