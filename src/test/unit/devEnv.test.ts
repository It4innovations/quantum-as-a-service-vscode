import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEV_KEYS,
  devEnvTemplate,
  instanceFromTokenKey,
  instanceLabel,
  isJobId,
  normalizeInstance,
  parseDotenv,
  sameInstance,
  TOKEN_KEY,
  tokenKey,
} from "../../core/devEnv";

test("parseDotenv handles comments, quotes, export and empty values", () => {
  const env = parseDotenv(`# comment
export PY4LEXIS_API_URL=https://api.staging.example.org/
QAAS_LEXIS_PROJECT = "my project"
QAAS_LEXIS_RESOURCE='res # not a comment'
QAAS_BACKEND_NAME=VLQ   # trailing comment
QAAS_LEXIS_TOKEN=
not a line
`);
  assert.deepEqual(env, {
    PY4LEXIS_API_URL: "https://api.staging.example.org/",
    QAAS_LEXIS_PROJECT: "my project",
    QAAS_LEXIS_RESOURCE: "res # not a comment",
    QAAS_BACKEND_NAME: "VLQ",
  });
});

test("normalizeInstance drops production URLs and trailing slashes", () => {
  assert.equal(normalizeInstance({ aaiUrl: "https://aai.lexis.tech/", apiUrl: "https://api.lexis.tech" }), undefined);
  assert.equal(normalizeInstance({ aaiUrl: "", apiUrl: " " }), undefined);
  assert.equal(
    normalizeInstance({ aaiUrl: "https://aai.lexis.tech", apiUrl: "https://api.lexis.tech", realm: "LEXIS_AAI_v2" }),
    undefined,
    "production spelled out explicitly, including its realm, is still production",
  );
  assert.deepEqual(normalizeInstance({ realm: "LEXIS_AAI_v2_TEST" }), {
    aaiUrl: undefined,
    apiUrl: undefined,
    realm: "LEXIS_AAI_v2_TEST",
  });
  assert.deepEqual(
    normalizeInstance({ aaiUrl: "https://aai.staging.example.org/", apiUrl: "https://api.staging.example.org" }),
    {
      aaiUrl: "https://aai.staging.example.org",
      apiUrl: "https://api.staging.example.org",
      realm: undefined,
    },
  );
});

test("instanceLabel names a non-production instance", () => {
  assert.equal(instanceLabel(undefined), undefined);
  assert.equal(instanceLabel({ apiUrl: "https://api.staging.example.org" }), "staging");
  assert.equal(instanceLabel({ aaiUrl: "https://keycloak.example.org:8443/auth" }), "keycloak");
});

test("the dev template lists every key and leaves all values empty", () => {
  const template = devEnvTemplate();
  assert.deepEqual(parseDotenv(template), {});
  for (const key of DEV_KEYS) {
    assert.match(template, new RegExp(`^#? ?${key}=`, "m"));
  }
});

test("tokenKey keeps production on the original key and separates every other instance", () => {
  assert.equal(tokenKey(), TOKEN_KEY);
  assert.equal(tokenKey({ aaiUrl: "https://aai.lexis.tech/", apiUrl: "https://api.lexis.tech" }), TOKEN_KEY);
  const staging = tokenKey({ aaiUrl: "https://aai.staging.example.org", apiUrl: "https://api.staging.example.org" });
  assert.notEqual(staging, TOKEN_KEY);
  assert.equal(
    staging,
    tokenKey({ aaiUrl: "https://aai.staging.example.org/", apiUrl: "https://api.staging.example.org/" }),
    "trailing slashes do not change the key",
  );
  // changing only one of the URLs (e.g. a workspace pointing the API at another server) is another instance
  assert.notEqual(tokenKey({ apiUrl: "https://evil.example.org" }), TOKEN_KEY);
  assert.notEqual(tokenKey({ aaiUrl: "https://aai.lexis.tech", apiUrl: "https://evil.example.org" }), TOKEN_KEY);
  assert.notEqual(tokenKey({ realm: "OTHER" }), TOKEN_KEY);
});

test("sameInstance treats production spelled out and undefined alike", () => {
  assert.ok(sameInstance(undefined, { aaiUrl: "https://aai.lexis.tech", realm: "LEXIS_AAI_v2" }));
  assert.ok(sameInstance({ apiUrl: "https://api.x.org/" }, { apiUrl: "https://api.x.org" }));
  assert.ok(!sameInstance(undefined, { apiUrl: "https://api.x.org" }));
});

test("instanceFromTokenKey inverts tokenKey and ignores other secrets", () => {
  const staging = { aaiUrl: "https://aai.staging.example.org", apiUrl: "https://api.staging.example.org", realm: "R" };
  assert.equal(instanceFromTokenKey(TOKEN_KEY), undefined);
  assert.deepEqual(instanceFromTokenKey(tokenKey(staging)), staging);
  assert.deepEqual(instanceFromTokenKey(tokenKey({ realm: "R" })), {
    aaiUrl: undefined,
    apiUrl: undefined,
    realm: "R",
  });
  assert.equal(instanceFromTokenKey("qaas.somethingElse"), null);
  assert.equal(instanceFromTokenKey(`${TOKEN_KEY}Backup`), null);
});

test("isJobId accepts HEAppE integer IDs only", () => {
  assert.ok(isJobId("42"));
  assert.ok(isJobId("1234567890123"));
  for (const bad of ["", "../../etc", "42/..", "4 2", "-1", "1e3", "12345678901234567890", 42, undefined]) {
    assert.ok(!isJobId(bad), String(bad));
  }
});
