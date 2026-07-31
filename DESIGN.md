# CCE Data Delivery Validator — Design

**Status:** Draft (v1 scope)
**Last updated:** 2026-05-28

## 1. Overview

Cold chain equipment (CCE) data suppliers — manufacturers/resellers of RTMDs and
EMS-compliant equipment — are required by **WHO/PQS/E006/DS01.2, Clause 5 (Data
Delivery to External Systems)** to deliver CCE performance data to countries over
HTTPS. The "Interoperable CCE Data Delivery" requirements document (2025-03-30)
clarifies the low-level details. PQS test labs prequalify the *equipment* but do
**not** test the *data delivery* implementation, so suppliers today self-grade.

This project is a **public service that plays the employer/country (receiving)
side** of that interface, plus a **web dashboard** where suppliers get an
independent, honest read on their compliance — "to the extent possible" from the
receiving vantage point.

The governing artifacts:
- `src/schemas/cce-interop-*.json` — the transmission JSON Schemas, vendored and
  registered (§9). This is the **only** copy in the repo; `docs/` deliberately
  holds no schemas, so there is one place to verify against the published bytes.
- `docs/internal/Interoperable CCE Data Delivery - REQUIREMENTS - 20250330 .pdf` — the
  prose requirements (local-only: `docs/internal/` is gitignored, so this file is
  absent from a fresh clone).
- `docs/clause-mapping.md` — how those requirement numbers map to the DS01.3 rewrite.

When prose and schema disagree, **the schema wins**. This came from 2025
requirement §3.2; DS01.3 drops the precedence rule, and we keep it deliberately
as a house rule (see `CLAUDE.md`).

## 2. Goals and non-goals (v1)

**Goals**
- Stand up a real HTTPS ingest endpoint suppliers can POST to with **zero onboarding friction**.
- Validate each transmission against the JSON Schema and the *passively verifiable* requirements.
- Present results in a dashboard, **clearly delineating what we can and cannot prove**.

**Non-goals (deferred)**
- **Active conformance probing** of §4 (deliberately returning 429/503/5xx to measure
  retry counts, backoff shape, `Retry-After` handling, abandon-on-permanent-failure).
- **Guided retransmission scenarios** for §5 (6-month retransmit, time-range filter, all-vs-never-sent).
- Receiving **real production data** — v1 is a **test/sandbox** for synthetic data only.

## 3. Locked decisions

| # | Decision |
|---|----------|
| Scope | **Passive validation only** in v1. |
| Data | **Test/sandbox** synthetic data; no real CCE/PII. |
| Onboarding | **Capability URL**, minted via the **web dashboard** "Create" action (no signup). |
| Identity | **Single UUID** is both ingest path and dashboard key. Possession = authority. |
| Auth (§1.3) | **Opt-in compliance layer, not a gate.** On opt-in the **dashboard generates** the credential (token + configurable header name, or Basic Auth) for the supplier to copy in; the endpoint then enforces it so §1.3 becomes gradeable. |
| Retention | Purge a path + its data after **7 days** of POST inactivity. |
| Stack | **Node + TypeScript** end-to-end, **Ajv** for schema validation. |
| Schema versioning | **Bare-semver `schemaVersion`** as an opaque registry key; schemas are **vendored** and validated against **pre-registered copies** (never fetched at runtime); each version is pinned by **content hash** to prove the "blessed bytes." |

## 4. Architecture

```
                 ┌──────────────────────────────────────────────┐
   Supplier      │                  Service                      │
   system        │                                               │
   ──POST data──▶│  /i/{uuid}   ── ingest pipeline ──▶ findings  │
                 │                                       │        │
                 │                                       ▼        │
   Supplier      │  /d/{uuid}   ◀── dashboard API ──  datastore   │
   browser ─────▶│  web UI (create endpoint, view report,        │
                 │           opt into §1.3 auth)                  │
                 └──────────────────────────────────────────────┘
```

