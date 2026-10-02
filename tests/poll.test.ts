import { test } from "node:test";
import assert from "node:assert/strict";
import { runPoll } from "../src/poll.ts";
import { ingestLogin, type RmmSource } from "../src/rmm/ninjaone.ts";
import { emptyState } from "../src/store/json.ts";

const T0 = Date.parse("2026-03-01T00:00:00.000Z");
const sec = (ms: number) => ms / 1000;
const login = (id: number, userId: number, atMs: number, name = "Ada Lovelace", email = "ada@c1") =>
  ({ id, userId, activityTime: sec(atMs), data: { message: { params: { appUserName: name, appUserEmail: email, ip: "203.0.113.5", mfa: "app" } } } });

/** A fake RMM: a roster, an id-descending login feed, two orgs with GUID fields, one device inventory. */
function fakeRmm(opts: { users?: any[]; logins?: any[]; failOrg?: number } = {}) {
  const users = opts.users ?? [{ id: 1, firstName: "Ada", lastName: "Lovelace", email: "ada@c1", enabled: true, invitationStatus: "REGISTERED", organizationId: 10, deviceIds: [100] },
    { id: 2, firstName: "Bob", lastName: "B", email: "bob@c1", enabled: true, invitationStatus: "REGISTERED", organizationId: 10, deviceIds: [] }];
  const logins = (opts.logins ?? [login(900, 1, T0 - 86_400_000)]).sort((a, b) => b.id - a.id);
  const calls: string[] = [];
  const rmm: RmmSource = {
    async sweepUsers() { calls.push("users"); return users; },
    async fetchLoginPage(q, pageSize) {
      calls.push(`logins ${JSON.stringify(q)}`);
      let rows = logins;
      if (q.newerThan != null) rows = rows.filter((a) => a.id > q.newerThan!);
      if (q.olderThan != null) rows = rows.filter((a) => a.id < q.olderThan!);
      return rows.slice(0, pageSize);
    },
    async orgs() { calls.push("orgs"); return [{ id: 10, name: "Client One" }, { id: 11, name: "Client Two" }]; },
    async locations() { calls.push("locations"); return [{ id: 50, organizationId: 10, name: "HQ" }]; },
    async orgCustomFields(id) { calls.push(`orgcf ${id}`); if (id === opts.failOrg) throw new Error("boom"); return { orgGuid: `guid-${id}`, localAdminUser: "should-never-be-read", backupKey: "nor-this" }; },
    async locationCustomFields(o, l) { calls.push(`loccf ${o}/${l}`); return { siteGuid: `site-${l}` }; },
    async devices() { calls.push("devices"); return [{ id: 100, organizationId: 10, locationId: 50 }]; },
  };
  return { rmm, calls, users, logins };
}

const OPTS = { orgGuidField: "orgGuid", siteGuidField: "siteGuid", pageSize: 10, now: () => T0 };

test("first run: users inserted with the run-start floor, head page of logins ingested, evidence rolled up, GUIDs collected under the allowlist, bookkeeping written", async () => {
  const f = fakeRmm();
  const { state, summary } = await runPoll(f.rmm, emptyState(), OPTS);
  assert.equal(summary.written, true); assert.equal(summary.ok, true);
  assert.equal(state.dim.length, 2);
  const ada = state.dim.find((r) => r.user_id === 1)!;
  assert.equal(ada.backfill_floor, new Date(T0).toISOString());
  assert.equal(ada.evidence, "observed"); assert.equal(ada.last_login_observed, new Date(T0 - 86_400_000).toISOString());
  assert.equal(state.ledger.length, 1); assert.equal(state.grants.length, 1);
  assert.deepEqual(state.orgs.map((o) => [o.org_id, o.org_guid]), [[10, "guid-10"], [11, "guid-11"]]);
  assert.deepEqual(state.locations.map((l) => [l.location_id, l.site_guid]), [[50, "site-50"]]);
  assert.ok(!JSON.stringify(state).includes("should-never-be-read"), "only the configured GUID field leaves the custom-fields dictionary");
  assert.equal(state.poll_state.last_complete_sweep?.count, 2);
  assert.equal(summary.sweep_complete, true); assert.equal(summary.prior_sweep_count, null);
});

test("second run: the cursor is max(activity_id) of the ledger; nothing below it is re-ingested; a quiet feed is fine", async () => {
  const f = fakeRmm({ logins: [login(900, 1, T0 - 86_400_000), login(901, 2, T0 - 3_600_000, "Bob B", "bob@c1")] });
  const r1 = await runPoll(f.rmm, emptyState(), OPTS);
  f.calls.length = 0;
  const r2 = await runPoll(f.rmm, r1.state, { ...OPTS, now: () => T0 + 3_600_000 });
  assert.equal(r2.summary.cursor_before, 901);
  assert.ok(f.calls.some((c) => c.includes('"newerThan":901')));
  assert.equal(r2.summary.login_events_new, 0); assert.equal(r2.state.ledger.length, 2);
});

