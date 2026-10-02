import { test } from "node:test";
import assert from "node:assert/strict";
import { walkFeed } from "../src/cursor.ts";

type A = { id: number };
const ids = (from: number, to: number): A[] => { const out: A[] = []; for (let i = from; i >= to; i--) out.push({ id: i }); return out; };

/** An id-descending feed over `all`, served the way the real API serves it, with optional empty spans. */
function feed(all: A[], pageSize: number, empties: Set<number> = new Set()) {
  const calls: Record<string, number>[] = [];
  const fetchPage = async (q: { newerThan?: number; olderThan?: number }): Promise<A[]> => {
    calls.push(q as any);
    let rows = all;
    if (q.newerThan != null) rows = rows.filter((a) => a.id > q.newerThan!);
    if (q.olderThan != null) { if (empties.has(q.olderThan)) return []; rows = rows.filter((a) => a.id < q.olderThan!); }
    return rows.slice(0, pageSize);  // newest first
  };
  return { fetchPage, calls };
}

const run = (f: ReturnType<typeof feed>, cursor: number | null, opts: Partial<Parameters<typeof walkFeed>[4]> = {}) => {
  const got: number[] = [];
  return walkFeed<A>(f.fetchPage, (a) => a.id, cursor, (a) => got.push(a.id), { pageSize: 10, ...opts }).then((r) => ({ r, got }));
};

test("first run (no cursor): one head page, no walk, closed", async () => {
  const f = feed(ids(100, 1), 10);
  const { r, got } = await run(f, null);
  assert.equal(r.pages, 1); assert.equal(r.backwalk, 0); assert.equal(r.closed, true); assert.equal(r.walk_needed, false);
  assert.deepEqual(got, [100, 99, 98, 97, 96, 95, 94, 93, 92, 91]);
});

test("a short head page above the cursor is the whole backlog: no walk", async () => {
  const f = feed(ids(100, 1), 10);
  const { r, got } = await run(f, 95);
  assert.equal(r.walk_needed, false); assert.equal(r.closed, true);
  assert.deepEqual(got, [100, 99, 98, 97, 96]);
});

test("a FULL head page means the middle is unfetched: walk olderThan down to the cursor and get every id exactly once", async () => {
  const f = feed(ids(100, 1), 10);
  const { r, got } = await run(f, 60);
  assert.equal(r.walk_needed, true); assert.equal(r.closed, true);
  assert.equal(r.backwalk, 4);                                // 90.., 80.., 70.., then the short page ending at 61
  assert.deepEqual([...got].sort((a, b) => a - b), ids(100, 61).map((a) => a.id).sort((a, b) => a - b));
  assert.equal(new Set(got).size, got.length, "no duplicates");
  assert.ok(!got.includes(60), "the cursor itself is never re-ingested");
});

test("an empty page is not the end: skip down by the span and keep walking", async () => {
  const f = feed(ids(100, 1), 10, new Set([91]));            // olderThan=91 returns nothing once
  const { r, got } = await run(f, 60, { emptySkipIds: 5 });
  assert.equal(r.skips, 1); assert.equal(r.closed, true);
  assert.ok(got.includes(85) && got.includes(61));
});

test("too many consecutive empty pages: not closed, says so", async () => {
  const f = { fetchPage: async (q: any) => (q.olderThan != null ? [] : ids(100, 91)), calls: [] };
  const { r } = await run(f as any, 10, { emptySkipIds: 1, maxConsecEmpty: 3 });
  assert.equal(r.closed, false); assert.match(r.note ?? "", /3 consecutive empty pages/);
});

test("an empty-page skip that crosses the cursor leaves the span unscanned: not closed", async () => {
  const f = { fetchPage: async (q: any) => (q.olderThan != null ? [] : ids(100, 91)), calls: [] };
  const { r } = await run(f as any, 85, { emptySkipIds: 500_000 });
  assert.equal(r.closed, false); assert.match(r.note ?? "", /crossed the cursor/);
});

test("the page backstop and the wall-clock budget both stop the walk as not closed", async () => {
  const f = feed(ids(1000, 1), 10);
  const { r: pages } = await run(f, 1, { maxPages: 3 });
  assert.equal(pages.closed, false); assert.match(pages.note ?? "", /3-page backstop/);
  let t = 0;
  const { r: budget } = await run(feed(ids(1000, 1), 10), 1, { budgetMs: 50, now: () => (t += 30) });
  assert.equal(budget.closed, false); assert.match(budget.note ?? "", /budget/);
});

test("gap-fill with an EMPTY head: probe the un-cursored head; nothing above the cursor is a quiet feed, not a break", async () => {
  const f = feed(ids(50, 1), 10);
  const { r } = await run(f, 50, { gapFill: true });
  assert.equal(r.pages, 2); assert.equal(r.closed, true); assert.match(r.note ?? "", /quiet feed/);
});

test("gap-fill with events above the cursor walks the unverified span even when the head was short", async () => {
  const f = feed(ids(100, 1), 10);
  const { r, got } = await run(f, 97, { gapFill: true });
  assert.equal(r.walk_needed, true); assert.equal(r.closed, true);
  assert.deepEqual([...got].sort((a, b) => a - b), [98, 99, 100]);
});

test("preview reports that a walk is needed and does not perform it", async () => {
  const f = feed(ids(100, 1), 10);
  const { r } = await run(f, 60, { preview: true });
  assert.equal(r.closed, false); assert.equal(r.backwalk, 0); assert.match(r.note ?? "", /preview/);
});
