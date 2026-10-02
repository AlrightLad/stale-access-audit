import { test } from "node:test";
import assert from "node:assert/strict";
import { type DimRow, type LoginEvent, applyGrants, applySweep, classify, ghostRows, moveFloor, rollupEvidence, sweepIsComplete, usersWithAccess } from "../src/dormancy.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const day = (n: number) => new Date(Date.parse(T0) + n * 86_400_000).toISOString();
const NOW = Date.parse(day(400));

const row = (over: Partial<DimRow> = {}): DimRow => ({ user_id: 1, uid: null, first_name: "A", last_name: "B", email: "a@b", enabled: true, invitation_status: "REGISTERED",
  organization_id: 10, mfa_configured: null, identity_source: "api", first_seen_at: T0, last_seen_in_api_at: T0, deleted_observed_at: null, api_missing_streak: 0,
  last_login_observed: null, backfill_floor: T0, evidence: "no_evidence_below_floor", updated_at: T0, ...over });

test("sweepIsComplete: first sweep baselines; a collapse below 90% of the last complete sweep is incomplete", () => {
  assert.equal(sweepIsComplete(5, null), true);
  assert.equal(sweepIsComplete(90, 100), true);
  assert.equal(sweepIsComplete(89, 100), false);
});

test("applySweep: insert sets the floor; update never touches floor, evidence or last login; API identity wins", () => {
  const dim = new Map<number, DimRow>();
  applySweep(dim, [{ id: 1, firstName: "Ada", lastName: "L", email: "ada@x", enabled: true, invitationStatus: "REGISTERED", organizationId: 10 }], day(1), true);
  assert.equal(dim.get(1)!.backfill_floor, day(1));
  dim.set(1, { ...dim.get(1)!, last_login_observed: day(0), evidence: "observed" });
  applySweep(dim, [{ id: 1, firstName: "Ada", lastName: "Lovelace", email: "ada@x", enabled: true, invitationStatus: "REGISTERED", organizationId: 10 }], day(2), true);
  const r = dim.get(1)!;
  assert.equal(r.backfill_floor, day(1), "floor is applied on insert only");
  assert.equal(r.last_login_observed, day(0)); assert.equal(r.evidence, "observed");
  assert.equal(r.last_name, "Lovelace"); assert.equal(r.last_seen_in_api_at, day(2));
});

test("deletion needs THREE consecutive COMPLETE sweeps absent; an incomplete sweep bumps nothing; reappearance clears it", () => {
  const dim = new Map<number, DimRow>([[1, row()], [2, row({ user_id: 2 })]]);
  const only2 = [{ id: 2 }];
  applySweep(dim, only2, day(1), false);
  assert.equal(dim.get(1)!.api_missing_streak, 0, "incomplete sweep must not bump the streak");
  applySweep(dim, only2, day(2), true); applySweep(dim, only2, day(3), true);
  assert.equal(dim.get(1)!.api_missing_streak, 2); assert.equal(dim.get(1)!.deleted_observed_at, null);
  const r3 = applySweep(dim, only2, day(4), true);
  assert.equal(dim.get(1)!.deleted_observed_at, day(4)); assert.equal(r3.deleted_marked, 1);
  const back = applySweep(dim, [{ id: 1 }, { id: 2 }], day(5), true);
  assert.equal(back.resurrected, 1); assert.equal(dim.get(1)!.deleted_observed_at, null); assert.equal(dim.get(1)!.api_missing_streak, 0);
});

test("ghost rows (payload-only identity) never accrue a missing streak", () => {
  const dim = new Map<number, DimRow>([[9, row({ user_id: 9, identity_source: "event_payload", last_seen_in_api_at: null })]]);
  applySweep(dim, [{ id: 1 }], day(1), true);
  assert.equal(dim.get(9)!.api_missing_streak, 0);
});