Components:
- **Ingest API** — `POST /i/{uuid}`. Runs the pipeline (§6), persists the transmission and its findings, returns an appropriate HTTP status.
- **Dashboard API** — mint sessions, read transmissions/findings/summary, manage the §1.3 auth opt-in.
- **Web frontend** — landing page with a **Create test endpoint** button; per-session dashboard.
- **Compliance engine** — the schema validator plus the per-requirement checks; produces findings.
- **Datastore** — sessions, transmissions, findings (§8).
- **Retention worker** — purges inactive sessions (§11).

A Node service (API + static frontend) plus a Postgres container for v1, wired together with
`docker-compose`; the frontend can be split out later if needed.

### 4.1 Edge / TLS termination (proxy contract)

TLS is terminated at a **Caddy** reverse-proxy container (Digital Ocean), whose automatic
Let's Encrypt certs satisfy §12 / Attachment 2's "valid certs, no supplier-installed
intermediates" for free. Because the app sees plain HTTP behind Caddy, the proxy must honor a
small **contract** so the receiving-side checks stay accurate:

- **Scheme advertised.** Caddy sets `X-Forwarded-Proto`; the app trusts it **scoped to Caddy's
  address only** (Fastify `trustProxy`), and the app port is never publicly exposed. This is how
  §1.1's HTTPS aspect is known.
- **Body passed through untouched.** Caddy must **not** impose a `request_body max_size` below our
  1MB grading threshold — otherwise oversized POSTs get Caddy's generic `413` and we never record
  the transmission or emit the teaching finding. The **app owns** the §1.4 cap.
- **Encoding preserved.** The body reaches the app **as sent** (no request decompression, no
  re-chunking), so §1.4 wire-byte measurement and §1.6 `Content-Encoding` / double-encoding
  detection see exactly the supplier's bytes. (Caddy does not decompress request bodies by
  default — verify and lock the config.)

## 5. Onboarding flow (web-driven)

1. Supplier visits the site, clicks **Create test endpoint**.
2. Frontend calls `POST /api/sessions`; backend mints a v4 UUID, creates a session row, returns
   `{ uuid, ingestUrl: "/i/{uuid}", dashboardUrl: "/d/{uuid}" }`.
3. Supplier is taken to `/d/{uuid}`, which shows the ingest URL, copy-paste examples
   (`curl`, headers), and an empty results view that fills in as data arrives.
4. The dashboard URL is the only thing they need to bookmark. There is no account, email, or password.

> The UUID is a bearer capability. Anyone holding it can both POST and view. Acceptable for
> sandbox/test data; see §12.

## 6. Ingest pipeline and response codes

Each `POST /i/{uuid}` runs ordered stages. A stage either **produces a finding and continues**
or **short-circuits** with a response code. We follow the Country Guidance (Attachment 2) for codes.

| Stage | Check | On failure |
|-------|-------|-----------|
| 0. Session | UUID exists & not expired | `404` |
| 1. Method/TLS | POST over HTTPS (§1.1) | TLS enforced at the edge; non-POST → `405` |
| 2. Auth (opt-in) | If enabled, expected token header or Basic Auth present & correct (§1.3) | `401` |
| 3. Size | Wire body ≤ 1MB **after** content-encoding (§1.4) | `413` + finding |
| 4. Content-Type | `application/json; charset=utf-8` (§1.2) | finding; continue (`415` optional) |
| 5. Content-Encoding | If `gzip`, decompress; detect illegal double-encoding e.g. base64 (§1.6) | finding; `400` if undecodable |
| 6. JSON parse | Body is valid UTF-8 JSON (§1.1) | `400` |
| 7. Schema validate | Ajv against `meta.schemaVersion` (§3.1/§3.2) | `422` + per-error findings |
| 8. Semantic checks | Duplicate `transferId` (§1.8), interval regularity (§3.4), concurrency (§2.1), present-object inventory (§3.3 info) | findings; `2xx` (data accepted) |

Success: `200`/`202` with a small JSON body summarizing what was recorded. The exact body is
also a teaching surface — it can echo the count of findings so suppliers see results without
opening the dashboard.

