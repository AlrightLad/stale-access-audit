import { test } from "node:test";
import assert from "node:assert/strict";
import type { DimRow } from "../src/dormancy.ts";
import { reconcile, renderMarkdown } from "../src/reconcile.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const day = (n: number) => new Date(Date.parse(T0) + n * 86_400_000).toISOString();
const NOW = day(400);
const row = (over: Partial<DimRow>): DimRow => ({ user_id: 1, uid: null, first_name: "A", last_name: "B", email: "a@x", enabled: true, invitation_status: "REGISTERED",
  organization_id: 1, mfa_configured: null, identity_source: "api", first_seen_at: T0, last_seen_in_api_at: NOW, deleted_observed_at: null, api_missing_streak: 0,
  last_login_observed: null, backfill_floor: T0, evidence: "no_evidence_below_floor", updated_at: NOW, ...over });

const input = () => ({
  dim: [
    row({ user_id: 1, email: "active@c1", evidence: "observed", last_login_observed: day(399) }),           // fine
    row({ user_id: 2, email: "dormant@c1", evidence: "observed", last_login_observed: day(100) }),          // stale_180, has access
    row({ user_id: 3, email: "nobody@c1" }),                                                                // floor at T0 -> stale_180, not in PSA
    row({ user_id: 4, email: "shared@x", evidence: "observed", last_login_observed: day(399) }),            // same email exists at client 2 in the PSA
    row({ user_id: 5, organization_id: 2, email: "shared@x", evidence: "observed", last_login_observed: day(399) }),
    row({ user_id: 6, email: "recent@c1", backfill_floor: day(395) }),                                       // unknown, has access
    row({ user_id: 7, email: "noaccess@c1", evidence: "observed", last_login_observed: day(50) }),           // stale but no grant: not a finding
  ],
  grants: [1, 2, 3, 4, 5, 6].map((u) => ({ user_id: u, device_id: 100 + u, first_seen_at: T0, last_seen_at: NOW })),
  devices: [1, 2, 3, 4, 6].map((u) => ({ device_id: 100 + u, org_id: 1, location_id: 10 })).concat([{ device_id: 105, org_id: 2, location_id: 20 }]),
  orgs: [{ org_id: 1, name: "Client One (RMM name)", org_guid: "guid-1" }, { org_id: 2, name: "Client Two", org_guid: "guid-2" }, { org_id: 3, name: "Not onboarded", org_guid: null }],
  locations: [{ org_id: 1, location_id: 10, name: "HQ", site_guid: "site-1" }, { org_id: 2, location_id: 20, name: "Main", site_guid: null }],
  psaClients: [{ client_id: "A", name: "Client One", client_guid: "GUID-1" }, { client_id: "B", name: "Client Two", client_guid: "guid-2" }],
  psaSites: [{ client_id: "A", site_id: "s1", name: "Head Office", site_guid: "site-1" }],
  psaAccounts: [
    { client_id: "A", email: "active@c1", name: "Active", active: true, privileged: true },
    { client_id: "A", email: "dormant@c1", name: "Dormant", active: true, privileged: true },
    { client_id: "A", email: "recent@c1", name: "Recent", active: false, privileged: true },
    { client_id: "A", email: "psaonly@c1", name: "PSA Only", active: true, privileged: true },
    { client_id: "A", email: "contact@c1", name: "Not privileged", active: true, privileged: false },
    { client_id: "B", email: "shared@x", name: "Shared", active: true, privileged: true },
  ],
  nowIso: NOW,
});

test("the join scopes everything: clients joined on the GUID pair, unmatched listed with reasons", () => {
  const rep = reconcile(input());
  assert.equal(rep.totals.clients_joined, 2);
  assert.deepEqual(rep.unmatched.rmm_orgs, [{ org_id: 3, name: "Not onboarded", reason: "no_guid" }]);
  assert.deepEqual(rep.unmatched.rmm_sites.map((s) => s.reason), ["no_guid"]);
});

test("findings on client one: dormant, orphaned, inactive-in-PSA, unknown, PSA-only; a stale user without a grant is not a finding", () => {
  const rep = reconcile(input());
  const c1 = rep.findings.filter((f) => f.psa_client_id === "A");
  const kinds = (email: string) => c1.filter((f) => f.email === email).map((f) => f.kind).sort();
  assert.deepEqual(kinds("dormant@c1"), ["dormant_access"]);
  assert.deepEqual(kinds("nobody@c1"), ["dormant_access", "orphaned_access"]);
  assert.deepEqual(kinds("recent@c1"), ["inactive_in_psa", "unknown_access"]);
  assert.deepEqual(kinds("psaonly@c1"), ["psa_only"]);
  assert.deepEqual(kinds("contact@c1"), [], "a non-privileged PSA contact with no RMM user is not a finding");
  assert.deepEqual(kinds("noaccess@c1"), []);
  assert.deepEqual(kinds("active@c1"), []);
});

test("email matching never crosses clients: the same address at two clients is two people", () => {
  const rep = reconcile(input());
  const shared = rep.findings.filter((f) => f.email === "shared@x");
  assert.deepEqual(shared.map((f) => [f.psa_client_id, f.kind]), [["A", "orphaned_access"]], "client one has no PSA account for it; client two does");
});

test("sites come from the user's grants through the device inventory, named by the joined PSA site", () => {
  const rep = reconcile(input());
  const f = rep.findings.find((x) => x.email === "dormant@c1")!;
  assert.deepEqual(f.sites, ["Head Office"]);
  assert.equal(f.cohort, "stale_180"); assert.equal(f.last_login_observed, day(100));
});

test("client rows carry cohort counts and sort by findings", () => {
  const rep = reconcile(input());
  assert.equal(rep.clients[0].psa_client_id, "A");
  assert.equal(rep.clients[0].users, 6); assert.equal(rep.clients[0].with_access, 5);
  assert.equal(rep.clients[0].cohorts.observed, 2); assert.equal(rep.clients[0].cohorts.stale_180, 3); assert.equal(rep.clients[0].cohorts.unknown, 1);
  assert.equal(rep.clients[1].findings, 0);
});

test("markdown rendering lists totals, clients, findings and unmatched", () => {
  const md = renderMarkdown(reconcile(input()));
  assert.match(md, /Clients joined on the GUID pair: 2/);
  assert.match(md, /\| dormant_access \| Client One \|/);
  assert.match(md, /RMM org 3 "Not onboarded": no_guid/);
});
