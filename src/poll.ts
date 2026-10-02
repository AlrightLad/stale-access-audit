// One collector run: sweep the users, read the login feed behind its cursor, collect the GUID
// pair, and maintain the evidence model. preview=true does everything read-only and reports what
// WOULD happen (it also skips the deep back-walk and says that one would run).
import { type PageQuery, type WalkResult, walkFeed } from "./cursor.ts";
import { type DimRow, type Grant, type LoginEvent, GAP_HOURS, applyGrants, applySweep, ghostRows, moveFloor, rollupEvidence, sweepIsComplete } from "./dormancy.ts";
import { type RmmLocation, type RmmOrg, pickGuid } from "./join.ts";
import { type RmmSource, ingestLogin } from "./rmm/ninjaone.ts";
import type { State } from "./store/json.ts";
import type { DeviceSite } from "./reconcile.ts";

export type PollOptions = {
  preview?: boolean;
  pageSize?: number;
  now?: () => number;
  orgGuidField: string;
  siteGuidField: string;
  walk?: { emptySkipIds?: number; maxConsecEmpty?: number; maxPages?: number; budgetMs?: number };
};

export type PollSummary = {
  ok: boolean;
  preview: boolean;
  users_swept: number;
  sweep_complete: boolean;
  prior_sweep_count: number | null;
  would_resurrect: number;
  missing_from_sweep: number;
  device_access_pairs: number;
  cursor_before: number | null;
  ledger_age_hours: number | null;
  gap_fill_triggered: boolean;
  walk: WalkResult | null;
  login_events_new: number;
  ghost_rows: number;
  org_guids: number;
  org_guids_populated: number;
  location_guids: number;
  location_guids_populated: number;
  guid_note: string | null;
  devices: number;
  written: boolean;
  reason?: string;
  streak_bumped: number;
  deleted_marked: number;
  floor_moved_rows: number;
  note?: string;
  duration_ms: number;
};