test("grants: watermark upsert, no deletes; access = refreshed within 48h of the newest grant", () => {
  const grants = new Map();
  applyGrants(grants, [{ id: 1, deviceIds: [100, 101] }, { id: 2, deviceIds: [100] }], day(1));
  applyGrants(grants, [{ id: 1, deviceIds: [100] }], day(5));
  assert.equal(grants.size, 3, "nothing is deleted");
  assert.equal(grants.get("1:100").first_seen_at, day(1)); assert.equal(grants.get("1:100").last_seen_at, day(5));
  const access = usersWithAccess(grants.values(), day(5));
  assert.deepEqual([...access], [1], "user 2's grant aged out of the window");
});

test("evidence rollup: login events set last_login_observed to the max and evidence to observed; the max only grows", () => {
  const dim = new Map<number, DimRow>([[1, row()]]);
  const ledger: LoginEvent[] = [{ activity_id: 5, user_id: 1, activity_time: day(10), app_user_name: null, app_user_email: null, ip: null, mfa_method: null, source: "poller" },
    { activity_id: 3, user_id: 1, activity_time: day(7), app_user_name: null, app_user_email: null, ip: null, mfa_method: null, source: "poller" }];
  assert.equal(rollupEvidence(dim, ledger, day(11)), 1);
  assert.equal(dim.get(1)!.last_login_observed, day(10)); assert.equal(dim.get(1)!.evidence, "observed");
  assert.equal(rollupEvidence(dim, ledger, day(12)), 0, "idempotent");
});

test("moveFloor: a walk that did not close moves every older floor to run start and leaves this run's rows alone", () => {
  const dim = new Map<number, DimRow>([[1, row({ backfill_floor: day(1) })], [2, row({ user_id: 2, backfill_floor: day(20) })]]);
  assert.equal(moveFloor(dim, day(20)), 1);
  assert.equal(dim.get(1)!.backfill_floor, day(20)); assert.equal(dim.get(2)!.backfill_floor, day(20));
});

test("ghostRows: a login from a user the API never showed becomes a payload-identity row with the run-start floor", () => {
  const dim = new Map<number, DimRow>();
  const g = ghostRows(dim, [{ activity_id: 1, user_id: 77, activity_time: day(1), app_user_name: "Grace  Hopper", app_user_email: "g@x", ip: null, mfa_method: null, source: "poller" }], new Set([1]), day(2));
  assert.equal(g.length, 1);
  assert.equal(g[0].first_name, "Grace"); assert.equal(g[0].last_name, "Hopper"); assert.equal(g[0].identity_source, "event_payload"); assert.equal(g[0].backfill_floor, day(2));
  assert.equal(ghostRows(dim, [], new Set(), day(2)).length, 0);
});

test("classify: precedence deleted > disabled > expired_pending > observed > stale_180 > stale_90 > unknown", () => {
  assert.equal(classify(row({ deleted_observed_at: day(1), enabled: false }), NOW), "deleted");
  assert.equal(classify(row({ identity_source: "event_payload", last_seen_in_api_at: null }), NOW), "deleted");
  assert.equal(classify(row({ enabled: false, invitation_status: "EXPIRED" }), NOW), "disabled");
  assert.equal(classify(row({ invitation_status: "PENDING", evidence: "observed", last_login_observed: day(399) }), NOW), "expired_pending");
  assert.equal(classify(row({ evidence: "observed", last_login_observed: day(399) }), NOW), "observed");
  assert.equal(classify(row({ evidence: "observed", last_login_observed: day(400 - 91) }), NOW), "stale_90");
  assert.equal(classify(row({ evidence: "observed", last_login_observed: day(400 - 181) }), NOW), "stale_180");
});

test("classify with NO evidence judges from the floor, never from absence: a recent floor is unknown", () => {
  assert.equal(classify(row({ backfill_floor: day(399) }), NOW), "unknown");
  assert.equal(classify(row({ backfill_floor: day(400 - 90) }), NOW), "stale_90");
  assert.equal(classify(row({ backfill_floor: day(400 - 180) }), NOW), "stale_180");
});

test("stale_90 and stale_180 are bands, not nested", () => {
  const c = classify(row({ evidence: "observed", last_login_observed: day(400 - 120) }), NOW);
  assert.equal(c, "stale_90");
});
