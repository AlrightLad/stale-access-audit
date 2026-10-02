# stale-access-audit

Find dormant accounts that still hold privileged access, across two systems that do not share an
identifier. The RMM knows who can reach which devices and when they last signed in. The PSA knows
which clients and sites exist and which people are supposed to have access. This tool joins the
two on a key the organisation owns, classifies every RMM account by **evidence** of use, and
reports what does not line up.

Extracted from a production collector that ran inside a Windmill workspace against a Postgres
store. This version runs anywhere Node runs, keeps its state in a JSON file, and takes its
configuration from the environment. The mechanism is the same; the plumbing is not.

## The join: why vendor-native ids are the wrong key

Every system assigns its own integer id to "a client" and "a site". Those ids mean nothing to
each other, and the obvious fallback, matching on names, rots silently: a client is renamed on
one side, "Inc." becomes "Inc", a site moves and gets a new record, a client is deleted and
re-created with a new id. A name-mapping table looks fine the day it is written and is wrong a
quarter later, and nothing tells you.

The key that works is one the **organisation** mints at onboarding and writes into a custom
field on **both** sides: a client GUID on the RMM organisation and the PSA client, and a site
GUID on the RMM location and the PSA site. That pair is

- **rename-proof**: nothing either vendor lets a user edit through the UI changes it;
- **re-creation-proof**: a re-created record gets the same GUID written at onboarding;
- **site-resolving**: a client with many sites reconciles per site, not per client;
- **loud when missing**: an entity without its GUID surfaces as *unmatched*, which is an
  onboarding defect to fix, never a wrong join to discover later.

`join.ts` implements exact single match on the normalised GUID. A GUID carried by two records on
either side is **ambiguous**, and every record carrying it is excluded with that reason. Nothing
is guessed. Email matching between the two systems then happens only *inside* a joined client,
so two people with the same address at two clients can never be confused.

**Strict allowlist.** Custom-field dictionaries on RMM entities routinely carry secrets next to
the GUIDs: local admin credentials, backup repository keys. This tool reads exactly the two
configured field names out of that dictionary (`pickGuid`) and stores nothing else from it. The
poll test asserts that a decoy field in the dictionary never reaches the state file.

## Dormancy: evidence, not absence

A user with no login on record is not "stale". Either their last login was **observed**, or
nothing was observed **below a floor**, and those are different findings.

| Column | Meaning |
|---|---|
| `last_login_observed` | newest login event in the ledger for this user; the ledger is append-only, so it only grows |
| `backfill_floor` | the start of the span of the login feed that was read **contiguously**; a property of the sweep, not of the user, set when the row is created |
| `evidence` | `observed` or `no_evidence_below_floor` |

The cohort rule is defined once (`classify`) with a precedence that makes the partition mutually
exclusive: `deleted` > `disabled` > `expired_pending` > `observed` (login within 90 days) >
`stale_180` > `stale_90` (90–179 days, a band, not nested) > `unknown`. With no evidence, the
floor decides: a floor older than 180 days with no login seen is `stale_180`; a floor set last
week is `unknown`. The 90/180 thresholds are deliberately not configurable: they are the
classification rule of an access-review exhibit, and a threshold slidable from a knob makes
historical results unreproducible.

**Deletion is three strikes on complete sweeps only.** A user absent from three consecutive
*complete* users sweeps is marked deleted; a truncated response (a sweep that collapsed below
90% of the last complete one) bumps no streak, because that is how people get falsely marked
deleted in an audit trail. A reappearance clears the mark.

**Access is a current grant.** User-to-device grants are watermark-upserted from the users
sweep and never deleted; a grant counts as current when it was refreshed within 48 hours of the
newest grant on record, so a user whose grants stop being refreshed ages out rather than being
removed.

## Reading the feed without losing the middle

The RMM's activity feed is id-descending, always. `newerThan=<cursor>` returns the **newest**
page above the cursor, not the oldest, so a full first page means unfetched events remain
between the cursor and the bottom of the page. `cursor.ts` walks `olderThan` down to the cursor
to reach them. A naive "loop `newerThan` until a short page" silently drops the middle of any
backlog larger than one page.

Other facts the walker is built on, each confirmed against the live API before it was coded:

- the users endpoint ignores `pageSize` and `after`: one request is the sweep;
- an empty activity page is **not** the end of the feed, so the walk skips the cursor down by a
  fixed span and tries again, up to a limit;
- deep pages can drip-feed for hours, so every request carries a hard 120-second wall-clock
  abort, and the whole walk has a wall-clock budget.

The cursor is `max(activity_id)` of the ledger itself. An event ingested *is* the cursor
advanced; there is no separately stored value to drift.

Every backstop that stops the walk early (page limit, budget, too many empty pages, a skip that
crosses the cursor) returns `closed: false`. The collector treats that as a continuity break:
**the known-continuous span now starts at this run, so every older floor moves forward** and the
affected no-evidence users fall back to `unknown`. The run reports `ok: false` and how many rows
moved, because one failed walk turning "Stale 180" into "Unknown" must be loud.

## What the report says

For every client the GUID pair joins:

| Finding | Meaning |
|---|---|
| `dormant_access` | cohort `stale_90` or `stale_180` and a current grant |
| `unknown_access` | a current grant, but the evidence floor is too recent to judge |
| `orphaned_access` | a current grant, and the PSA has no account for that email at this client |
| `inactive_in_psa` | a current grant, and the PSA account for that email is inactive |
| `psa_only` | an active, privileged PSA account with no RMM user at this client |

plus per-client cohort counts, the sites each finding touches (from the user's grants through the
device inventory, named by the joined PSA site), and every unmatched organisation and site with
its reason. Unmatched entities are for a human to rule on; nothing is matched across them.

## Running it

```bash
cp .env.example .env     # fill in; never commit .env
npm ci
npm test

node src/cli.ts poll --preview     # sweep and report what WOULD be written, walk not performed
node src/cli.ts poll               # collect; exit code 2 when the walk did not close
node src/cli.ts report --md        # reconcile the store against the PSA directory
```

Requires Node 22.18 or later. TypeScript runs directly through Node's type stripping; there is
no build step. The PSA side is a `PsaDirectory` interface with a JSON-file implementation
(`src/psa/directory.ts` documents the shape); a live PSA adapter implements the same three
methods.

## What was extracted, what was removed, what is new

**Extracted** from the production collector, logic intact: the users sweep and its completeness
guard, the login stream walker with every backstop, the evidence model and floor movement, the
cohort rule, ghost identity rows for users seen only through event payloads, the GUID pair sweep
with its allowlist, the bearer cache, the per-request wall-clock abort with one retry.

**Removed entirely**: login geolocation and everything that served it (database blob, refresh
job, boundary loader, map data, coordinate backfill), the office-IP classifier, the device
identity snapshot, the daily snapshot and every revenue, billing and seat figure, the monthly
report generator and its templates, regulatory tiering, flag dispositions, the five non-login
event streams, the Postgres schema and migration, the Windmill app, and all workspace, resource
and documentation files.

**New, so it runs outside Windmill**: environment configuration, the JSON state store, the PSA
directory interface and its file adapter, the reconciliation report, the CLI, and this README.

## License

[MIT](LICENSE)
