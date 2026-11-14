import { randomBytes } from "node:crypto";

/** Nonce for a webview Content-Security-Policy, from a cryptographic random source. */
export function nonce(): string {
  return randomBytes(16).toString("base64");
}
