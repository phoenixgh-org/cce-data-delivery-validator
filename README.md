# CCE Data Delivery Validator

An independent, receiving-side conformance check for **WHO/PQS E006/DS01, Clause 5
— Data Delivery to External Systems**.

Point a cold chain equipment (CCE) data supplier's transmission at a test endpoint
and get back an honest read on what conforms, what does not, and — just as
importantly — what a receiving system **cannot** determine at all.

> ### ⚠ Synthetic test data only
>
> This is a sandbox. Send synthetic or test payloads only. **Never** point a live
> CCE fleet at an endpoint here, and never send real facility, device, or personal
> data. The endpoint URL is a **bearer capability** — anyone holding it can read
> everything you send, and URLs leak through logs, proxies, and browser history.
> Receiving real production data is an explicit non-goal (`DESIGN.md` §2, §12).

## What this is

Clause 5 obliges CCE data suppliers — the manufacturers and resellers of RTMDs and
EMS-compliant equipment — to deliver performance data over HTTPS to the countries
that own the equipment. This project is a **public service that plays the
employer/country (receiving) side** of that interface, plus a web dashboard where a
supplier gets an independent read on their conformance, "to the extent possible"
from the receiving vantage point.

A supplier mints a test endpoint in one click (no signup, no account), POSTs real
transmissions from their own stack, and reads the findings — per transmission and
rolled up per requirement.

## Why it exists

PQS test labs prequalify the **equipment**. Nobody tests the **data delivery
implementation**. So today suppliers self-grade against a prose requirements
document and a JSON Schema, and the first party to discover a defect is usually the
country that is missing its data.

This gives them a second opinion before that happens — from something that behaves
like a receiver, because it is one.

## Who it is for

- **Supplier engineers** integrating Clause 5 delivery, who want a real endpoint to
  test against rather than a checklist.
- **Ministry and country technologists** evaluating what a receiving system can
  actually establish about a supplier's conformance.
- **PQS and standards stakeholders** interested in where the standard is
  mechanically checkable and where it is not.

## What we can and cannot prove

This is the part that makes the tool worth trusting. Every requirement is
classified by **what a passive receiver can establish**, and a requirement we cannot
grade is labelled as such rather than quietly counted as a pass:

| | Class | Meaning | Rows |
|---|---|---|---|
| ✅ | Passively verified | Graded from the supplier's own traffic | 7 |
| 🟡 | Heuristic / partial | Observable, but we cannot judge intent or justification | 3 |
| 🔌 | Active-only (deferred) | Needs deliberate error injection or a guided scenario; out of v1 scope | 8 |
| 📝 | Self-attestation | Not provable from the receiving side at all | 9 |
| 🔒 | Enforced by us | Guaranteed by the endpoint, so not a test of the supplier's choice | 1 |

27 requirements in total; two carry a split classification (§1.1 is ✅/🔒, §4.4 is
🔌/📝), and §1.7 has nothing to grade. A gradeable requirement with no findings yet
shows **untested**, never a false pass.

