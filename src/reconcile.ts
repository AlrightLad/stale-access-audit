// Reconciliation: for every client the GUID join resolves, compare who holds access in the RMM
// with who the PSA says should, and classify the RMM side by dormancy. Email matching between
// the two systems happens ONLY inside a joined client, so two people with the same address at
// two different clients can never be confused for each other, and nothing is matched across a
// client the join could not resolve.

import { type Cohort, type DimRow, type Grant, classify, usersWithAccess } from "./dormancy.ts";
import { type PsaClient, type PsaSite, type RmmLocation, type RmmOrg, joinOrgs, joinSites } from "./join.ts";

export type PsaAccount = {
  client_id: string;
  site_id?: string | null;
  email: string | null;
  name: string;
  active: boolean;
  /** The PSA's own flag for an account that is supposed to hold elevated or remote access. */
  privileged: boolean;
};

export type DeviceSite = { device_id: number; org_id: number | null; location_id: number | null };

export type ReconcileInput = {
  dim: DimRow[];
  grants: Grant[];
  devices: DeviceSite[];
  orgs: RmmOrg[];
  locations: RmmLocation[];
  psaClients: PsaClient[];
  psaSites: PsaSite[];
  psaAccounts: PsaAccount[];
  nowIso: string;
};

export type FindingKind =
  | "dormant_access"      // stale_90 / stale_180 and holds a current grant
  | "unknown_access"      // holds a current grant, evidence floor too recent to judge
  | "orphaned_access"     // holds a current grant, PSA has no active account for that email at this client
  | "inactive_in_psa"     // holds a current grant, PSA account exists but is inactive
  | "psa_only";           // PSA active privileged account with no RMM user at this client

export type Finding = {
  kind: FindingKind;
  client_guid: string;
  rmm_org_id: number;
  psa_client_id: string;
  client_name: string;
  user_id: number | null;
  name: string | null;
  email: string | null;
  cohort: Cohort | null;
  last_login_observed: string | null;
  backfill_floor: string | null;
  sites: string[];
};

export type ClientRow = {
  client_guid: string;
  rmm_org_id: number;
  psa_client_id: string;
  client_name: string;
  users: number;
  with_access: number;
  cohorts: Record<Cohort, number>;
  findings: number;
};

export type Report = {
  generated_at: string;
  clients: ClientRow[];
  findings: Finding[];
  unmatched: {
    rmm_orgs: { org_id: number; name: string; reason: string }[];
    psa_clients: { client_id: string; name: string; reason: string }[];
    rmm_sites: { org_id: number; location_id: number; name: string; reason: string }[];
    psa_sites: { client_id: string; site_id: string; name: string; reason: string }[];
  };
  totals: { clients_joined: number; users_in_joined_clients: number; findings: Record<FindingKind, number> };
};

const emptyCohorts = (): Record<Cohort, number> => ({ deleted: 0, disabled: 0, expired_pending: 0, observed: 0, stale_180: 0, stale_90: 0, unknown: 0 });
const normEmail = (e: string | null | undefined): string | null => { const s = String(e ?? "").trim().toLowerCase(); return s || null; };

