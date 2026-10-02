import { test } from "node:test";
import assert from "node:assert/strict";
import { clean, epochSecondsToIso, num, splitName } from "../src/sanitize.ts";

test("clean strips C0, DEL and C1 controls and keeps everything else", () => {
  assert.equal(clean("a\u0000b\u001fc\u007fd\u0080e\u009ff"), "abcdef");
  assert.equal(clean("héllo – wörld"), "héllo – wörld");
  assert.equal(clean(null), "");
  assert.equal(clean(42), "42");
});

test("splitName: last token is the surname, the rest is the given name; lossy by design", () => {
  assert.deepEqual(splitName("Ada   Lovelace "), { first: "Ada", last: "Lovelace" });
  assert.deepEqual(splitName("Jean Luc Picard"), { first: "Jean Luc", last: "Picard" });
  assert.deepEqual(splitName("Cher"), { first: "Cher", last: null });
  assert.deepEqual(splitName("   "), { first: null, last: null });
});

test("epochSecondsToIso and num are strict about shape", () => {
  assert.equal(epochSecondsToIso(1_700_000_000.5), "2023-11-14T22:13:20.500Z");
  assert.equal(epochSecondsToIso("x"), null);
  assert.equal(epochSecondsToIso(0), null);
  assert.equal(num("123"), 123);
  assert.equal(num(123), 123);
  assert.equal(num("12a"), null);
  assert.equal(num(null), null);
});
