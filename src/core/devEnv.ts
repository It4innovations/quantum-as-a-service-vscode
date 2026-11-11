/**
 * Developer overrides for the LEXIS connection, read from a dotenv-style file
 * (default `.qaas/dev.env`, git-ignored). Lets you point the extension at a test LEXIS
 * instance with a test project, resource and refresh token, without touching user settings.
 */

export const PRODUCTION_AAI_URL = "https://aai.lexis.tech";
export const PRODUCTION_API_URL = "https://api.lexis.tech";

/** Keys understood in the dev file (same names as the environment variables py4lexis reads). */
export const DEV_KEYS = [
  "PY4LEXIS_AAI_URL",
  "PY4LEXIS_API_URL",
  "PY4LEXIS_REALM",
  "QAAS_LEXIS_PROJECT",
  "QAAS_LEXIS_RESOURCE",
  "QAAS_BACKEND_NAME",
  "QAAS_LEXIS_TOKEN",
] as const;
export type DevKey = (typeof DEV_KEYS)[number];

/** Parse `KEY=value` lines; `#` comments, blank lines, `export ` prefixes and quotes are handled. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    let value = m[2].trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) {
      value = quoted[2];
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    if (value) {
      out[m[1]] = value;
    }
  }
  return out;
}

/** Which LEXIS instance requests go to. Empty fields mean the production defaults. */
export interface LexisInstance {
  aaiUrl?: string;
  apiUrl?: string;
  realm?: string;
}

const trimUrl = (u?: string) => u?.trim().replace(/\/+$/, "") || undefined;

/** Normalised instance with production URLs dropped, or undefined for plain production. */
export function normalizeInstance(i: LexisInstance): LexisInstance | undefined {
  const aaiUrl = trimUrl(i.aaiUrl);
  const apiUrl = trimUrl(i.apiUrl);
  const out: LexisInstance = {
    aaiUrl: aaiUrl === PRODUCTION_AAI_URL ? undefined : aaiUrl,
    apiUrl: apiUrl === PRODUCTION_API_URL ? undefined : apiUrl,
    realm: i.realm?.trim() || undefined,
  };
  return out.aaiUrl || out.apiUrl || out.realm ? out : undefined;
}

/** Short label for a non-production instance, e.g. "staging" for api.staging.example.org. */
export function instanceLabel(i?: LexisInstance): string | undefined {
  if (!i) {
    return undefined;
  }
  const host = (i.apiUrl ?? i.aaiUrl ?? "")
    .replace(/^\w+:\/\//, "")
    .split(/[/:]/)[0]
    .replace(/^(?:api|aai)\./, "");
  const labels = host.split(".");
  return labels.length >= 3 ? labels[0] : host || "custom";
}

/** Template written by "QaaS: Open Dev Connection File". */
export function devEnvTemplate(): string {
  return `# QaaS developer connection (git-ignored). Values here override the qaas.* settings.
# Delete or rename this file to go back to production. Changes apply to the next request.

# LEXIS instance (production: https://aai.lexis.tech, https://api.lexis.tech, realm LEXIS_AAI_v2)
PY4LEXIS_AAI_URL=
PY4LEXIS_API_URL=
PY4LEXIS_REALM=

# Project, resource and backend on that instance
QAAS_LEXIS_PROJECT=
QAAS_LEXIS_RESOURCE=
# QAAS_BACKEND_NAME=VLQ

# Refresh/offline token (recommended: renewed automatically) or an access token (expires in minutes).
# Leave empty to log in through the browser on the instance above.
QAAS_LEXIS_TOKEN=
`;
}