export function reconcile(input: ReconcileInput): Report {
  const nowMs = Date.parse(input.nowIso);
  const orgJoin = joinOrgs(input.orgs, input.psaClients);
  const siteJoin = joinSites(input.locations, input.psaSites);
  const siteName = new Map<string, string>();   // `${org}:${loc}` -> PSA site name (joined) or RMM name
  for (const l of input.locations) siteName.set(`${l.org_id}:${l.location_id}`, l.name);
  for (const m of siteJoin.matched) siteName.set(`${m.left.org_id}:${m.left.location_id}`, m.right.name);
  const deviceSite = new Map<number, DeviceSite>(input.devices.map((d) => [d.device_id, d]));

  const access = usersWithAccess(input.grants, input.nowIso);
  const grantsByUser = new Map<number, Grant[]>();
  for (const g of input.grants) grantsByUser.set(g.user_id, [...(grantsByUser.get(g.user_id) ?? []), g]);
  const sitesOf = (uid: number): string[] => {
    const out = new Set<string>();
    for (const g of grantsByUser.get(uid) ?? []) { const d = deviceSite.get(g.device_id); if (d?.org_id != null && d.location_id != null) out.add(siteName.get(`${d.org_id}:${d.location_id}`) ?? `${d.org_id}:${d.location_id}`); }
    return [...out].sort();
  };

  const clients: ClientRow[] = [];
  const findings: Finding[] = [];
  const totals: Record<FindingKind, number> = { dormant_access: 0, unknown_access: 0, orphaned_access: 0, inactive_in_psa: 0, psa_only: 0 };
  let usersInJoined = 0;

  for (const m of orgJoin.matched) {
    const org = m.left, client = m.right;
    const users = input.dim.filter((r) => r.organization_id === org.org_id);
    const accounts = input.psaAccounts.filter((a) => a.client_id === client.client_id);
    const accountsByEmail = new Map<string, PsaAccount>();
    for (const a of accounts) { const e = normEmail(a.email); if (e && !accountsByEmail.has(e)) accountsByEmail.set(e, a); }
    const cohorts = emptyCohorts();
    let withAccess = 0;
    const before = findings.length;
    const base = { client_guid: m.guid, rmm_org_id: org.org_id, psa_client_id: client.client_id, client_name: client.name };
    const push = (kind: FindingKind, r: DimRow | null, extra: Partial<Finding> = {}) => {
      totals[kind]++;
      findings.push({ kind, ...base, user_id: r?.user_id ?? null, name: r ? [r.first_name, r.last_name].filter(Boolean).join(" ") || null : null,
        email: r?.email ?? null, cohort: r ? classify(r, nowMs) : null, last_login_observed: r?.last_login_observed ?? null,
        backfill_floor: r?.backfill_floor ?? null, sites: r ? sitesOf(r.user_id) : [], ...extra });
    };
    const seenEmails = new Set<string>();
    for (const r of users) {
      usersInJoined++;
      const cohort = classify(r, nowMs);
      cohorts[cohort]++;
      const has = access.has(r.user_id);
      if (has) withAccess++;
      const e = normEmail(r.email);
      if (e) seenEmails.add(e);
      if (!has) continue;
      if (cohort === "stale_90" || cohort === "stale_180") push("dormant_access", r);
      else if (cohort === "unknown") push("unknown_access", r);
      const acct = e ? accountsByEmail.get(e) : undefined;
      if (!acct) push("orphaned_access", r);
      else if (!acct.active) push("inactive_in_psa", r);
    }
    for (const a of accounts) {
      const e = normEmail(a.email);
      if (a.active && a.privileged && e && !seenEmails.has(e)) push("psa_only", null, { name: a.name, email: e });
    }
    clients.push({ ...base, users: users.length, with_access: withAccess, cohorts, findings: findings.length - before });
  }

  return {
    generated_at: input.nowIso,
    clients: clients.sort((a, b) => b.findings - a.findings || a.client_name.localeCompare(b.client_name)),
    findings,
    unmatched: {
      rmm_orgs: orgJoin.unmatched_left.map((u) => ({ org_id: u.row.org_id, name: u.row.name, reason: u.reason })),
      psa_clients: orgJoin.unmatched_right.map((u) => ({ client_id: u.row.client_id, name: u.row.name, reason: u.reason })),
      rmm_sites: siteJoin.unmatched_left.map((u) => ({ org_id: u.row.org_id, location_id: u.row.location_id, name: u.row.name, reason: u.reason })),
      psa_sites: siteJoin.unmatched_right.map((u) => ({ client_id: u.row.client_id, site_id: u.row.site_id, name: u.row.name, reason: u.reason })),
    },
    totals: { clients_joined: orgJoin.matched.length, users_in_joined_clients: usersInJoined, findings: totals },
  };
}

/** A readable rendering of the report, for a ticket or a review meeting. */
export function renderMarkdown(rep: Report): string {
  const L: string[] = [];
  L.push(`# Stale access audit — ${rep.generated_at}`, "");
  L.push(`Clients joined on the GUID pair: ${rep.totals.clients_joined} · users in joined clients: ${rep.totals.users_in_joined_clients}`, "");
  L.push("| Finding | Count |", "|---|---|");
  for (const [k, v] of Object.entries(rep.totals.findings)) L.push(`| ${k} | ${v} |`);
  L.push("", "## Clients", "", "| Client | Users | With access | Observed | Stale 90 | Stale 180 | Unknown | Findings |", "|---|---|---|---|---|---|---|---|");
  for (const c of rep.clients) L.push(`| ${c.client_name} | ${c.users} | ${c.with_access} | ${c.cohorts.observed} | ${c.cohorts.stale_90} | ${c.cohorts.stale_180} | ${c.cohorts.unknown} | ${c.findings} |`);
  if (rep.findings.length) {
    L.push("", "## Findings", "", "| Kind | Client | Who | Cohort | Last login observed | Floor | Sites |", "|---|---|---|---|---|---|---|");
    for (const f of rep.findings) L.push(`| ${f.kind} | ${f.client_name} | ${f.name ?? ""} ${f.email ? `<${f.email}>` : ""} | ${f.cohort ?? ""} | ${f.last_login_observed ?? ""} | ${f.backfill_floor ?? ""} | ${f.sites.join(", ")} |`);
  }
  const u = rep.unmatched;
  if (u.rmm_orgs.length || u.psa_clients.length) {
    L.push("", "## Unmatched (ruled on by a human, never guessed)", "");
    for (const o of u.rmm_orgs) L.push(`- RMM org ${o.org_id} "${o.name}": ${o.reason}`);
    for (const c of u.psa_clients) L.push(`- PSA client ${c.client_id} "${c.name}": ${c.reason}`);
  }
  return L.join("\n") + "\n";
}
