# CCE Data Delivery Validator

This project is an independent, receiving-side conformance check for **WHO/PQS E006/DS01,
Clause 5 – Data Delivery to External Systems**. It is informed by the cold chain
equipment (CCE) data delivery requirements that UNICEF published after the industry
consultation of Q1 2025 (see [this page](https://docs.2to8.cc/cce-data-interop/requirements/)).

It was developed to enable CCE suppliers to point a stream of data transmissions at a
test endpoint and get back an independent evaluation of what conforms to the UNICEF
data delivery requirements -- and what does not.

> [!IMPORTANT]
> Following the UNICEF CCE Data Delivery industry consultation, the WHO Performance,
> Quality and Safety programme (PQS) took responsibility for incorporating these
> requirements into the EMS Data Standard (E006/DS01.x). The PQS review process is
> expected to conclude in or around Q4 2026. In the meantime, this project grades
> transmissions against both the UNICEF Q1 2025 requirements and the latest DS01.3
> draft schema (September 8, 2026). The default view shows UNICEF Q1 2025 grading, with
> an alternative DS01.3 grading lens (see
> [Shadow grading and the grading lens](#shadow-grading-and-the-grading-lens)).
> This project will be updated as the DS01.3 requirements are revised.

## What this is

Clause 5 obliges CCE data suppliers, the manufacturers and resellers of remote
temperature monitoring devices (RTMDs) and equipment monitoring systems (EMS), to
deliver performance data over HTTPS to the countries that own the equipment. This
project is a public service that plays the employer, or country, side of that
interface. It provides a web dashboard where a supplier gets an independent read on
their conformance, "to the extent possible" from the receiving vantage point.

A supplier creates a test endpoint in one click, with no signup and no account. They
then POST real transmissions from their own data platform and read the findings, per
transmission and rolled up per requirement.

## Why it exists

PQS test labs prequalify the equipment. Nobody tests the data delivery
implementation. Suppliers therefore self-grade today against a prose requirements
document and a JSON Schema, and implementation gaps go unnoticed until a country
receives the data.

This service gives suppliers a second opinion before that happens, from something
that behaves like a country receiver.

## Who it is for

The service is written for three audiences:

- **Supplier engineers** integrating Clause 5 data delivery, who want a real endpoint
  to test against rather than a checklist.
- **Ministry and country technologists** evaluating what a receiving system can
  actually establish about a supplier's conformance.
- **PQS and standards stakeholders** interested in where the standard is mechanically
  checkable and where it is not.

## What the system can and cannot prove

Every requirement is classified by what a passive receiver can establish. A
requirement that cannot be graded is labelled as such rather than quietly counted as
a pass. The classes are:

| Class                  | Meaning                                                                | Rows |
| ---------------------- | ---------------------------------------------------------------------- | ---- |
| Passively verified     | Graded from the supplier's own traffic                                 | 7    |
| Heuristic / partial    | Observable, but the system cannot judge intent or justification        | 3    |
| Active-only (deferred) | Needs deliberate error injection or a guided scenario; out of v1 scope | 8    |
| Self-attestation       | Not provable from the receiving side at all                            | 9    |
| Enforced by us         | Guaranteed by the endpoint, so not a test of the supplier's choice     | 1    |

There are 27 requirements in total. Two carry a split classification: §1.1 is both
passively verified and enforced by us, and §4.4 is both active-only and
self-attestation. §1.7 has nothing to grade. A gradeable requirement with no findings
yet shows "untested", never a false pass.

The full row-by-row matrix, with every requirement, its class, and how it is
checked, is [`DESIGN.md` §7](DESIGN.md#7-compliance-engine--verifiability-matrix).
It is mirrored in `src/api/compliance-matrix.ts` and rendered live in the dashboard.

## Shadow grading and the grading lens

The DS01.3 rewrite of the requirements is an unpublished draft. Its Annex 4 delivery
schema is registered here beside the published `cce-interop` schemas as a second
_lineage_. A lineage is a schema family: `cce-interop` for the UNICEF Q1 2025
requirements, Annex 4 for DS01.3. The set of requirements that a lineage's findings
are numbered under is called a _package_ on the dashboard and in the API. The two
packages are named UNICEF Q1 2025 and DS01.3 DRAFT.

A transmission whose declared `schemaVersion` resolves to a registered lineage is
graded twice. The lineage it declares is the primary run and sets the HTTP response
code. The current schema of the other lineage runs as the shadow: its findings are
recorded under its own clause numbers, and it never changes the status, even when
the primary run rejects the transmission.

A transmission that never gets that far carries no shadow result at all. An
unrecognized `schemaVersion`, a body that does not parse, and a transport rejection
before either are each answered under the 2025 requirements alone. The matrix above
stays contract-only: its rows grade the 2025 requirements, which are the contract in
force, and a shadow verdict never moves a row.

The dashboard reads under one package at a time, through a _grading lens_. A toggle
in the header swaps the whole view between UNICEF Q1 2025, the default, and DS01.3
DRAFT. The lens is a read-time projection: it changes which package the page reports
under, never what was graded, what was stored, or what status code a transmission
received. Lens state lives in the URL query, so a copied link opens on the view it
was copied from.

Under the draft lens the compliance matrix, the counts, the filters and the
transmission detail are all reported under DS01.3 clause numbers. A banner says the
draft is not yet published and gives the date of the bytes behind it. The
transmissions summary card carries one readiness figure: of the in-scope traffic
that passes UNICEF Q1 2025, how much also passes the draft. Each transmission keeps
a verdict dot per package, the selected one bold and the other dimmed, with a dashed
"not graded here" dot where the draft never ran.

The two packages are kept apart on purpose. A supplier under a 2025 agreement should
be able to see what is coming without being told that the version their contract
requires is stale. For that reason a lineage is never called old, new, current, or
latest.

## Quick start

Bring up Postgres 16 and the app, which serves on port 3000:

```bash
docker compose up -d
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
        "LDOP": "2021-08-15",
        "LMFR": "Logger_Co",
        "LMOD": "Logger_Model",
        "LPQS": "E006/998",
        "LSER": "log4567890asdf",
        "DLST": { "TVC": { "SID": "sensor-1", "SMFR": "SensMfr", "SMOD": "SensMod" } },
        "records": [
          { "ABST": "20200115T040554Z", "ALRM": "HEAT", "BEMD": 14.3, "EERR": "none", "TVC": 3.2 }
        ]
      }
    ]
  }'

# 3. Open the dashboard: $BASE/d/<uuid>
```

### The ingest response

The HTTP response is itself an information surface. A supplier can understand the
outcome without opening the dashboard. The findings are abridged here:

```json
{
  "transmissionId": "563af727-…",
  "status": 200,
  "message": "Accepted (200): data recorded; 9 findings (2 info). Also passes the DS01.3 Annex 4 draft of 2026-09-08 (sha256 7e22de27…).",
  "findings": 9,
  "findingDetails": [
    {
      "requirement": "3.2",
      "severity": "pass",
      "profile": "2025",
      "detail": "validated against official 0.8.1 (sha256 290290fd…) (§3.2)"
    },
    {
      "requirement": "5.3.2",
      "severity": "pass",
      "profile": "ds013",
      "detail": "validated against DRAFT 1 (draft 2026-09-08, sha256 7e22de27…) (§5.3.2)"
    }
  ],
  "advisories": [],
  "notice": "Synthetic test data only: this is a sandbox endpoint. …"
}
```

A rejection has the same shape, so a 4xx is as self-explanatory as a 2xx.

The `findings` count and the leading tally in `message` cover the contract lineage
alone. `findingDetails` carries both lineages, and the `profile` on each entry says
which one graded it. The sentence at the end of `message` reports what the DS01.3
run found without it ever changing the status. The shadow runs even when the primary
run rejects the transmission, which is why a `ds013` failure can sit on a `200` and a
`ds013` pass on a `422`. The draft date and hash shown there come from the registry
entry for those bytes, so they move when the proposal is re-pinned.

### Notes for testing

Useful things to know while sending transmissions:

- **`200` is the only success code on ingest.** `POST /i/<uuid>` is synchronous:
  findings are computed before the response is written, so there is no `202` path
  to handle. Other routes differ. Minting a session in step 1 above returns
  `201 Created`; see [`docs/api.md`](docs/api.md).
- **Gzip is supported.** Send `Content-Encoding: gzip` with the gzipped body, and do
  not double-encode (§1.6).
- **The §1.4 grading cap is 1MB of wire bytes**, measured after content-encoding.
  Going over earns a teaching `413`, with the transmission still recorded.
- **Authentication (§1.3) is opt-in** and off by default. Enable it from the
  dashboard, which generates the credential for one of the three methods DS01.3
  recognises: a token in a configurable header, HTTP Basic, or `Authorization:
Bearer` (RFC 6750). The endpoint then enforces it, so §1.3 becomes gradeable.
- **Schemas are vendored and pinned by content hash.** Two `cce-interop` versions
  are registered as the contract lineage, both byte-identical to the copies
  published upstream. 0.8.1 (sha256 `290290fd…`) is current. The older 0.8.0
  (sha256 `e6614cc7…`) is still accepted but graded as outdated: a `200` with a §3.2
  note telling you to upgrade, not a rejection. Outdated is judged within a lineage
  only.
- **The DS01.3 Annex 4 draft is the shadow lineage.** Its `schemaVersion` is the
  integer-valued string `"1"`, because that annex versions by revision rather than
  by semver. Any other declared `schemaVersion` gets a `422` listing what is
  supported, never a silent fallback.
- **The schema is never fetched at runtime.** The `$id` URL inside it is an
  identifier, not a download location: that host does not currently resolve, and
  the published artifact lives elsewhere. `DESIGN.md` §9 has the full version and
  publication picture.
- **An endpoint and all its data are purged after 7 days without a POST.** The clock
  resets on each POST, and the expiry is shown in the dashboard.

## Self-hosting

`docker compose up -d` brings up Postgres and the app for local use, on defaults and
with no configuration. To change any of it, copy [`.env.example`](.env.example) to
`.env`. That file annotates the whole variable surface and marks what must change
before a public deployment, starting with the `cce_validator` database credentials,
which are a published default and not a secret.

For a real deployment, TLS is terminated at a Caddy reverse proxy brought up behind
an optional compose profile:

```bash
docker compose --profile edge up -d
deploy/smoke-proxy-contract.sh https://your.host
```

The edge profile is not extensively tested at present, and feedback is welcome.

Read [`docs/deployment.md`](docs/deployment.md) before deploying. The proxy contract
there is a correctness concern, not plumbing. An edge that caps, buffers, or
decompresses request bodies does not fail loudly: it silently changes the evidence,
and the service goes on issuing confident findings against the wrong input. The smoke
test exists to catch exactly that.

### Adopting DS01.3

Findings are stored with the requirement lineage they graded against, not with the
role that lineage played at the time. The day DS01.3 becomes the contract in force,
every row already in the database changes meaning. A transport rejection recorded
under the 2025 lineage was a contract finding when it was written, and would read as
a shadow finding afterwards, quietly dropping out of the supplier's grade.

The rule is therefore a clean cut. Adopting a new contract profile discards all
stored data, and there is no migration. Stop the service, discard the database volume
with `docker compose down -v`, and start again.

The service enforces this itself. The database records the contract profile it was
last written under, and the app refuses to start over data written under a different
one, printing that instruction. The marker table is created by
`db/initdb/80-contract-profile-marker.sql`, and initdb runs only on the first boot
of a fresh volume. On an existing volume the file must be applied by hand before the
service will start; see
[Upgrading an existing database volume](docs/deployment.md#upgrading-an-existing-database-volume).
A guard that started anyway would be inert on precisely the deployments that already
hold rows.

Two limits are worth knowing. The check reads the database only, so it cannot see
the dashboard's copy of the profile in `src/web/api.ts`, and a flip is still a
two-edit change, server and web. And it is a guard against mislabelling, not a
backup: retention already deletes everything after 7 days of inactivity, so the data
a flip discards is at most one week of test traffic.

## Status and v1 scope

The service is pre-release. It runs end to end: the ingest pipeline, the dashboard,
the semantic checks, the §1.3 auth opt-in, the retention worker, DS01.3 shadow
grading and the grading lens have all landed. There is no public instance, and
self-hosting is the intended way to use it. Interfaces may still change.

Source: <https://github.com/phoenixgh-org/cce-data-delivery-validator>.

The following is deliberately out of scope for v1 (see `DESIGN.md` §2 and §3):

- **Passive validation only.** The system grades what arrives; it does not probe the
  client.
- **No active conformance harness.** Nothing deliberately returns 429, 503 or 5xx to
  measure a supplier's retry count, backoff shape, or `Retry-After` handling. That
  is why §4.1 to §4.5 sit in the active-only class, with §4.4 also self-attestation.
  §4.6 to §4.9 are a different matter: they are supplier-internal and stay
  self-attestation, because no harness would make them provable from the receiving
  side.
- **No guided retransmission scenarios** for §5: the 6-month retransmit, time-range
  filters, and all-versus-never-sent.
- **7-day retention** after POST inactivity. After that time the endpoint and its
  data are deleted automatically.

## Further reading

| Where                                              | What                                                                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`DESIGN.md`](DESIGN.md)                           | Scope, locked decisions, the ingest pipeline and response codes, and the full §7 verifiability matrix. The authority on all of it.                                                            |
| [`docs/api.md`](docs/api.md)                       | The HTTP API reference: every route, request and response shape, and status code. What you need to integrate server-side without reading source.                                              |
| [`docs/deployment.md`](docs/deployment.md)         | Operating it behind a TLS edge: the proxy contract, the environment surface, and how each violation fails silently.                                                                           |
| [`docs/clause-mapping.md`](docs/clause-mapping.md) | How the 2025 requirement numbers used throughout this project map to the DS01.3 rewrite.                                                                                                      |
| [`docs/exercise-suite.md`](docs/exercise-suite.md) | Internals of the `npm run exercise` conformance suite: the case model, the transform vocabulary, advisory and shadow cases, the grading-lens audit, the coverage join, and how to add a case. |
| `src/schemas/` + `src/schema-registry.ts`          | The vendored transmission schemas and the registry that pins them by content hash. Schemas are never fetched at runtime; `schemaVersion` is a lookup key, not a locator.                      |

## Development

The stack is Node 22+ and TypeScript end to end: Fastify, Ajv, Postgres, and React
with Vite.

```bash
npm install
docker compose up -d postgres   # Postgres 16; db/initdb/*.sql runs on first boot
npm run dev                     # API with hot reload on :3000
npm run dev:web                 # dashboard with HMR on :5173, API proxied to :3000
npm test                        # node test runner via tsx
npm run build                   # tsc + schemas + web typecheck + vite build
```

Tests colocate with their source as `*.test.ts`. The dashboard is served by the same
Node process from `dist/web`, so a full `npm run build`, or `docker compose up -d`,
is what puts the UI on port 3000. In dev there is no such build, and the Node process
deliberately serves no UI at all, because it would otherwise be serving untransformed
Vite source. Run `npm run dev:web` alongside `npm run dev` and use port 5173, which
proxies `/api`, `/i` and `/health` through to the API.

### Database-gated tests

`npm test` without a database is not a full run. The suites that touch Postgres
probe it once and skip themselves entirely when it is unreachable. Those are the
repository layer, the contract-profile guard, the ingest route and stages, the
ingest fixtures, and the sessions API. The run is green with those suites reported
as `# skipped`, and the whole persistence and ingest-integration layer never
executed. Treat a bare `npm test` as the pure-logic subset only.

To run everything, bring up Postgres and point the suite at it:

```bash
docker compose up -d postgres   # first boot applies db/initdb/*.sql in order
npm run test:db                 # npm test with the compose-local DATABASE_URL preset
```

That must report `# fail 0 / # skipped 0`. Every test executes, which is the only
number worth stating here, since the totals move with every test that lands. If you
see skips, the database is not reachable, or its schema predates a DDL file.
`db/initdb/` is applied only on the first boot of the volume, so a database created
before a numbered file was added never got it. Apply the missing files by hand, as
described in
[Upgrading an existing database volume](docs/deployment.md#upgrading-an-existing-database-volume),
or run `docker compose down -v` and let it re-initialize from scratch.

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs lint, build and the full
suite against a real Postgres, applying every `db/initdb/*.sql` in filename order
first. It fails on any skip, because in CI a skipped test means the database gating
broke rather than that a database was unavailable.

### Exercise suite

`npm test` checks the graders in isolation. `npm run exercise` checks the whole
service by driving a live instance the way a supplier would, with synthetic payloads
built from the suite's own baselines. It checks five things, and any of them can fail
the run:

- **Requirements, both directions.** Every gradeable requirement in the §7 matrix is
  played once with a transmission that should pass it and once with one that should
  fail it, asserting the HTTP statuses and the findings that came back.
- **Advisories, both halves.** Every registered advisory is fired by a case built to
  provoke it, and conformant traffic is asserted to draw none.
- **The DS01.3 shadow run.** Cases declare what the unpublished Annex 4 draft would
  make of a payload the contract in force accepts.
- **The advisory copy.** The prose the instance actually served is audited run-wide
  for shape and vocabulary.
- **The grading lens.** The DS01.3 summary rows the instance serves are checked
  against the findings and verdicts it serves beside them.

It needs a server and a database, which is why it is deliberately outside
`npm test`:

```bash
docker compose up -d postgres         # or `docker compose up -d` for the whole app
npm run dev                           # in another shell; API on :3000

npm run exercise                      # http://localhost:3000
npm run exercise -- https://your.host # an explicit target
EXERCISE_BASE_URL=https://your.host npm run exercise
npm run exercise -- --help            # print usage
```

The target resolves in the order argument, then `EXERCISE_BASE_URL`, then
`http://localhost:3000`. The exit codes are:

- `0`: every case passed, the advisory copy is clean and the lens agrees.
- `1`: a case failed, or the advisory-copy or grading-lens audit found a violation.
- `2`: could not run, because the target was unreachable or is not a validator.

Each run mints its own session and prints a per-case verdict, run counts, the
advisory copy the instance served, the grading-lens audit, the coverage report
(requirement coverage and the advisory join), and that session's dashboard URL. The
console output is a summary; the dashboard is the detailed report.

Two caveats apply to an exercise run:

- **The exercised session ends with §1.3 auth enabled.** Opting in is sticky and
  session-global, so the §1.3 cases are played last after a single opt-in, and the
  runner does not turn it back off. The dashboard has the disable control if you want
  to keep POSTing to that session by hand.
- **The §2.1 fail case is a live timing assertion.** It fires three POSTs at once and
  needs two of them genuinely in flight together. That is reliable against a local
  instance, but it is a measured fact rather than a guarantee, which is exactly why
  it lives here and never in `npm test`.

[`docs/exercise-suite.md`](docs/exercise-suite.md) covers the internals: the case
model, the transform vocabulary, what CI can check without a server, and how to add
a case.

## License

MIT; see [`LICENSE`](LICENSE).