test("preview: nothing written, GUID sweep skipped, walk reported but not performed", async () => {
  const f = fakeRmm({ logins: Array.from({ length: 30 }, (_, i) => login(1000 + i, 1, T0 - i * 60_000)) });
  const seeded = await runPoll(f.rmm, emptyState(), OPTS);
  seeded.state.ledger = [{ ...seeded.state.ledger[0], activity_id: 500, activity_time: new Date(T0 - 5 * 86_400_000).toISOString() }];   // an old cursor with a backlog above it
  f.calls.length = 0;
  const { state, summary } = await runPoll(f.rmm, seeded.state, { ...OPTS, preview: true });
  assert.equal(summary.written, false); assert.equal(summary.walk?.walk_needed, true); assert.equal(summary.walk?.closed, false);
  assert.match(summary.walk?.note ?? "", /preview/);
  assert.ok(!f.calls.includes("orgs") && !f.calls.includes("devices"));
  assert.equal(state, seeded.state, "state object untouched");
});

test("a walk that does not close moves every older floor to run start and the run reports ok=false", async () => {
  const f = fakeRmm({ logins: Array.from({ length: 30 }, (_, i) => login(1000 + i, 1, T0 - i * 60_000)) });
  const seeded = await runPoll(f.rmm, emptyState(), OPTS);
  const oldFloor = new Date(T0 - 100 * 86_400_000).toISOString();
  seeded.state.dim = seeded.state.dim.map((r) => ({ ...r, backfill_floor: oldFloor }));
  seeded.state.ledger = [{ ...seeded.state.ledger[0], activity_id: 500, activity_time: new Date(T0 - 5 * 86_400_000).toISOString() }];
  const later = T0 + 86_400_000;
  const { state, summary } = await runPoll(f.rmm, seeded.state, { ...OPTS, now: () => later, walk: { maxPages: 1 } });
  assert.equal(summary.ok, false); assert.equal(summary.walk?.closed, false);
  assert.equal(summary.floor_moved_rows, 2);
  assert.ok(state.dim.every((r) => r.backfill_floor === new Date(later).toISOString()));
  assert.match(summary.note ?? "", /did not close/);
});

test("an incomplete sweep writes identity but never bumps deletion streaks; an empty sweep writes nothing", async () => {
  const f = fakeRmm();
  const r1 = await runPoll(f.rmm, emptyState(), OPTS);
  r1.state.poll_state.last_complete_sweep = { count: 100, at: new Date(T0).toISOString() };   // pretend the last complete sweep was far larger
  const r2 = await runPoll(f.rmm, r1.state, { ...OPTS, now: () => T0 + 1000 });
  assert.equal(r2.summary.sweep_complete, false); assert.equal(r2.summary.streak_bumped, 0);
  assert.equal(r2.state.poll_state.last_complete_sweep?.count, 100, "an incomplete sweep does not become the baseline");
  const empty = fakeRmm({ users: [] });
  const r3 = await runPoll(empty.rmm, r2.state, OPTS);
  assert.equal(r3.summary.written, false); assert.match(r3.summary.reason ?? "", /zero rows/);
});

test("a login from a user the API never showed creates a payload-identity row (ghost)", async () => {
  const f = fakeRmm({ logins: [login(900, 1, T0 - 1000), login(901, 42, T0 - 500, "Grace Hopper", "grace@c1")] });
  const { state, summary } = await runPoll(f.rmm, emptyState(), OPTS);
  assert.equal(summary.ghost_rows, 1);
  const g = state.dim.find((r) => r.user_id === 42)!;
  assert.equal(g.identity_source, "event_payload"); assert.equal(g.first_name, "Grace"); assert.equal(g.last_seen_in_api_at, null);
});

test("a failed custom-fields call skips that entity and keeps the stored GUID", async () => {
  const f = fakeRmm();
  const r1 = await runPoll(f.rmm, emptyState(), OPTS);
  const g = fakeRmm({ failOrg: 11 });
  const r2 = await runPoll(g.rmm, r1.state, OPTS);
  assert.deepEqual(r2.state.orgs.map((o) => [o.org_id, o.org_guid]), [[10, "guid-10"], [11, "guid-11"]]);
});

test("ingestLogin: payload without a user or time is dropped; controls are stripped", () => {
  assert.equal(ingestLogin({ id: 1, activityTime: sec(T0) }), null);
  assert.equal(ingestLogin({ id: 1, userId: 5 }), null);
  const e = ingestLogin(login(7, 5, T0, "A\u0000da", "a@b"))!;
  assert.equal(e.app_user_name, "Ada"); assert.equal(e.ip, "203.0.113.5"); assert.equal(e.mfa_method, "app");
});
