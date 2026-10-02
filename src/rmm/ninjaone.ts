// NinjaOne as the RMM. Everything the audit reads, and nothing else: no fleet health, no
// custom-field dictionaries beyond the two GUID fields (join.ts), no write of any kind.
import { type PageQuery, type WalkOptions, type WalkResult, walkFeed } from "../cursor.ts";
import type { ApiUser, LoginEvent } from "../dormancy.ts";
import { clean, epochSecondsToIso, num } from "../sanitize.ts";

export type RmmConfig = {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  /** Hard wall-clock abort per request. Deep activity pages can drip-feed for hours; an idle timeout never fires on a drip. */
  fetchTimeoutMs?: number;
  /** Re-mint the bearer when the cached one is older than this. */
  tokenMaxAgeMs?: number;
};

export type TokenCache = { get(): { token: string; obtained_at: number } | null; set(t: { token: string; obtained_at: number }): void };
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Any RMM the poll can run against. Implemented by NinjaOneAdapter; faked in tests. */
export interface RmmSource {
  sweepUsers(): Promise<ApiUser[]>;
  fetchLoginPage(q: PageQuery, pageSize: number): Promise<unknown[]>;
  orgs(): Promise<{ id: number; name: string }[]>;
  locations(): Promise<{ id: number; organizationId: number; name: string }[]>;
  orgCustomFields(orgId: number): Promise<unknown>;
  locationCustomFields(orgId: number, locationId: number): Promise<unknown>;
  devices(): Promise<{ id: number; organizationId: number | null; locationId: number | null }[]>;
}

/** One login activity -> a ledger row, or null when the payload has no user. */
export function ingestLogin(a: any): LoginEvent | null {
  const id = Number(a?.id);
  const t = epochSecondsToIso(a?.activityTime);
  if (!id || !t || a?.userId == null) return null;
  const p = a?.data?.message?.params ?? {};
  return { activity_id: id, user_id: Number(a.userId), activity_time: t,
    app_user_name: clean(p.appUserName) || null, app_user_email: clean(p.appUserEmail) || null,
    ip: clean(p.ip) || null, mfa_method: clean(p.mfa) || null, source: "poller" };
}

export class NinjaOneAdapter implements RmmSource {
  private readonly cfg: RmmConfig;
  private readonly tokens: TokenCache;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  apiCalls = 0;
  tokenSource: "cache" | "fresh" | null = null;

  constructor(cfg: RmmConfig, tokens: TokenCache, deps: { fetchImpl?: FetchLike; now?: () => number } = {}) {
    this.cfg = cfg;
    this.tokens = tokens;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  private async mint(): Promise<string> {
    const r = await this.fetchImpl(this.cfg.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, scope: this.cfg.scope || "monitoring management" }) });
    this.apiCalls++;
    if (!r.ok) throw new Error(`rmm token ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j: any = await r.json();
    if (!j?.access_token) throw new Error("rmm token: no access_token in response");
    return String(j.access_token);
  }

  /** The cached bearer, re-minted past max age. Shared across runs through the TokenCache. */
  async token(): Promise<string> {
    const maxAge = this.cfg.tokenMaxAgeMs ?? 30 * 60_000;
    const c = this.tokens.get();
    if (c?.token && this.now() - c.obtained_at < maxAge) { this.tokenSource ??= "cache"; return c.token; }
    const token = await this.mint();
    this.tokens.set({ token, obtained_at: this.now() });
    this.tokenSource = "fresh";
    return token;
  }

  /** GET with a hard wall-clock deadline inside the fetch, and one retry. */
  async get(path: string): Promise<any> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}${path}`;
    const timeout = this.cfg.fetchTimeoutMs ?? 120_000;
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(timeout) });
        this.apiCalls++;
        if (!r.ok) throw new Error(`${url.split("?")[0]} ${r.status}: ${(await r.text()).slice(0, 300)}`);
        return await r.json();
      } catch (e) {
        if (attempt >= 2) throw e;
      }
    }
  }

  /** The users endpoint ignores pageSize and after: one request IS the sweep. There is no pagination to terminate. */
  async sweepUsers(): Promise<ApiUser[]> {
    const users = await this.get("/v2/users?userType=END_USER");
    if (!Array.isArray(users)) throw new Error("users sweep: non-array response");
    return users;
  }

  async fetchLoginPage(q: PageQuery, pageSize: number): Promise<unknown[]> {
    const extra = q.newerThan != null ? `&newerThan=${q.newerThan}` : q.olderThan != null ? `&olderThan=${q.olderThan}` : "";
    const j = await this.get(`/v2/activities?class=USER&status=END_USER_LOGGED_IN&pageSize=${pageSize}${extra}`);
    return Array.isArray(j?.activities) ? j.activities : [];
  }

  /** Walk the login stream above `cursor`; each new login is handed to `take`. */
  walkLogins(cursor: number | null, take: (e: LoginEvent) => void, opts: WalkOptions): Promise<WalkResult> {
    return walkFeed<any>((q) => this.fetchLoginPage(q, opts.pageSize), (a) => Number(a?.id), cursor, (a) => { const e = ingestLogin(a); if (e) take(e); }, opts);
  }

  async orgs() { const j = await this.get("/v2/organizations"); return (Array.isArray(j) ? j : []).map((o: any) => ({ id: Number(o.id), name: clean(o.name) })); }
  async locations() { const j = await this.get("/v2/locations"); return (Array.isArray(j) ? j : []).map((l: any) => ({ id: Number(l.id), organizationId: Number(l.organizationId), name: clean(l.name) })); }
  orgCustomFields(orgId: number) { return this.get(`/v2/organization/${orgId}/custom-fields`); }
  locationCustomFields(orgId: number, locationId: number) { return this.get(`/v2/organization/${orgId}/location/${locationId}/custom-fields`); }

  /** The device inventory, for attributing a user's grants to sites. Id, org and location only. */
  async devices() {
    const out: { id: number; organizationId: number | null; locationId: number | null }[] = [];
    let after = 0;
    for (let page = 0; page < 20; page++) {
      const j = await this.get(`/v2/devices?pageSize=5000&after=${after}`);
      const rows: any[] = Array.isArray(j) ? j : (j?.results ?? []);
      if (!rows.length) break;
      for (const r of rows) out.push({ id: Number(r.id), organizationId: num(r.organizationId), locationId: num(r.locationId) });
      after = Number(rows[rows.length - 1].id);
      if (rows.length < 5000) break;
    }
    return out;
  }
}
