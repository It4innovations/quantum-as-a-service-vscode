import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLoginPrompt } from "../../core/loginUrl";

test("parses py4lexis's login line, repairing LEXIS's one-slash URL", () => {
  const line =
    "Open provided url in your browser, please: https:/aai.lexis.tech/auth/realms/LEXIS_AAI_v2/protocol/openid-connect/auth/device?user_code=VKLI-XDSZ";
  assert.deepEqual(parseLoginPrompt(line), {
    url: "https://aai.lexis.tech/auth/realms/LEXIS_AAI_v2/protocol/openid-connect/auth/device?user_code=VKLI-XDSZ",
    host: "aai.lexis.tech",
    code: "VKLI-XDSZ",
  });
});

test("keeps correct URLs and ignores other output", () => {
  assert.equal(
    parseLoginPrompt("Open provided url in your browser, please: https://aai.example.org/x")?.url,
    "https://aai.example.org/x",
  );
  assert.equal(parseLoginPrompt("Check if user is logged in: Pending."), undefined);
});