**Size note (§1.4):** the requirement is measured *after* encoding (the bytes on the wire), so
we measure the raw request body length, not the decompressed size.

## 7. Compliance engine — verifiability matrix

The product's distinguishing honesty is classifying every requirement, not just the ones we can grade.

**Legend:** ✅ Passively verified · 🟡 Heuristic / partial · 🔌 Active-only (deferred) · 📝 Self-attestation (not provable from receiving side) · 🔒 Enforced by us (guaranteed by the endpoint, not a test of the supplier's choice)

| Req | Summary | Class | How |
|-----|---------|-------|-----|
| 1.1 | HTTPS POST, UTF-8 JSON | ✅ / 🔒 | **HTTPS is 🔒 enforced at the edge** — non-HTTPS never reaches us, so it always "passes" and is *not* a test of the supplier's choice; **POST method + UTF-8 JSON parse** are ✅ verified from supplier traffic |
| 1.2 | `Content-Type: application/json; charset=utf-8` | ✅ | Header inspection |
| 1.3 | Auth via token header or Basic Auth | ✅ (opt-in) | Enforced once supplier enables the auth layer |
| 1.4 | Body ≤ 1MB post-encoding | ✅ | Measure wire bytes |
| 1.5 | Expect standard 2xx/4xx/5xx | 📝 | We *return* correct codes; supplier-side expectation isn't observable |
| 1.6 | Gzip via `Content-Encoding`, no double base64 | ✅ | Decode + detect double-encoding |
| 1.7 | Custom headers permitted | — | Permissive; nothing to grade |
| 1.8 | No duplicates except allowed conditions | 🟡 | Observe repeated `transferId`; can't judge justification |
| 2.1 | Serial delivery by default | 🟡 | Observe concurrent in-flight requests per session |
| 2.2 | Deliver within minutes of receipt | 📝 | Remote-system receipt time is unknown to us |
| 2.3 | Alarm within 15 min + include data since last tx | 📝 | Alarm origin time unknown to us |
| 3.1 | Adopt DS01 objects + transmission meta fields | ✅ | Schema enforces `meta.*` |
| 3.2 | Validates against the schema | ✅ | Ajv (the core check) |
| 3.3 | Transmit all collected objects | 📝 | We don't know what they collect; we can *inventory* what's present |
| 3.4 | Preserve logger time resolution | 🟡 | `ABST` interval regularity heuristic |
| 4.1 | Retry on non-2xx | 🔌 | Needs deliberate error injection |
| 4.2 | ≥6 retries / 24h, non-blocking | 🔌 | Active harness |
| 4.3 | Abandon on permanent failures (501/505/most 4xx) | 🔌 | Active harness |
| 4.4 | Backoff strategy (+ describe to employer) | 🔌 / 📝 | Active harness for shape; "describe" is attestation |
| 4.5 | 429 `Retry-After` honored (longer of the two) | 🔌 | Active harness |
| 4.6 | Log failed attempts | 📝 | Supplier-internal |
| 4.7 | Provide email + SLA | 📝 | Supplier-internal |
| 4.8 | Monitor transmission status | 📝 | Supplier-internal |
| 4.9 | Notify staff/employer on elevated failures | 📝 | Supplier-internal |
| 5.1 | Retransmit last 6 months on request | 🔌 | Guided scenario |
| 5.2 | Filter retransmit by time range | 🔌 | Guided scenario |
| 5.3 | Filter all vs never-sent | 🔌 | Guided scenario |

The dashboard renders this matrix per session: ✅/🟡 carry live pass/fail counts from the
supplier's actual traffic; 🔌 are marked "not yet exercised — available in a future test mode";
📝 are marked "self-attestation — outside what a receiver can prove."

## 8. Data model

**PostgreSQL** is the datastore, converging with the sibling project `tremble` (which ingests
the same PQS E006 DS01 data and is itself "opinionated-Postgres"). This gives us native `jsonb`
for payloads/findings, a clean path to a future production-endpoint mode with no migration, and
lets us lift `tremble`'s content-addressed patterns directly. Accessed via `node-postgres`
(`pg`) behind a thin repository layer.

The `transmission` table mirrors `tremble`'s `source_artifact` (content hash, byte size,
content type, channel, received-at), with one deliberate difference: `tremble` makes
`content_hash` **`UNIQUE`** to *dedup-and-drop* on idempotent replay, whereas we **record every
POST** and instead *flag* repeats — duplicate detection is the §1.8 signal we're grading, so we
must never silently collapse it.

