import { test } from "node:test";
import assert from "node:assert/strict";
import { joinByGuid, joinOrgs, normGuid, pickGuid } from "../src/join.ts";

test("pickGuid reads exactly the named field and nothing else in the dictionary", () => {
  const cf = { orgGuid: " 1F2E-3D4C ", localAdminUser: "admin", backupRepoKey: "secret" };
  assert.equal(pickGuid(cf, "orgGuid"), "1F2E-3D4C");
  assert.equal(pickGuid(cf, "siteGuid"), null);
  assert.equal(pickGuid(cf, ""), null);
  assert.equal(pickGuid(null, "orgGuid"), null);
  assert.equal(pickGuid("not an object", "orgGuid"), null);
});

test("normGuid folds case, trims and drops braces", () => {
  assert.equal(normGuid(" {ABC-DEF} "), "abc-def");
  assert.equal(normGuid(""), null);
  assert.equal(normGuid(undefined), null);
});

test("joinOrgs: exact single match on the GUID; names are irrelevant", () => {
  const r = joinOrgs(
    [{ org_id: 1, name: "Acme Inc", org_guid: "g1" }, { org_id: 2, name: "Beta", org_guid: "g2" }],
    [{ client_id: "A", name: "ACME, Inc.", client_guid: "G1" }, { client_id: "B", name: "Gamma", client_guid: "g3" }],
  );
  assert.equal(r.matched.length, 1);
  assert.equal(r.matched[0].left.org_id, 1); assert.equal(r.matched[0].right.client_id, "A");
  assert.deepEqual(r.unmatched_left.map((u) => [u.row.org_id, u.reason]), [[2, "no_counterpart"]]);
  assert.deepEqual(r.unmatched_right.map((u) => [u.row.client_id, u.reason]), [["B", "no_counterpart"]]);
});

test("a missing GUID is unmatched with reason no_guid: it surfaces as not onboarded, never as a wrong join", () => {
  const r = joinOrgs([{ org_id: 1, name: "X", org_guid: null }], [{ client_id: "A", name: "X", client_guid: null }]);
  assert.equal(r.matched.length, 0);
  assert.equal(r.unmatched_left[0].reason, "no_guid"); assert.equal(r.unmatched_right[0].reason, "no_guid");
});

test("a GUID carried by two rows on either side is ambiguous: every row carrying it is excluded, nothing is guessed", () => {
  const r = joinByGuid([{ k: "dup", n: 1 }, { k: "dup", n: 2 }, { k: "ok", n: 3 }], (l) => l.k, [{ k: "dup", n: 9 }, { k: "ok", n: 8 }], (x) => x.k);
  assert.deepEqual(r.matched.map((m) => [m.left.n, m.right.n]), [[3, 8]]);
  assert.deepEqual(r.unmatched_left.map((u) => [u.row.n, u.reason]), [[1, "ambiguous"], [2, "ambiguous"]]);
  assert.deepEqual(r.unmatched_right.map((u) => [u.row.n, u.reason]), [[9, "ambiguous"]]);
});
