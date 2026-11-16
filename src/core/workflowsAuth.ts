/**
 * Sign-in through the IT4I Workflows extension (`qaas.workflowsIntegration` on): the API it exports,
 * the mode settings, and the in-memory cache of its short-lived access token.
 */

import { type LexisInstance, normalizeInstance, sameInstance } from "./devEnv";

export type AuthMode = "py4lexis" | "workflows";
export type WorkflowsService = "core" | "efp";

export const WORKFLOWS_EXTENSION_ID = "lexis-platform.lexis-platform";

/** Access token of the IT4I Workflows sign-in; never a refresh token. */
export interface WorkflowsAccessToken {
  token: string;
  expiresAt?: string;
  issuer?: string;
  userName?: string;
  /** LEXIS API root, e.g. https://api.lexis.tech/ */
  apiUrl: string;
  service: WorkflowsService;
}

/** API exported by the IT4I Workflows extension (apiVersion 1). */
export interface WorkflowsApi {
  readonly apiVersion: 1;
  getAccessToken(service?: WorkflowsService): Promise<WorkflowsAccessToken>;
  isSignedIn(service?: WorkflowsService): Promise<boolean>;
  signIn(service?: WorkflowsService): Promise<boolean>;
  readonly onDidChangeSession: (listener: (service: WorkflowsService) => unknown) => { dispose(): unknown };
}

/** Workflows mode needs the setting on and IT4I Workflows installed; otherwise QaaS signs in on its own. */
export function authMode(workflowsIntegration: unknown, workflowsInstalled: boolean): AuthMode {
  return workflowsIntegration === true && workflowsInstalled ? "workflows" : "py4lexis";
}

/** Clients and tokens must be dropped: the mode changed, or the service changed while it is used. */
export function signInChanged(
  before: { mode: AuthMode; service: WorkflowsService },
  after: { mode: AuthMode; service: WorkflowsService },
): boolean {
  return before.mode !== after.mode || (after.mode === "workflows" && before.service !== after.service);
}

export function workflowsService(value: unknown): WorkflowsService {
  return value === "efp" ? "efp" : "core";
}

/** LEXIS API root of each IT4I Workflows service. */
export const SERVICE_API_URLS: Record<WorkflowsService, string> = {
  core: "https://api.lexis.tech",
  efp: "https://api.workflows.my-eurohpc.eu",
};

/** LEXIS instance of a service; undefined for LEXIS production (core). */
export function serviceInstance(service: WorkflowsService): LexisInstance | undefined {
  return normalizeInstance({ apiUrl: SERVICE_API_URLS[service] });
}

/** True when the token was issued for the service and its API is the service's API. */
export function tokenMatchesService(token: WorkflowsAccessToken, service: WorkflowsService): boolean {
  return (
    token.service === service &&
    sameInstance(normalizeInstance({ apiUrl: token.apiUrl }), serviceInstance(service)) &&
    typeof token.token === "string" &&
    token.token.length > 0
  );
}

/** `code` of an error rejected by the API ("auth_required", "not_allowed"), if any. */
export function errorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/** A cached token is used until this long before it expires. */
export const EXPIRY_MARGIN_MS = 30_000;

/**
 * Access token kept in memory only, until 30 s before it expires. A token without a readable
 * expiry is never cached. Concurrent callers share one fetch.
 */
export class TokenCache {
  private cached?: WorkflowsAccessToken;
  private pending?: Promise<WorkflowsAccessToken>;
  private generation = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async get(fetch: () => Promise<WorkflowsAccessToken>): Promise<WorkflowsAccessToken> {
    if (this.cached && this.fresh(this.cached)) {
      return this.cached;
    }
    this.cached = undefined;
    const generation = this.generation;
    if (!this.pending) {
      const pending = fetch().finally(() => {
        if (this.pending === pending) {
          this.pending = undefined;
        }
      });
      this.pending = pending;
    }
    const token = await this.pending;
    if (generation !== this.generation) {
      // Invalidated while fetching: the token may belong to the old sign-in.
      return this.get(fetch);
    }
    if (this.fresh(token)) {
      this.cached = token;
    }
    return token;
  }

  /** Forget the token (sign-in changed, mode or service changed). */
  invalidate(): void {
    this.cached = undefined;
    this.pending = undefined;
    this.generation++;
  }

  private fresh(t: WorkflowsAccessToken): boolean {
    const expires = t.expiresAt ? Date.parse(t.expiresAt) : Number.NaN;
    return Number.isFinite(expires) && expires - EXPIRY_MARGIN_MS > this.now();
  }
}