- **session** — `uuid` (PK), `created_at`, `last_post_at`, `auth_enabled bool`, `auth_method`
  (`header` | `basic`), `auth_header_name`, `auth_secret_hash`.
- **transmission** — `id uuid` (PK), `session_uuid` (FK → session), `received_at timestamptz`,
  `content_hash bytea` (SHA-256 of the raw wire body; **not** unique — used to detect exact
  replays), `wire_bytes bigint`, `content_type`, `content_encoding`, `http_status int`,
  `transfer_id`, `transfer_src`, `transfer_type`, `schema_version`,
  `body jsonb` (parsed payload; null if unparseable), `raw_body` (size-bounded, kept for
  drill-down especially when parsing fails), `parse_ok bool`, `schema_ok bool`.
- **finding** — `id`, `transmission_id` (FK → transmission), `requirement` (e.g. `1.4`),
  `severity` (`pass` | `fail` | `info`), `detail`, `pointer` (JSON Pointer into the payload
  where relevant).

Indexes: `transmission (session_uuid, received_at DESC)` for the dashboard's reverse-chronological
list and per-session rollups; `transmission (session_uuid, content_hash)` and
`transmission (session_uuid, transfer_id)` for duplicate detection (§1.8). Concurrency
observation (§2.1) is in-flight request tracking per session, not a stored artifact.

Schema is applied as ordered SQL on first boot (mirroring `tremble`'s `db/initdb/` convention);
a migration runner is deferred until the schema needs to evolve in production.

## 9. Schema registry and versioning

- The service hosts a registry of **vendored** schema versions, currently **0.8.1** only
  (`src/schemas/cce-interop-0.8.1.json`). Multi-version support is a feature, not a
  complication — the registry is a *policy* about which versions we accept, and the
  pre-release 0.8.0 was deliberately dropped once 0.8.1 was published (nothing outside
  this machine had used it). A payload declaring an unregistered version gets `422`
  with the supported list, never a silent fallback.
- **Never fetched at runtime.** `meta.schemaVersion` is a *lookup key*, not a locator. We validate
  only against pre-registered copies — runtime fetching would (a) couple our ingest path to an
  external host's uptime, (b) be an SSRF foot-gun (a URL pulled from request data), and (c) destroy
  the "we validated against *the official* version" claim. JSON Schema's `$id` is formally an
  identifier, not a network locator, so this is also correct per spec.
- **Normalized matching.** The standard today is ambiguous about the field's form (the description
  points at `$id` — a URL — while the only example is a bare semver, `0.1.1`). Until the standard is
  clarified (§15), we **normalize on ingest**: accept either a bare semver or a full `$id`-style URL,
  extract `MAJOR.MINOR.PATCH`, and look that up. **Exact match required**; no silent fallback to a
  "close" version (that would defeat conformance). Unknown version → `422` with an
  "unsupported schemaVersion" finding that **lists the versions we do support**.
- **Content-hash provenance ("blessed bytes").** Each registered version is pinned by the SHA-256
  of its canonical bytes; the dashboard can surface "validated against official 0.8.0 (sha256 …)".
  The vendored file is therefore kept **byte-identical** to the published artifact — cosmetic issues
  in the schema (the stale `0.1.1` example, the `schemaVersion`→`$id` phrasing) are **not** patched
  locally, but tracked as standard-revision proposals (§15), so the hash keeps matching what WHO
  published.
- Ajv compiles each registered schema once at startup and reuses the compiled validator.

## 10. Dashboard

