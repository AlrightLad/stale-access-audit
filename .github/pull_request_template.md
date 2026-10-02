## What this changes

<!-- One paragraph. If it changes the cohort rule, the join, or what the collector stores, say so explicitly. -->

## Gate

- [ ] `npm run typecheck` is clean
- [ ] `npm test` passes, and a behaviour change comes with a test that would have failed before it
- [ ] The tool still writes to neither the RMM nor the PSA, and still reads only the two configured GUID custom fields
- [ ] No tenant identifier, credential, hostname, field name or personal data in code, tests, fixtures or docs (test data uses `example.com` and the RFC 5737 ranges)
- [ ] README updated where behaviour or configuration changed
- [ ] Every commit is signed and shows "Good signature"

## How it was verified

<!-- Commands run and their output, or the test names that cover it. -->
