// The evidence model and the cohort rule. Pure functions over in-memory rows; the store is
// whatever the caller gives them.
//
// EVIDENCE, NOT ABSENCE. A user with no login on record is not "stale": either we observed
// their last login, or we have observed NOTHING below a floor. backfill_floor is the start of
// the span of the login feed that was read CONTIGUOUSLY. It is a property of the sweep, not of
// the user, and every writer that creates a row must set it (the production column is NOT NULL
// with no default, so a forgotten floor fails loudly instead of silently dropping the row out of
// every cohort predicate). When a walk cannot prove continuity, the known-continuous span starts
// at that run, so the floor moves forward and the affected users fall back to "unknown".
// Conservative on purpose: an access-review exhibit must never call someone stale on a gap.

import { splitName } from "./sanitize.ts";

export type Evidence = "observed" | "no_evidence_below_floor";
export type IdentitySource = "api" | "event_payload";

export type DimRow = {
  user_id: number;
  uid: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  enabled: boolean | null;
  invitation_status: string | null;      // REGISTERED | EXPIRED | PENDING
  organization_id: number | null;
  mfa_configured: boolean | null;
  identity_source: IdentitySource;      // payload identity never overwrites api identity
  first_seen_at: string;
  last_seen_in_api_at: string | null;   // watermark from each users sweep
  deleted_observed_at: string | null;   // set after absence from N consecutive COMPLETE sweeps
  api_missing_streak: number;
  last_login_observed: string | null;
  backfill_floor: string;
  evidence: Evidence;
  updated_at: string;
};

export type Grant = { user_id: number; device_id: number; first_seen_at: string; last_seen_at: string };

export type LoginEvent = {
  activity_id: number;
  user_id: number;
  activity_time: string;
  app_user_name: string | null;
  app_user_email: string | null;
  ip: string | null;
  mfa_method: string | null;
  source: "poller" | "seed_walk";
};

/** One user as the RMM's users endpoint returns it. Only the fields the model reads. */
export type ApiUser = {
  id: number | string;
  uid?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  enabled?: boolean | null;
  invitationStatus?: string | null;
  organizationId?: number | string | null;
  mfaConfigured?: boolean | null;
  deviceIds?: (number | string)[] | null;
};

export type Cohort = "deleted" | "disabled" | "expired_pending" | "observed" | "stale_180" | "stale_90" | "unknown";

export const SWEEP_COMPLETE_RATIO = 0.9;   // a sweep that collapsed below this share of the last complete one is incomplete
export const MISSING_STREAK_DELETE = 3;    // consecutive complete sweeps absent before a user is marked deleted
export const GRANT_WINDOW_HOURS = 48;      // a grant is current if refreshed within this of the newest grant
export const GAP_HOURS = 48;               // ledger older than this at run start => gap-fill back-walk
const DAY_MS = 86_400_000;

/** Complete = the request succeeded AND the count did not collapse. The first sweep baselines as complete. */
export const sweepIsComplete = (count: number, priorCount: number | null): boolean =>
  priorCount == null || count >= priorCount * SWEEP_COMPLETE_RATIO;

const str = (v: unknown): string | null => { const s = String(v ?? "").trim(); return s || null; };

/**
 * Upsert the users sweep into the dimension. API identity wins; floor, evidence and last login
 * are untouched on update; a reappearance zeroes the streak and clears deleted_observed_at.
 * Deletion detection runs ONLY on a complete sweep: a truncated response must not bump streaks,
 * because that is how users get falsely marked deleted in the audit trail.
 */
export function applySweep(dim: Map<number, DimRow>, users: ApiUser[], runStartIso: string, sweepComplete: boolean) {
  let inserted = 0, updated = 0, resurrected = 0, streakBumped = 0, deletedMarked = 0;
  const sweepIds = new Set<number>();
  for (const u of users) {
    const id = Number(u.id);
    if (!id) continue;
    sweepIds.add(id);
    const identity = {
      uid: str(u.uid), first_name: str(u.firstName), last_name: str(u.lastName), email: str(u.email),
      enabled: typeof u.enabled === "boolean" ? u.enabled : null,
      invitation_status: str(u.invitationStatus),
      organization_id: u.organizationId != null ? Number(u.organizationId) : null,
      mfa_configured: typeof u.mfaConfigured === "boolean" ? u.mfaConfigured : null,
    };
    const row = dim.get(id);
    if (row) {
      if (row.deleted_observed_at) resurrected++;
      dim.set(id, { ...row, ...identity, identity_source: "api", last_seen_in_api_at: runStartIso, api_missing_streak: 0, deleted_observed_at: null, updated_at: runStartIso });
      updated++;
    } else {
      dim.set(id, { user_id: id, ...identity, identity_source: "api", first_seen_at: runStartIso, last_seen_in_api_at: runStartIso,
        deleted_observed_at: null, api_missing_streak: 0, last_login_observed: null,
        backfill_floor: runStartIso,   // applied on INSERT only
        evidence: "no_evidence_below_floor", updated_at: runStartIso });
      inserted++;
    }
  }
  if (sweepComplete) {
    for (const [id, row] of dim) {
      if (sweepIds.has(id) || row.last_seen_in_api_at == null) continue;   // ghosts the API never showed cannot go missing
      dim.set(id, { ...row, api_missing_streak: row.api_missing_streak + 1, updated_at: runStartIso });
      streakBumped++;
    }
    for (const [id, row] of dim) {
      if (row.deleted_observed_at == null && row.api_missing_streak >= MISSING_STREAK_DELETE) {
        dim.set(id, { ...row, deleted_observed_at: runStartIso, updated_at: runStartIso });
        deletedMarked++;
      }
    }
  }
  return { inserted, updated, resurrected, streak_bumped: streakBumped, deleted_marked: deletedMarked, sweep_ids: sweepIds };
}

