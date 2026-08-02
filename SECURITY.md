# Security policy

## Reporting a vulnerability

Report privately through **GitHub Security Advisories** on this repository:
[Security → Report a vulnerability](https://github.com/phoenixgh-org/cce-data-delivery-validator/security/advisories/new).
That is the only supported disclosure channel — please do not open a public issue
for a security report.

We will acknowledge the report and tell you whether we consider it in scope. Give
us a chance to ship a fix before disclosing publicly.

## What this service holds

This is a **sandbox for synthetic test data**. It receives no real CCE data and no
PII by design (`DESIGN.md` §2, §12), and the README carries the same warning to
suppliers. A session and everything posted to it are **purged after 7 days without
a POST** (`DESIGN.md` §11). Please respect that boundary in your testing too: do
not use real facility, device, or personal data to demonstrate a finding.

## Known and accepted risks

`DESIGN.md` §12 enumerates the posture we already accept, so a report that
restates one of these is not new — though a way to *exploit* one beyond what is
described there is:

- The endpoint UUID is a **bearer capability in the URL path**. Anyone holding it
  can post to the session and delete it, and URLs leak through logs, proxies, and
  browser history. Acceptable because the only data in scope is synthetic.
- Optional §1.3 auth secrets are stored hashed and shown once, never echoed again.
- Request bodies are bounded (Fastify `bodyLimit` 2 MiB, gzip output capped at
  1 MiB as a zip-bomb guard).

Anything outside that list — or any way to reach data across sessions, escalate
past the capability URL, or take the service down cheaply — is worth reporting.
