import * as assert from "node:assert/strict";
import { test } from "node:test";
import { DEV_KEYS, devEnvTemplate, instanceLabel, normalizeInstance, parseDotenv } from "../../core/devEnv";

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