Per session (`/d/{uuid}`):
- **Setup** — ingest URL, copy-paste `curl`/header examples, and the §1.3 auth opt-in
  (toggle → service generates token + header name or Basic creds → shows config snippet).
- **Compliance summary** — the §7 matrix with live counts and the honesty classification.
- **Transmissions** — reverse-chronological list; drill into any transmission to see the
  raw body, returned status, and the findings (with JSON Pointers to schema errors).
- **Lifecycle** — shows the 7-day inactivity expiry clock.

## 11. Retention / lifecycle

A periodic worker deletes sessions (and cascades to their transmissions/findings) whose
`last_post_at` (or `created_at` if no posts) is older than **7 days**. The expiry is surfaced
in the dashboard so it's never a surprise.

## 12. Security considerations

- **Capability URL caveat.** The UUID is a bearer secret in the path; URLs leak via logs,
  proxies, and browser history. Acceptable for synthetic test data (v1's only data). If real
  data is ever in scope, revisit (split ingest vs view tokens; move the secret to a header).
- **HTTPS only**, with valid certs that don't require suppliers to install intermediates
  (Country Guidance, Attachment 2).
- **Auth secrets** stored hashed, never echoed after first display.
- **Resource limits** — enforce the 1MB body cap at the framework layer to bound memory;
  guard gzip decompression against zip-bomb expansion ratios.

## 13. Tech stack

- **Runtime/language:** Node + TypeScript.
- **HTTP:** Fastify (fast, schema-friendly, first-class `Content-Type`/raw-body control) — to be confirmed at build time.
- **Validation:** Ajv running the published schema directly, using the build that
  matches the schema's declared dialect — currently **2020-12** (`ajv/dist/2020`),
  since 0.8.1 as published declares 2020-12. The pre-release 0.8.0 was draft-07.
- **Storage:** PostgreSQL via `node-postgres` (`pg`), behind a thin repository layer; schema
  adopts `tremble`'s content-addressed `source_artifact` / `jsonb`-body patterns.
- **Frontend:** lightweight SPA (React or similar); may be server-rendered for v1 simplicity.
- **Edge:** **Caddy** reverse proxy (Digital Ocean) terminating TLS with automatic Let's Encrypt
  certs; honors the proxy contract in §4.1.
- **Local/dev:** `docker-compose` (app + Postgres), following `tremble`'s healthcheck-gated bring-up.

## 14. Build order (v1 milestones)

1. **Skeleton** — Node/TS project, Fastify server, Postgres via docker-compose with first-boot
   schema, schema registry loading 0.8.0; Ajv compiles.
2. **Ingest core** — `POST /i/{uuid}`: size/content-type/encoding/parse/schema stages → persist transmission + findings → correct status codes.
3. **Sessions + dashboard read** — `POST /api/sessions`, `GET /api/sessions/{uuid}` (transmissions, findings, summary).
4. **Web UI** — Create button, setup page with copy-paste examples, transmission list + drill-down, the §7 matrix.
5. **Semantic checks** — duplicate `transferId`, interval regularity, concurrency, object inventory.
6. **§1.3 auth opt-in** — generate credential, enforce on ingest, show config snippet.
7. **Retention worker** + lifecycle display.
8. **Polish** — examples, error messaging, fixture transmissions (valid + each conditional failure case) as tests.

## 15. Future / deferred

- **Active conformance harness** (§4): a test-campaign mode that returns controlled error
  responses and measures retry count, backoff shape, `Retry-After` adherence, and
  abandon-on-permanent-failure.
- **Guided retransmission scenarios** (§5).
- **Production-endpoint mode** (real data): retention, PII, sovereignty, and split-token auth.
- **Standard-revision proposals** (upstream, for the next WHO-stewarded revision): make
  `schemaVersion` an explicit opaque bare-semver token decoupled from hosting; state that receivers
  MUST NOT dereference the schema at validation time and SHOULD pre-register; mechanically link
  `$id` and `schemaVersion` (one version string); publish an out-of-band manifest with a content
  hash per version; fix the stale `0.1.1` example. Tracked in beads.