export async function runPoll(rmm: RmmSource, state: State, opts: PollOptions): Promise<{ state: State; summary: PollSummary }> {
  const now = opts.now ?? Date.now;
  const started = now();
  const runStartIso = new Date(started).toISOString();
  const pageSize = opts.pageSize ?? 500;
  const preview = !!opts.preview;

  // 1. users sweep: one request, no pagination to terminate
  const users = await rmm.sweepUsers();
  const sweepIds = new Set(users.map((u) => Number(u.id)).filter(Boolean));
  const priorCount = state.poll_state.last_complete_sweep?.count ?? null;
  const sweepComplete = sweepIsComplete(sweepIds.size, priorCount);
  const dim = new Map<number, DimRow>(state.dim.map((r) => [r.user_id, r]));
  const wouldResurrect = [...dim.values()].filter((r) => r.deleted_observed_at && sweepIds.has(r.user_id)).length;
  const missingNow = [...dim.values()].filter((r) => r.last_seen_in_api_at && !sweepIds.has(r.user_id)).length;

  // 2. the login stream behind its ledger-derived cursor. The cursor IS max(activity_id): an
  //    event ingested is the cursor advanced; nothing is stored separately to drift.
  let cursor: number | null = null, maxT: string | null = null;
  for (const e of state.ledger) { if (cursor == null || e.activity_id > cursor) cursor = e.activity_id; if (maxT == null || e.activity_time > maxT) maxT = e.activity_time; }
  const ledgerAgeH = maxT ? (started - Date.parse(maxT)) / 3_600_000 : null;
  const gapFill = cursor != null && ledgerAgeH != null && ledgerAgeH > GAP_HOURS;
  const newLogins = new Map<number, LoginEvent>();
  const walk = await walkFeed<any>((q: PageQuery) => rmm.fetchLoginPage(q, pageSize), (a) => Number(a?.id), cursor,
    (a) => { const e = ingestLogin(a); if (e) newLogins.set(e.activity_id, e); },
    { pageSize, gapFill, preview, now, ...(opts.walk ?? {}) });

  // 3. the GUID pair, read under a strict allowlist: only the two configured field names leave the
  //    custom-fields dictionary. A failed call skips that entity and the prior stored value stands.
  const orgRows: RmmOrg[] = [], locRows: RmmLocation[] = [];
  let devices: DeviceSite[] = [];
  let guidNote: string | null = null;
  if (preview) guidNote = "preview: org/location GUID sweep and device inventory not fetched";
  else {
    try {
      for (const o of await rmm.orgs()) {
        try { orgRows.push({ org_id: o.id, name: o.name, org_guid: pickGuid(await rmm.orgCustomFields(o.id), opts.orgGuidField) }); }
        catch { /* skip this org: keep the prior stored GUID */ }
      }
      for (const l of await rmm.locations()) {
        try { locRows.push({ org_id: l.organizationId, location_id: l.id, name: l.name, site_guid: pickGuid(await rmm.locationCustomFields(l.organizationId, l.id), opts.siteGuidField) }); }
        catch { /* skip this location: keep the prior stored GUID */ }
      }
      devices = (await rmm.devices()).map((d) => ({ device_id: d.id, org_id: d.organizationId, location_id: d.locationId }));
    } catch (e: any) { guidNote = `org/location GUID sweep failed: ${String(e?.message ?? e).slice(0, 160)}`; }
  }

  const ghosts = ghostRows(dim, [...newLogins.values()], sweepIds, runStartIso);
  const base = {
    preview, users_swept: sweepIds.size, sweep_complete: sweepComplete, prior_sweep_count: priorCount,
    would_resurrect: wouldResurrect, missing_from_sweep: missingNow,
    device_access_pairs: users.reduce((n, u) => n + (Array.isArray(u.deviceIds) ? u.deviceIds.length : 0), 0),
    cursor_before: cursor, ledger_age_hours: ledgerAgeH != null ? +ledgerAgeH.toFixed(1) : null, gap_fill_triggered: gapFill,
    walk, login_events_new: newLogins.size, ghost_rows: ghosts.length,
    org_guids: orgRows.length, org_guids_populated: orgRows.filter((r) => r.org_guid).length,
    location_guids: locRows.length, location_guids_populated: locRows.filter((r) => r.site_guid).length, guid_note: guidNote,
    devices: devices.length, streak_bumped: 0, deleted_marked: 0, floor_moved_rows: 0,
  };
  if (preview) return { state, summary: { ...base, ok: true, written: false, reason: "preview — nothing written", duration_ms: now() - started } };
  if (!users.length) return { state, summary: { ...base, ok: false, written: false, reason: "users sweep returned zero rows; skipped write", duration_ms: now() - started } };

  // ---- writes ----
  const sw = applySweep(dim, users, runStartIso, sweepComplete);
  const grants = new Map<string, Grant>(state.grants.map((g) => [`${g.user_id}:${g.device_id}`, g]));
  applyGrants(grants, users, runStartIso);
  for (const g of ghosts) if (!dim.has(g.user_id)) dim.set(g.user_id, g);   // dim row precedes its ledger events
  const known = new Set(state.ledger.map((e) => e.activity_id));
  const ledger = [...state.ledger];
  for (const e of newLogins.values()) if (!known.has(e.activity_id)) { ledger.push(e); known.add(e.activity_id); }
  rollupEvidence(dim, ledger, runStartIso);
  const floorMoved = walk.closed ? 0 : moveFloor(dim, runStartIso);
  const orgs = mergeBy(state.orgs, orgRows, (o) => String(o.org_id));
  const locations = mergeBy(state.locations, locRows, (l) => `${l.org_id}:${l.location_id}`);
  const devs = devices.length ? devices : state.devices;

  const poll_state = { ...state.poll_state,
    last_run: { at: runStartIso, users_swept: sweepIds.size, sweep_complete: sweepComplete, login_events_new: newLogins.size,
      walk_closed: walk.closed, walk_note: walk.note, floor_moved: !walk.closed, floor_moved_rows: floorMoved, floor_moved_to: walk.closed ? null : runStartIso },
    ...(sweepComplete ? { last_complete_sweep: { count: sweepIds.size, at: runStartIso } } : {}) };
  const next: State = { ...state, dim: [...dim.values()], ledger, grants: [...grants.values()], devices: devs, orgs, locations, poll_state };
  return { state: next, summary: { ...base, ok: walk.closed, written: true, streak_bumped: sw.streak_bumped, deleted_marked: sw.deleted_marked, floor_moved_rows: floorMoved,
    note: walk.closed ? undefined : `back-walk did not close (${walk.note}); backfill_floor moved to ${runStartIso} for ${floorMoved} rows`, duration_ms: now() - started } };
}

/** Upsert fetched rows over stored rows by key; rows not fetched this run keep their prior value. */
function mergeBy<T>(prev: T[], fetched: T[], key: (t: T) => string): T[] {
  const m = new Map(prev.map((t) => [key(t), t]));
  for (const t of fetched) m.set(key(t), t);
  return [...m.values()];
}
