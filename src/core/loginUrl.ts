/** Parses the LEXIS login line py4lexis prints (device flow). No VS Code API here. */

const LOGIN_LINE = /Open provided url in your browser[^:]*:\s*(https?:\/\/?\S+)/;

/** Login URL and user code printed by py4lexis, if `text` contains one. */
export function parseLoginPrompt(text: string): { url: string; host: string; code?: string } | undefined {
  const m = LOGIN_LINE.exec(text);
  if (!m) {
    return undefined;
  }
  // LEXIS's Keycloak returns the device-login URL as "https:/aai.lexis.tech/..." (one slash).
  const url = m[1].replace(/^(https?:)\/(?!\/)/, "$1//");
  let host = url;
  let code: string | undefined;
  try {
    const parsed = new URL(url);
    host = parsed.host;
    code = parsed.searchParams.get("user_code") ?? undefined;
  } catch {
    // show the raw URL
  }
  return { url, host, code };
}