/** Watermark upsert of user <-> device grants. No deletes: a grant that stops being refreshed ages out of the window. */
export function applyGrants(grants: Map<string, Grant>, users: ApiUser[], nowIso: string): number {
  let pairs = 0;
  for (const u of users) {
    const uid = Number(u.id);
    if (!uid) continue;
    for (const d of Array.isArray(u.deviceIds) ? u.deviceIds : []) {
      const did = Number(d);
      if (!did) continue;
      pairs++;
      const key = `${uid}:${did}`;
      const prev = grants.get(key);
      grants.set(key, prev ? { ...prev, last_seen_at: nowIso } : { user_id: uid, device_id: did, first_seen_at: nowIso, last_seen_at: nowIso });
    }
  }
  return pairs;
}

/** The set of users with a CURRENT grant: refreshed within the window of the newest grant on record. */
export function usersWithAccess(grants: Iterable<Grant>, nowIso: string): Set<number> {
  let newest = 0;
  const all = [...grants];
  for (const g of all) newest = Math.max(newest, Date.parse(g.last_seen_at) || 0);
  const ref = newest || Date.parse(nowIso);
  const floor = ref - GRANT_WINDOW_HOURS * 3_600_000;
  const out = new Set<number>();
  for (const g of all) if ((Date.parse(g.last_seen_at) || 0) >= floor) out.add(g.user_id);
  return out;
}

/** Dimension evidence comes from LOGIN events only. The ledger is append-only, so the max only grows. */
export function rollupEvidence(dim: Map<number, DimRow>, ledger: Iterable<LoginEvent>, nowIso: string): number {
  const max = new Map<number, string>();
  for (const e of ledger) {
    const cur = max.get(e.user_id);
    if (!cur || e.activity_time > cur) max.set(e.user_id, e.activity_time);
  }
  let changed = 0;
  for (const [uid, t] of max) {
    const row = dim.get(uid);
    if (!row || row.last_login_observed === t) continue;
    dim.set(uid, { ...row, last_login_observed: t, evidence: "observed", updated_at: nowIso });
    changed++;
  }
  return changed;
}

/**
 * A walk that could not close leaves the span between the cursor and the head unverified, so
 * the known-continuous span now starts at THIS run. Rows this run created already sit at run
 * start and are untouched. The count is returned so the caller can be loud about it: one failed
 * walk moves every no-evidence user from "stale" to "unknown".
 */
export function moveFloor(dim: Map<number, DimRow>, runStartIso: string): number {
  let moved = 0;
  for (const [id, row] of dim) {
    if (row.backfill_floor < runStartIso) { dim.set(id, { ...row, backfill_floor: runStartIso, updated_at: runStartIso }); moved++; }
  }
  return moved;
}

/**
 * Identity rows for login-event userIds the API has never shown (deleted users). Identity comes
 * from the newest payload; the floor is run start. Ghosts come from LOGIN events only.
 */
export function ghostRows(dim: Map<number, DimRow>, logins: LoginEvent[], sweepIds: Set<number>, runStartIso: string): DimRow[] {
  const ids = [...new Set(logins.map((e) => e.user_id))].filter((id) => !dim.has(id) && !sweepIds.has(id));
  return ids.map((id) => {
    const newest = logins.filter((e) => e.user_id === id).sort((a, b) => b.activity_id - a.activity_id)[0];
    const nm = splitName(newest.app_user_name);
    return { user_id: id, uid: null, first_name: nm.first, last_name: nm.last, email: newest.app_user_email, enabled: null, invitation_status: null,
      organization_id: null, mfa_configured: null, identity_source: "event_payload", first_seen_at: runStartIso, last_seen_in_api_at: null,
      deleted_observed_at: null, api_missing_streak: 0, last_login_observed: null, backfill_floor: runStartIso, evidence: "no_evidence_below_floor", updated_at: runStartIso };
  });
}

/**
 * THE cohort rule, defined once. Precedence makes the partition mutually exclusive:
 * deleted > disabled > expired/pending > observed > stale_180 > stale_90 > unknown.
 * "deleted" includes payload-only rows the API never showed. stale_90 and stale_180 are bands,
 * not nested: the 180-day test runs first, so stale_90 only catches 90–179 days.
 * The thresholds are deliberately not configurable: they are the classification rule of an
 * access-review exhibit, and a threshold slidable from a knob makes historical tiles
 * unreproducible. Changing them is a reviewed change to this file.
 */
export function classify(row: DimRow, nowMs: number): Cohort {
  if (row.deleted_observed_at != null || (row.identity_source === "event_payload" && row.last_seen_in_api_at == null)) return "deleted";
  if (row.enabled === false) return "disabled";
  if (row.invitation_status === "EXPIRED" || row.invitation_status === "PENDING") return "expired_pending";
  const login = row.last_login_observed ? Date.parse(row.last_login_observed) : NaN;
  const floor = Date.parse(row.backfill_floor);
  const observed = row.evidence === "observed" && Number.isFinite(login);
  if (observed && login >= nowMs - 90 * DAY_MS) return "observed";
  if ((observed && login < nowMs - 180 * DAY_MS) || (!observed && floor <= nowMs - 180 * DAY_MS)) return "stale_180";
  if ((observed && login < nowMs - 90 * DAY_MS) || (!observed && floor <= nowMs - 90 * DAY_MS)) return "stale_90";
  return "unknown";
}
