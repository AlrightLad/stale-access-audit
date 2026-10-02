# Security policy

This repository publishes a collector and a reconciliation report that read privileged-account
data out of an RMM and a PSA. It never writes to either system, but what it stores (identity
rows, login ledger, device grants, organisation GUIDs) is sensitive on its own, and the
credentials it is configured with are read-scoped API credentials to a management platform.
Treat a vulnerability here the way you would treat one in a monitoring agent.

## Supported versions

Only the current `main` branch is supported. There are no release branches; a fix lands on
`main` and the commit is the fix. Pin to a commit SHA if you need reproducibility and watch
the repository for security-labelled commits.

| Version | Supported |
|---|---|
| `main` (latest commit) | yes |
| any earlier commit | no, update to `main` |

## Reporting a vulnerability

Please report privately. Do not open a public issue for anything that could expose a tenant's
data or credentials.

- Email: **zboogher@gmail.com**, subject line starting with `[stale-access-audit security]`.
- Or use GitHub's private vulnerability reporting on this repository if it is enabled
  (Security tab → Report a vulnerability).

Include what you found, how to reproduce it, the commit SHA you tested, and whether you
believe it is already being exploited. Encrypt if you prefer; say so and a key will be
exchanged.

**Response time.** You will get an acknowledgement within 3 business days and an assessment
with a planned fix or an explanation within 14 days. If a fix is needed it ships on `main`
with a commit message that names the issue class (not your report verbatim unless you want
credit); you will be told when it lands.

## What counts

In scope: anything that lets this tool write to the RMM or PSA, read more than the documented
fields (the custom-field allowlist in `join.ts` exists because those dictionaries carry
secrets), leak the state file or credentials, misclassify a user in a way that hides dormant
or orphaned access, or be made to match accounts across tenants.

Out of scope: vulnerabilities in the RMM or PSA vendors' own products (report those to the
vendor), and findings that require an already-compromised host running the collector.

## This is a sanitized reference

The code here was extracted from a production system and re-implemented to run outside its
original platform. It has been sanitized: every tenant identifier, hostname, field name and
credential was removed or made configuration. It is published so the pattern can be read and
reused, not as a drop-in product.

**Operators are responsible for reviewing it before any deployment** against a fleet or a
tenant, including the API scopes granted to it, where the state file lands and who can read
it, and the reconciliation thresholds. Nothing here has been assessed against your
environment, and the maintainer has no visibility into it.