The full row-by-row matrix — every requirement, its class, and how it is checked —
is [`DESIGN.md` §7](DESIGN.md#7-compliance-engine--verifiability-matrix). It is
mirrored in `src/api/compliance-matrix.ts` and rendered live in the dashboard.

## Quick start

**There is no hosted instance.** Nothing is running at a public URL today, and
whether there ever will be is an open question — a supplier testing their own stack
mostly wants an endpoint they control, not a shared host. **Running it yourself is
the supported path**, and it is a one-liner:

```bash
docker compose up -d          # Postgres 16 + the app; the app serves :3000
```

Then create an endpoint, send a transmission, and read the report:

```bash
BASE=http://localhost:3000

# 1. Mint a test endpoint. The UUID is both the ingest path and the dashboard key.
curl -sX POST "$BASE/api/sessions"
# → {"uuid":"…","ingestUrl":"/i/…","dashboardUrl":"/d/…"}

# 2. POST a transmission to the ingest URL.
curl -sX POST "$BASE/i/<uuid>" \
  -H 'Content-Type: application/json; charset=utf-8' \
  -d '{
    "meta": {
      "schemaVersion": "0.8.1",
      "transferType": "rtm",
      "transferId": "T-001",
      "transferSrc": "com.example",
      "transferredAt": "2024-01-15T04:05:54Z"
    },
    "data": [
      {
        "AMID": "appliance-1",
        "CID": "US",
        "EDOP": "2021-06-01",
        "EMFR": "EMD_Name",
        "EMOD": "EMD-ModelNo",
        "EPQS": "E006/999",
        "ESER": "EMD-SerialNum",
        "EMSV": "v01.02.123",
        "DLST": { "TVC": { "SID": "sensor-1", "SMFR": "SensMfr", "SMOD": "SensMod" } },
        "records": [
          { "ABST": "20200115T040554Z", "ALRM": "HEAT", "BEMD": 14.3, "EERR": "none", "TVC": 3.2 }
        ]
      }
    ]
  }'

# 3. Open the dashboard: $BASE/d/<uuid>
```

The HTTP response is itself a teaching surface — a supplier should understand the
outcome without opening the dashboard (findings abridged here):

```json
{
  "transmissionId": "1aeb82e6-…",
  "status": 200,
  "message": "Accepted (200): data recorded; 9 findings (2 info).",
  "findings": 9,
  "findingDetails": [
    { "requirement": "3.2", "severity": "pass", "detail": "validated against official 0.8.1 (sha256 290290fd…) (§3.2)" }
  ],
  "notice": "Synthetic test data only: this is a sandbox endpoint. …"
}
```

A rejection has the same shape, so a 4xx is just as self-explanatory as a 2xx.

Useful things to know while testing:

- **`200` is the only success code.** Ingest is synchronous — findings are computed
  before the response is written — so there is no `202`/`201` path to handle.
- Gzip is supported — send `Content-Encoding: gzip` with the gzipped body. Do not
  double-encode (§1.6).
- The §1.4 grading cap is 1MB **of wire bytes, after content-encoding**. Going over
  earns a teaching `413` with the transmission still recorded.
- Authentication (§1.3) is **opt-in** and off by default. Enable it from the
  dashboard, which generates the credential for one of the three methods DS01.3
  recognises — token in a configurable header, HTTP Basic, or `Authorization:
  Bearer` (RFC 6750) — and then enforces it so §1.3 becomes gradeable.
- Transmissions are validated against the vendored, content-hash-pinned
  `cce-interop` schema. **0.8.1 is the only registered version** — sha256
  `290290fd…`, byte-identical to the copy published upstream — and any other
  declared `schemaVersion` gets a `422` listing what is supported, never a silent
  fallback. The schema is never fetched at runtime and the `$id` URL inside it is
  an *identifier*, not a download location: that host does not currently resolve,
  and the published artifact lives elsewhere. `DESIGN.md` §9 has the full version
  and publication picture.
- An endpoint and all its data are **purged after 7 days without a POST**. The clock
  resets on each POST and the expiry is shown in the dashboard.

## Self-hosting

`docker compose up -d` brings up Postgres and the app for local use — on defaults,
with no configuration. To change any of it, copy [`.env.example`](.env.example) to
`.env`: it annotates the whole variable surface and marks what **must** change
before a public deployment, starting with the `cce_validator` database credentials,
which are a published default and not a secret.

For a real deployment, TLS is terminated at a Caddy reverse proxy brought up behind
an optional compose profile:

```bash
docker compose --profile edge up -d
deploy/smoke-proxy-contract.sh https://your.host
```

**Read [`docs/deployment.md`](docs/deployment.md) before deploying.** The proxy
contract there is a correctness concern, not plumbing: an edge that caps, buffers,
or decompresses request bodies does not fail loudly — it silently changes the
evidence, and the service goes on issuing confident findings against the wrong
input. The smoke test exists to catch exactly that.

## Status and v1 scope

**Pre-release.** The service runs end to end — ingest pipeline, dashboard, semantic
checks, the §1.3 auth opt-in, and the retention worker have all landed. There is no
public instance, and self-hosting is the intended way to use it. Interfaces may
still change.

Source: <https://github.com/phoenixgh-org/cce-data-delivery-validator>.

Deliberately **out of scope for v1** (see `DESIGN.md` §2 and §3):

- **Passive validation only.** We grade what arrives; we do not probe.
- **No active conformance harness** — nothing deliberately returns 429/503/5xx to
  measure a supplier's retry count, backoff shape, or `Retry-After` handling. That
  is why §4.1–4.5 sit in the 🔌 column (§4.4 is dual-classed 🔌/📝). §4.6–4.9 are a
  different matter: they are supplier-internal and stay 📝 — no harness would make
  them provable from the receiving side.
- **No guided retransmission scenarios** for §5 (6-month retransmit, time-range
  filters, all-vs-never-sent).
- **No real production data**, ever, in this mode. Synthetic test payloads only.
- **7-day retention** after POST inactivity, then the endpoint and its data are gone.

## Further reading

| Where | What |
|---|---|
| [`DESIGN.md`](DESIGN.md) | Scope, locked decisions, the ingest pipeline and response codes, and the full §7 verifiability matrix. The authority on all of it. |
| [`docs/api.md`](docs/api.md) | The HTTP API reference: every route, request and response shape, and status code — what you need to integrate server-side without reading source. |
| [`docs/deployment.md`](docs/deployment.md) | Operating it behind a TLS edge: the proxy contract, the environment surface, and how each violation fails silently. |
| [`docs/clause-mapping.md`](docs/clause-mapping.md) | How the 2025 requirement numbers used throughout this project map to the DS01.3 rewrite. |
| `src/schemas/` + `src/schema-registry.ts` | The vendored transmission schemas and the registry that pins them by content hash. Schemas are never fetched at runtime — `schemaVersion` is a lookup key, not a locator. |

## Development

Node 20+ and TypeScript end to end; Fastify, Ajv, Postgres, React + Vite.

```bash
npm install
docker compose up -d postgres   # Postgres 16; db/initdb/*.sql runs on first boot
npm run dev                     # API with hot reload on :3000
npm test                        # node test runner via tsx
npm run build                   # tsc + schemas + web typecheck + vite build
```

Tests colocate with their source as `*.test.ts`. The dashboard is served by the same
Node process from `dist/web`, so a full `npm run build` (or `docker compose up -d`)
is what puts the UI on `:3000`.

### Tests need a database — `npm test` alone does not tell you so

`npm test` **without a database is not a full run.** Eight suites — the repository
layer, the ingest route, the ingest stages, and the sessions API — probe Postgres
once and skip themselves entirely when it is unreachable. You get `# pass 232 /
# fail 0 / # skipped 50`: green, and the whole persistence and ingest-integration
layer never executed. Treat a bare `npm test` as the pure-logic subset only.

To run everything, bring up Postgres and point the suite at it:

```bash
docker compose up -d postgres   # first boot applies db/initdb/*.sql in order
npm run test:db                 # npm test with the compose-local DATABASE_URL preset
```

That is `# pass 282 / # fail 0 / # skipped 0`. If you see skips, the database is
not reachable — or its schema predates a DDL file. `db/initdb/` is applied only on
**first** boot of the volume, so a database created before a numbered file was
added never got it; apply the missing files by hand, or `docker compose down -v`
and let it re-initialize from scratch.

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs lint, build and the
full suite against a real Postgres, applying every `db/initdb/*.sql` in filename
order first. It **fails on any skip**, because in CI a skipped test means the
database gating broke rather than that a database was unavailable. (Nothing has been
pushed to the remote yet, so the workflow is checked in and starts running on the
first push.)

## License

MIT — see [`LICENSE`](LICENSE).
