// The back-walk: how to read an id-descending activity feed behind a cursor without losing the
// middle of a backlog, and how to know when you could NOT prove continuity.
//
// Facts about the feed this is built on (confirmed against the live API):
//   - It is id-descending, always. newerThan=<cursor> returns the NEWEST page above the cursor,
//     not the oldest. A full first page therefore means unfetched events remain between the
//     cursor and the page bottom. They are reached by walking olderThan DOWN until the cursor.
//     A naive "loop newerThan until a short page" silently drops the middle of any backlog
//     larger than one page.
//   - An empty page is NOT the end of the feed. The walk skips the cursor down by a fixed id
//     span and tries again, up to a limit; a skip that crosses the cursor leaves the remaining
//     span unscanned, which is not closure.
//   - Deep pages can drip-feed for hours, so the caller's fetch carries a hard wall-clock abort.
//     This module adds a wall-clock budget on the whole walk: 200 pages of 120 s deadlines is
//     hours, and a daily job gets minutes.
//
// Every backstop that stops the walk early sets closed=false. The caller treats "not closed" as
// a continuity break: the known-continuous span now starts at this run (see dormancy.ts).

export type PageQuery = { newerThan?: number; olderThan?: number };

export type WalkOptions = {
  pageSize: number;
  /** The ledger is older than the gap threshold; an empty head page must be probed, not trusted. */
  gapFill?: boolean;
  /** Report whether a walk is needed without performing it. */
  preview?: boolean;
  emptySkipIds?: number;
  maxConsecEmpty?: number;
  maxPages?: number;
  budgetMs?: number;
  now?: () => number;
};

export type WalkResult = {
  pages: number;
  backwalk: number;
  skips: number;
  closed: boolean;
  note: string | null;
  cursor_before: number | null;
  walk_needed: boolean;
};

export const WALK_DEFAULTS = {
  EMPTY_SKIP_IDS: 500_000,      // empty page != end-of-feed: skip the cursor down this far
  MAX_CONSEC_EMPTY: 25,         // ...but this many in a row = the walk cannot close
  MAX_WALK_PAGES: 200,          // runaway backstop; flagged, never silent
  WALK_BUDGET_MS: 10 * 60_000,  // wall-clock cap on the whole walk
};

/**
 * Read everything above `cursor` from an id-descending feed. `fetchPage` returns one page for a
 * query; `idOf` extracts the activity id; `take` receives each new activity exactly once, in the
 * order fetched (newest first). Returns what happened, including whether continuity was proven.
 */
export async function walkFeed<A>(
  fetchPage: (q: PageQuery) => Promise<A[]>,
  idOf: (a: A) => number,
  cursor: number | null,
  take: (a: A) => void,
  opts: WalkOptions,
): Promise<WalkResult> {
  const pageSize = opts.pageSize;
  const emptySkipIds = opts.emptySkipIds ?? WALK_DEFAULTS.EMPTY_SKIP_IDS;
  const maxConsecEmpty = opts.maxConsecEmpty ?? WALK_DEFAULTS.MAX_CONSEC_EMPTY;
  const maxPages = opts.maxPages ?? WALK_DEFAULTS.MAX_WALK_PAGES;
  const budgetMs = opts.budgetMs ?? WALK_DEFAULTS.WALK_BUDGET_MS;
  const now = opts.now ?? Date.now;

  const seen = new Set<number>();
  const accept = (a: A) => {
    const id = Number(idOf(a));
    if (!id || (cursor != null && id <= cursor) || seen.has(id)) return;
    seen.add(id);
    take(a);
  };

  let pages = 0, backwalk = 0, skips = 0, closed = true;
  let note: string | null = null;

  let headActs = await fetchPage(cursor != null ? { newerThan: cursor } : {});
  pages++;
  for (const a of headActs) accept(a);
  let headFull = headActs.length >= pageSize;

  // Gap-fill with an EMPTY head page: never seed the walk from Math.min() of nothing (Infinity
  // becomes "olderThan=Infinity", which the live API rejects). Probe the un-cursored head: if
  // nothing sits above the cursor, the feed is merely quiet, not broken.
  if (opts.gapFill && cursor != null && !headActs.length) {
    const probe = await fetchPage({});
    pages++;
    const above = probe.filter((a) => Number(idOf(a)) > cursor);
    if (above.length) {
      for (const a of above) accept(a);
      headActs = above;
      headFull = true; // the span between cursor and here is unverified: walk it
    } else {
      note = "gap-fill: no events above the cursor in the visible window — quiet feed, nothing to walk";
    }
  }

  const walkNeeded = cursor != null && headActs.length > 0 && (headFull || !!opts.gapFill);
  if (walkNeeded && opts.preview) {
    note = "preview: back-walk needed — not walked in preview";
    closed = false;
  } else if (walkNeeded) {
    const walkStart = now();
    let walkCur = Math.min(...headActs.map((a) => Number(idOf(a))));
    let consecEmpty = 0;
    while (walkCur > cursor!) {
      if (now() - walkStart > budgetMs) { closed = false; note = `walk wall-clock budget (${budgetMs / 60_000}m) exceeded`; break; }
      if (backwalk >= maxPages) { closed = false; note = `back-walk hit ${maxPages}-page backstop`; break; }
      const acts = await fetchPage({ olderThan: walkCur });
      backwalk++;
      if (!acts.length) {
        // Empty page != end-of-feed. Skip down and retry.
        skips++; consecEmpty++;
        if (consecEmpty >= maxConsecEmpty) { closed = false; note = `${maxConsecEmpty} consecutive empty pages — gap not closed`; break; }
        walkCur -= emptySkipIds;
        if (walkCur <= cursor!) {
          // A skip crossing the cursor leaves the remaining span UNSCANNED: not closure.
          closed = false;
          note = "empty-page skip crossed the cursor — remaining span unscanned";
          break;
        }
        continue;
      }
      consecEmpty = 0;
      for (const a of acts) accept(a);
      walkCur = Math.min(...acts.map((a) => Number(idOf(a))));
      if (acts.length < pageSize) break; // short page: the filtered feed is exhausted below
    }
  }
  return { pages, backwalk, skips, closed, note, cursor_before: cursor, walk_needed: walkNeeded };
}
