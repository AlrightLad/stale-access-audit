// The join between two systems that share no identifier by nature: an RMM and a PSA each hold
// their own integer ids for "a client" and "a site", and their names drift independently.
// The key that works is one the ORGANIZATION mints at onboarding and writes into a custom field
// on both sides: an org GUID and a site GUID. It is rename-proof, survives re-creation on either
// side, resolves at site level, and fails loudly (a missing GUID shows up as "unmatched", never
// as a wrong join).
//
// STRICT ALLOWLIST. Custom-field dictionaries on RMM entities routinely carry secrets alongside
// the GUIDs (local admin credentials, backup repository keys). This module reads exactly the two
// configured field names out of that dictionary and nothing else, and the caller stores only
// what it returns.

export type RmmOrg = { org_id: number; name: string; org_guid: string | null };
export type RmmLocation = { org_id: number; location_id: number; name: string; site_guid: string | null };
export type PsaClient = { client_id: string; name: string; client_guid: string | null };
export type PsaSite = { client_id: string; site_id: string; name: string; site_guid: string | null };

/** Read ONE named field out of a custom-fields dictionary. Anything else in the dictionary is never touched. */
export function pickGuid(customFields: unknown, field: string): string | null {
  if (!field || !customFields || typeof customFields !== "object") return null;
  const v = (customFields as Record<string, unknown>)[field];
  const s = String(v ?? "").trim();
  return s ? s : null;
}

export const normGuid = (g: string | null | undefined): string | null => {
  const s = String(g ?? "").trim().toLowerCase().replace(/^\{|\}$/g, "");
  return s ? s : null;
};

export type Matched<L, R> = { guid: string; left: L; right: R };
export type JoinResult<L, R> = {
  matched: Matched<L, R>[];
  /** Left rows with no counterpart: a missing GUID, or a GUID the right side never carries. */
  unmatched_left: { row: L; reason: "no_guid" | "no_counterpart" | "ambiguous" }[];
  unmatched_right: { row: R; reason: "no_guid" | "no_counterpart" | "ambiguous" }[];
};

/**
 * Exact single match on a normalised GUID. A GUID carried by more than one row on EITHER side is
 * ambiguous and every row carrying it is excluded with that reason: the join never guesses.
 */
export function joinByGuid<L, R>(left: L[], leftGuid: (l: L) => string | null, right: R[], rightGuid: (r: R) => string | null): JoinResult<L, R> {
  const lBy = new Map<string, L[]>(), rBy = new Map<string, R[]>();
  const out: JoinResult<L, R> = { matched: [], unmatched_left: [], unmatched_right: [] };
  for (const l of left) { const g = normGuid(leftGuid(l)); if (!g) out.unmatched_left.push({ row: l, reason: "no_guid" }); else lBy.set(g, [...(lBy.get(g) ?? []), l]); }
  for (const r of right) { const g = normGuid(rightGuid(r)); if (!g) out.unmatched_right.push({ row: r, reason: "no_guid" }); else rBy.set(g, [...(rBy.get(g) ?? []), r]); }
  for (const [g, ls] of lBy) {
    const rs = rBy.get(g) ?? [];
    if (ls.length === 1 && rs.length === 1) { out.matched.push({ guid: g, left: ls[0], right: rs[0] }); continue; }
    if (!rs.length) { for (const l of ls) out.unmatched_left.push({ row: l, reason: ls.length > 1 ? "ambiguous" : "no_counterpart" }); continue; }
    for (const l of ls) out.unmatched_left.push({ row: l, reason: "ambiguous" });
    for (const r of rs) out.unmatched_right.push({ row: r, reason: "ambiguous" });
  }
  for (const [g, rs] of rBy) if (!lBy.has(g)) for (const r of rs) out.unmatched_right.push({ row: r, reason: rs.length > 1 ? "ambiguous" : "no_counterpart" });
  return out;
}

export const joinOrgs = (rmm: RmmOrg[], psa: PsaClient[]) => joinByGuid(rmm, (o) => o.org_guid, psa, (c) => c.client_guid);
export const joinSites = (rmm: RmmLocation[], psa: PsaSite[]) => joinByGuid(rmm, (l) => l.site_guid, psa, (s) => s.site_guid);
