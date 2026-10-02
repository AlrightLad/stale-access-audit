// String hygiene for values that arrive from a vendor API and end up in a store that may not
// accept every byte. Pure and testable.

/** Strip C0 controls, DEL and C1 controls from any value, coerced to a string. */
export function clean(v: unknown): string {
  let out = "";
  for (const ch of String(v ?? "")) {
    const c = ch.charCodeAt(0);
    if (c <= 31 || c === 127 || (c >= 128 && c <= 159)) continue; // C0 + DEL + C1 controls
    out += ch;
  }
  return out;
}

/**
 * "Ada   Lovelace " -> { first: "Ada", last: "Lovelace" }. Lossy, and used only for identity rows
 * the API never showed (users already deleted when first seen through an event payload); the
 * ledger keeps the raw payload name verbatim.
 */
export function splitName(v: unknown): { first: string | null; last: string | null } {
  const parts = clean(v).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

/** Vendor epoch (float seconds) -> ISO string, or null when absent or not a positive number. */
export function epochSecondsToIso(v: unknown): string | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(Math.round(n * 1000)).toISOString();
}

/** A positive integer from a string or number, else null. Vendor payloads carry ids as either. */
export const num = (v: unknown): number | null => (v != null && /^\d+$/.test(String(v)) ? Number(v) : null);
