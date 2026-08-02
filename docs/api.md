# HTTP API reference

**Status:** integrator documentation. **Last updated:** 2026-08-01.

Everything this service exposes over HTTP, for a supplier integrating **server-side**
— sending transmissions from their own stack and reading results programmatically,
without clicking through the dashboard.

The authority on behaviour is `DESIGN.md`: §5 (onboarding), §6 (ingest pipeline and
response codes), §7 (verifiability matrix), §8 (data model), §11 (retention). This
document describes the routes as they are implemented.

> ### ⚠ Synthetic test data only
>
> This is a sandbox. Send synthetic or test payloads only — **never** real facility,
> device, or personal data, and never point a live CCE fleet at it. The endpoint URL
> is a **bearer capability**: the UUID in the path is the only secret, it is the same
> UUID for ingest and for reading everything back, and URLs leak through logs,
> proxies, and browser history. Every ingest response repeats this warning in its
> `notice` field. Receiving real production data is an explicit non-goal
> (`DESIGN.md` §2, §12).

## Base URL

**Hosted instance:** _URL to be announced._ Examples below use a placeholder:

```bash
BASE=https://<host>          # or http://localhost:3000 for a local run
```

Nothing in the API is versioned by path, and no route returns an absolute URL: the
public origin belongs to the reverse proxy, so `POST /api/sessions` hands back
**relative** paths (`/i/{uuid}`, `/d/{uuid}`) for the caller to join to its own base.

## Route index

| Method   | Path                                | Purpose                                              | Authorization                          |
| -------- | ----------------------------------- | ---------------------------------------------------- | -------------------------------------- |
| `POST`   | `/api/sessions`                     | Mint a test endpoint (session)                       | none — open                            |
| `POST`   | `/i/{uuid}`                         | Ingest one transmission; returns findings            | session UUID + opt-in §1.3 credential  |
| _any_    | `/i/{uuid}`                         | Anything but `POST` is rejected `405`                | —                                      |
| `POST`   | `/api/sessions/{uuid}/auth`         | Enable (or rotate) the §1.3 credential               | session UUID                           |
| `DELETE` | `/api/sessions/{uuid}/auth`         | Disable §1.3 auth and clear the credential           | session UUID                           |
| `DELETE` | `/api/sessions/{uuid}/data`         | **Destructive** — purge all captured data            | session UUID                           |
| `GET`    | `/api/sessions/{uuid}`              | Session report: findings, §7 matrix, aggregates      | session UUID                           |
| `GET`    | `/api/sessions/{uuid}/transmissions` | Paginated, filterable transmission list               | session UUID                           |
| `GET`    | `/health`                           | Liveness probe                                       | none — open                            |

There is **no route that deletes a session itself**. `DELETE /api/sessions/{uuid}`
is not registered and returns `404`; sessions disappear only via the retention sweep
(see [Retention](#retention)).

`/d/{uuid}` is the browser dashboard, not an API route. It is served by the same
process as static SPA files when a web build is present; it reads the same JSON the
`GET /api/sessions/*` routes return.

## Conventions

- **Possession of the UUID is the entire authorization model.** Anyone holding it can
  POST data, read every transmission and finding, enable or disable §1.3 auth, and
  purge captured data. There are no accounts, no passwords, and no way to recover or
  revoke a leaked UUID — mint a fresh session instead.
- All responses are JSON (`application/json`). Ingest responses are JSON on **every**
  status code, including the rejections.
- **Body limit:** the server buffers at most **2 MiB** of request body on any route.
  Beyond that, the framework's own `413` fires before the request reaches any handler
  and **nothing is recorded** — a different response shape from the graded `413`
  described under [Ingest](#post-iuuid--ingest-a-transmission).
- Request bodies are read as raw bytes and parsed per-route, so exact wire bytes are
  preserved for §1.4 measurement. A consequence: on `POST /api/sessions/{uuid}/auth`
  the JSON body is parsed regardless of the `Content-Type` you send.
- An unregistered path under `/api`, `/i`, or `/health` returns the framework's
  default shape:
  `{"statusCode":404,"error":"Not Found","message":"Route GET:/api/nope not found"}`.
  Other `GET` paths are served the dashboard SPA when a web build is present, so do
  not treat an HTML response as an API error.
- Unknown query-parameter values on the `GET` routes **fall back to defaults rather
  than failing** — the dashboard stays resilient; those routes never return `400`.

## `POST /api/sessions` — mint a test endpoint

Creates a session. Takes **no request body** (any body sent is ignored), needs no
headers, and requires no authorization: this is the open front door.

**`201 Created`**

```json
{
  "uuid": "36bec795-a29f-4ad4-aa64-bcef9da69c42",
  "ingestUrl": "/i/36bec795-a29f-4ad4-aa64-bcef9da69c42",
  "dashboardUrl": "/d/36bec795-a29f-4ad4-aa64-bcef9da69c42"
}
```

| Field          | Meaning                                                          |
| -------------- | ---------------------------------------------------------------- |
| `uuid`         | The capability secret. Both the ingest path and the dashboard key. |
| `ingestUrl`    | Relative path to POST transmissions to.                          |
| `dashboardUrl` | Relative path of the browser report.                             |

The session starts with **auth disabled** (zero-friction default, `DESIGN.md` §3).

```bash
curl -sX POST "$BASE/api/sessions"
```

## `POST /i/{uuid}` — ingest a transmission

The endpoint under test. One POST = one transmission = one graded row.

### Request

| Header             | Expected                                             | Effect                                                                              |
| ------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `Content-Type`     | `application/json; charset=utf-8` (§1.2)             | A missing header, a non-JSON media type, or a missing/incorrect charset is a §1.2 **fail** finding — but never a rejection; the pipeline continues. |
| `Content-Encoding` | absent, `identity`, or `gzip` (§1.6)                 | `gzip` bodies are decompressed (bounded at 1 MiB decompressed, as a zip-bomb guard). Any other token, a body that will not gunzip, or gzip-inside-gzip is a §1.6 fail + `400`. |
| §1.3 credential    | only when the session has opted in                   | See [Authorization](#post-apisessionsuuidauth--enable-or-rotate-13-auth) for the per-method header.                                               |

Body: the `cce-interop` transmission JSON. `meta.schemaVersion` selects the validating
schema; **`0.8.1` is the only registered version**, and any other value is a `422`
listing what is supported (never a silent fallback).

The §1.4 cap is **1 MiB of wire bytes, measured after content-encoding** — the bytes
actually transmitted, not the decompressed size.

### Status codes

The response code is part of what this service teaches, so the full table is below.
"Row recorded" means the transmission is persisted and shows up in the dashboard and
the `GET` routes.

| Status | Raised by                | Condition                                                                                       | Row recorded | Body shape           |
| ------ | ------------------------ | ----------------------------------------------------------------------------------------------- | ------------ | -------------------- |
| `200`  | pipeline completed       | The body parsed and validated; semantic checks never reject. **Data accepted.**                 | yes          | ingest response      |
| `400`  | stage 5 — Content-Encoding | Unsupported encoding, undecodable gzip, or illegal double-encoding (§1.6).                     | yes          | ingest response      |
| `400`  | stage 6 — JSON parse      | Body is not valid UTF-8 JSON (§1.1). Non-UTF-8 bytes fail here too, before `JSON.parse`.        | yes          | ingest response      |
| `401`  | stage 2 — auth            | The session opted into §1.3 and the credential is absent, malformed, wrong scheme, or wrong.    | yes          | ingest response      |
| `404`  | stage 0 — session         | No such session UUID (unknown, or already purged/expired).                                      | no           | ingest response      |
| `405`  | stage 1 — method          | Any method other than `POST` on `/i/{uuid}` — `GET`, `HEAD`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`. | no          | ingest response      |
| `413`  | stage 3 — size            | Wire body over the 1 MiB §1.4 cap (and within the 2 MiB server ceiling): a **teaching** 413.    | yes          | ingest response      |
| `413`  | framework                | Body over the 2 MiB server ceiling — rejected before any handler.                               | no           | framework error      |
| `422`  | stage 7 — schema          | `meta.schemaVersion` missing/not a string, an unsupported version, or Ajv validation failed.    | yes          | ingest response      |

Notes on the table:

- **`405` beats `404`.** The method check runs before the session lookup, so a non-POST
  to an unknown UUID returns `405`, not `404`. (`DESIGN.md` §6 numbers session as
  stage 0 and method as stage 1; the implementation deliberately reverses them so a
  non-POST never touches the database. Neither persists a row, so nothing else about
  the outcome changes.)
- **A `401` is graded, not just refused.** It carries a §1.3 fail finding and a
  persisted row, unlike the `404`/`405` rejections which are not checks of the
  supplier and record nothing.
- **Content-Type never rejects.** `DESIGN.md` §6 marks `415` optional; the
  implementation does not use it — a bad `Content-Type` is a §1.2 finding and the
  pipeline continues.
- **A `200` is the only success code.** There is a single success status and `202`
  is never returned (`DESIGN.md` §6).
- The framework `413` body is
  `{"statusCode":413,"code":"FST_ERR_CTP_BODY_TOO_LARGE","error":"Payload Too Large","message":"Request body is too large"}`
  — the one ingest response that is not the shape below. An unexpected server fault
  would likewise surface as a framework `500`, not as an ingest response.

### Response body

The same shape on success and on rejection, so a `4xx` is as self-explanatory as a
`2xx` (`DESIGN.md` §6 teaching surface).

```json
{
  "transmissionId": "68d04f41-60f8-4a7c-ab13-6def35acb489",
  "status": 200,
  "message": "Accepted (200): data recorded; 9 findings (2 info).",
  "findings": 9,
  "findingDetails": [
    {
      "requirement": "1.2",
      "severity": "pass",
      "detail": "Content-Type is application/json; charset=utf-8 (§1.2)"
    },
    {
      "requirement": "3.2",
      "severity": "fail",
      "detail": "schema violation at /data/0: must have required property 'AMID' (§3.2)"
    }
  ],
  "notice": "Synthetic test data only: this is a sandbox endpoint. …"
}
```

| Field            | Type                | Meaning                                                                                     |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------- |
| `transmissionId` | `string \| null`    | Id of the persisted row; `null` on the `404`/`405` rejections, which record nothing.        |
| `status`         | `number`            | Same as the HTTP status.                                                                    |
| `message`        | `string`            | One-line summary: `Accepted (200): data recorded; N findings (…)` or `Rejected (NNN): …`, with the fail/info tally. |
| `findings`       | `number`            | Count of findings recorded for this transmission.                                           |
| `findingDetails` | `array`             | Each `{ requirement, severity, detail }`. `severity` is `pass`, `fail`, or `info`. The JSON pointer and structured signature fields are omitted here — read them from the dashboard routes. |
| `notice`         | `string`            | The standing synthetic-data-only warning, on every response.                                |

Findings appear in pipeline order (auth, size, content-type, encoding, parse, schema,
then the semantic checks), so a schema failure yields one entry per Ajv error.

`findingDetails` includes **passes**, not just problems: §1.4 within the cap, §1.2 an
exact media type, §3.2 validated against the pinned schema, and so on. That is what
makes a gradeable requirement move off `untested` in the §7 matrix.

### Example

```bash
curl -isX POST "$BASE/i/$UUID" \
  -H 'Content-Type: application/json; charset=utf-8' \
  --data-binary @transmission.json

# gzip:
gzip -c transmission.json | curl -isX POST "$BASE/i/$UUID" \
  -H 'Content-Type: application/json; charset=utf-8' \
  -H 'Content-Encoding: gzip' --data-binary @-
```

## `POST /api/sessions/{uuid}/auth` — enable or rotate §1.3 auth

Turns on the opt-in §1.3 authorization layer so that requirement becomes gradeable.
The service generates the credential, stores **only a salted hash**, and returns the
plaintext **exactly once** — it cannot be read back later. Re-POSTing **rotates** the
credential: a fresh secret is minted and the old one stops working immediately.

Authorization for this route is the session UUID alone — including when auth is
already enabled. Holding the UUID is enough to rotate the credential.

### Request

All fields are optional; an absent or empty body is valid and means "header method
with defaults". The body is parsed as JSON regardless of `Content-Type`.

```json
{ "method": "header", "headerName": "X-CCE-Token", "username": "cce" }
```

| Field        | Applies to      | Default        | Meaning                                              |
| ------------ | --------------- | -------------- | ---------------------------------------------------- |
| `method`     | —               | `header`       | One of `header`, `basic`, `bearer`.                  |
| `headerName` | `header` only   | `X-CCE-Token`  | The header the token must ride in.                   |
| `username`   | `basic` only    | `cce`          | The Basic-auth username (not secret).                |

`bearer` (RFC 6750) has nothing configurable: the header is always `Authorization` and
`headerName`/`username` are ignored. An **unrecognised** `method` is rejected rather
than silently defaulted — a supplier who asks for a method that is not implemented
must not be told auth was configured the way they asked.

### Responses

**`201 Created`** — three arms, one per method. The plaintext is shown once.

```jsonc
// method: "header"
{ "uuid": "…", "auth_enabled": true, "auth_method": "header",
  "auth_header_name": "X-CCE-Token", "token": "73c7d993…" }

// method: "bearer"  — auth_header_name is always the literal "Authorization"
{ "uuid": "…", "auth_enabled": true, "auth_method": "bearer",
  "auth_header_name": "Authorization", "token": "e3cee0ce…" }

// method: "basic"   — note the different field names
{ "uuid": "…", "auth_enabled": true, "auth_method": "basic",
  "username": "acme", "password": "d65bc158…" }
```

| Status | Body                                                        | When                                     |
| ------ | ----------------------------------------------------------- | ---------------------------------------- |
| `201`  | one of the three arms above                                 | auth enabled (or rotated)                |
| `400`  | `{"error":"invalid_json"}`                                  | a non-empty body that is not JSON        |
| `400`  | `{"error":"invalid_method","allowed":["header","basic","bearer"]}` | `method` present but unrecognised |
| `404`  | `{"error":"not_found","uuid":"…"}`                          | unknown session                          |

### Sending the credential to `/i/{uuid}`

| Method   | Request header                                             |
| -------- | ---------------------------------------------------------- |
| `header` | `<auth_header_name>: <token>` (default `X-CCE-Token: …`)   |
| `bearer` | `Authorization: Bearer <token>`                            |
| `basic`  | `Authorization: Basic base64(username:password)`           |

The scheme token is matched case-insensitively (RFC 9110 §11.1). Because `basic` and
`bearer` share the `Authorization` header, presenting the *wrong scheme* is a distinct
failure from presenting the wrong token, and the §1.3 finding says which.

While auth is **disabled**, every transmission still records a §1.3 `info` finding
noting the requirement was not enforced — so the matrix shows `untested` rather than a
false pass.

## `DELETE /api/sessions/{uuid}/auth` — disable §1.3 auth

Clears the stored credential and turns the auth layer off. **Possession of the UUID is
the only authorization** — the current credential is not required, so anyone holding
the URL can switch enforcement off.

**`200 OK`**

```json
{ "uuid": "…", "auth_enabled": false, "auth_method": null }
```

**`404`** — `{"error":"not_found","uuid":"…"}` for an unknown session.

## `DELETE /api/sessions/{uuid}/data` — purge captured data

> **Destructive and irreversible.** This deletes every transmission recorded for the
> session, and their findings with them. There is no confirmation step, no undo, and
> **no authorization beyond possession of the UUID** — the same URL used to send data
> is the one that erases it.

The session itself **survives**: the ingest URL stays live and the §1.3 configuration
is untouched, so a supplier can restart a test protocol against the same endpoint.

**`200 OK`**

```json
{ "uuid": "…", "deleted": { "transmissions": 3 } }
```

`deleted.transmissions` is the number of rows removed; `0` is a valid no-op on an
already-empty session.

**`404`** — `{"error":"not_found","uuid":"…"}` for an unknown session.

## `GET /api/sessions/{uuid}` — session report

Everything the dashboard renders, pre-aggregated: session metadata, the full
transmission list with findings inlined, and the §7 compliance summary computed over
the selected scope.

### Query parameters

| Param    | Values                   | Default | Meaning                                                       |
| -------- | ------------------------ | ------- | ------------------------------------------------------------- |
| `window` | `15m`, `1h`, `6h`, `all` | `all`   | Time window the aggregates are computed over.                 |
| `source` | a raw source key, `all`  | `all`   | Restrict to one source (`meta.transferSrc`); `""` is the "unknown source" bucket. |

Unrecognised values fall back to the defaults; this route never returns `400`.

### `200 OK`

```jsonc
{
  "session": {
    "uuid": "…",
    "created_at": "2026-08-01T05:50:06.568Z",
    "last_post_at": "2026-08-01T05:50:06.722Z",
    "auth_enabled": false,
    "auth_method": null
  },
  "transmissions": [ /* every transmission, newest first — see the row shape below */ ],
  "summary":   [ /* 27 §7 matrix rows joined with live counts */ ],
  "rollup":    { "total": 27, "gradeable": 10, "passing": 7, "failing": 0, "untested": 3 },
  "signatures": [ /* distinct defects, most widespread first */ ],
  "trend":     [ { "tot": 1, "fail": 0, "rate": 1 } /* 30 buckets, or [] when empty */ ],
  "sources":   [ { "source": "com.example", "sourceCode": "EXA", "sourceLabel": "com.example", "count": 1 } ],
  "scoped":    { "scoped": 1, "withFailures": 0, "distinctIssues": 0 },
  "expiresAt": "2026-08-08T05:50:33.722Z"
}
```

The stored credential hash is never returned — only `auth_enabled` and `auth_method`.

`transmissions` is **not** scoped by `window`/`source` (the full list ships for the
detail pane); `summary`, `rollup`, `signatures`, `trend`, and `scoped` **are**.
`sources` is computed over the window only, so every source's in-window count is
visible whichever one is selected. For large sessions, page the list through
[`/transmissions`](#get-apisessionsuuidtransmissions--paginated-transmission-list)
instead.

**`404`** — `{"error":"not_found","uuid":"…"}` for an unknown session.

### Transmission object

Identical on this route and on the paginated list.

| Field                              | Meaning                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `id`                               | Transmission id — the `transmissionId` the ingest response returned.        |
| `received_at`                      | ISO timestamp.                                                              |
| `http_status`                      | The status this service returned for it.                                    |
| `content_type`, `content_encoding` | Request headers exactly as sent (`null` when absent).                       |
| `wire_bytes`                       | Wire byte count — a **string** (64-bit column).                             |
| `schema_version`                   | Normalized `meta.schemaVersion`, `null` if unresolved.                      |
| `transfer_id`, `transfer_src`      | Lifted from `meta`, `null` when the body never parsed.                      |
| `source`, `sourceCode`, `sourceLabel` | Presentation triple derived from `transfer_src`; blank/absent collapses to `""` / `---` / `Unknown source`. |
| `parse_ok`, `schema_ok`            | `true`/`false`, or `null` when that stage never ran.                        |
| `body`                             | Parsed JSON payload, `null` if it never parsed.                             |
| `raw_body`                         | Drill-down text (gzip-decoded when applicable, NUL-stripped) — kept especially when parsing failed. |
| `findings`                         | The findings for this transmission, ordered by requirement number.          |

### Finding object

```json
{
  "requirement": "3.2",
  "severity": "fail",
  "detail": "schema violation at /data/0: must have required property 'AMID' (§3.2)",
  "pointer": "/data/0",
  "outdated": false,
  "keyword": "required",
  "instancePath": "/data/0",
  "param": "AMID",
  "code": null
}
```

- `severity` — `pass`, `fail`, or `info`.
- `pointer` / `instancePath` — RFC 6901 JSON Pointer into the submitted body; `null`
  for a root-level or non-schema finding.
- `outdated` — `true` only on the §3.2 info finding for a valid-but-older schema
  version.
- `keyword` / `param` — Ajv's defect class and its identifying parameter (the missing
  property, the expected format, the limit …) — never the offending value. `null` for
  non-schema findings.
- `code` — a stable identifier for transport and heuristic findings; `null` for schema
  findings, which are identified by `keyword` instead. §1.3 auth findings and pure
  `info` observations carry neither.

| `code`                          | Req   | Raised when                                          |
| ------------------------------- | ----- | ---------------------------------------------------- |
| `tx.bad_media_type`             | §1.2  | `Content-Type` missing or not `application/json`     |
| `tx.missing_charset`            | §1.2  | JSON media type without `charset=utf-8`              |
| `tx.body_too_large`             | §1.4  | Wire body over the 1 MiB cap                         |
| `tx.unsupported_encoding`       | §1.6  | `Content-Encoding` other than `gzip`/`identity`      |
| `tx.undecodable_body`           | §1.6  | gzip body would not decompress (or exceeded the cap) |
| `tx.double_encoded`             | §1.6  | gzip inside gzip                                     |
| `tx.parse_failed`               | §1.1  | Body is not valid UTF-8 JSON                         |
| `tx.missing_schema_version`     | §3.2  | `meta.schemaVersion` absent or not a string          |
| `tx.unsupported_schema_version` | §3.2  | Declared version is not registered                   |
| `tx.schema_invalid`             | §3.2  | Validation failed with no per-error detail           |
| `tx.outdated_schema`            | §3.2  | Valid, but against an older registered version (info)|
| `tx.duplicate_transfer`         | §1.8  | Repeated `transferId` or identical content           |
| `tx.concurrent_delivery`        | §2.1  | Another POST for this session was in flight          |
| `tx.irregular_interval`         | §3.4  | `ABST` reading cadence looks irregular               |
| `tx.missing_custom_schema`      | §3.1  | Custom data objects sent without `meta.customDataSchema` |

### Compliance summary rows

`summary` is the §7 verifiability matrix — 27 rows, in requirement order — joined with
this session's live counts:

```json
{
  "requirement": "1.1",
  "summary": "HTTPS POST, UTF-8 JSON",
  "classes": ["verified", "enforced"],
  "counts": { "pass": 1, "fail": 0, "info": 0 },
  "status": "pass"
}
```

- `classes` — one or more of `verified` (✅), `heuristic` (🟡), `active-only` (🔌),
  `attestation` (📝), `enforced` (🔒), `none`. The **first** entry drives `status`;
  two rows are split-class (§1.1, §4.4).
- `status` — `pass`, `fail`, `mixed`, `untested` (gradeable, no findings yet — never a
  false pass), `not-exercised` (🔌), `self-attestation` (📝), `enforced` (🔒), or
  `not-applicable`.
- `rollup` counts only **gradeable** rows (primary class `verified` or `heuristic`);
  `failing` folds `mixed` in with `fail`.

Which requirements are graded versus informational is the point of the matrix: see
[`DESIGN.md` §7](../DESIGN.md#7-compliance-engine--verifiability-matrix) for the
row-by-row rationale, and `docs/clause-mapping.md` for how these 2025 requirement
numbers map to the DS01.3 rewrite.

### Signature object

A signature collapses identical defects across transmissions into one distinct issue —
the answer to "what are the distinct things to fix, and how widespread is each?".

| Field            | Meaning                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `key`            | Stable key; pass it as `signatureKey` to the list route to cross-filter. |
| `req`            | Requirement, e.g. `3.2`.                                             |
| `title`          | Human title for the defect.                                          |
| `kind`           | `schema` (Ajv keyword) or `check` (a `tx.*` code).                   |
| `sev`            | `fail`, or `info` for the outdated-schema signature.                 |
| `count`          | Raw finding count.                                                   |
| `txCount`        | Distinct transmissions exhibiting it.                                |
| `sourceCount`    | Distinct sources exhibiting it.                                      |
| `first`, `last`  | ISO timestamps of the earliest and latest occurrence.                |
| `examplePointer` | Representative JSON Pointer, may be `null`.                          |

## `GET /api/sessions/{uuid}/transmissions` — paginated transmission list

The same rows as the summary route, filtered and paged — what to use once a session
holds thousands of transmissions.

### Query parameters

| Param          | Values                          | Default | Meaning                                        |
| -------------- | ------------------------------- | ------- | ---------------------------------------------- |
| `window`       | `15m`, `1h`, `6h`, `all`        | `all`   | Same scope semantics as the summary route.     |
| `source`       | a raw source key, `all`         | `all`   | Exact match on the trimmed `transfer_src`.     |
| `failuresOnly` | `true`, `1`                     | off     | Keep only transmissions with ≥1 `fail` finding.|
| `signatureKey` | a `signatures[].key`            | none    | Keep only transmissions exhibiting that signature. |
| `cursor`       | a prior response's `nextCursor` | none    | Continue after that page.                      |
| `limit`        | integer                         | `50`    | Page size, clamped to `[1, 200]`.              |

Unrecognised values fall back to defaults; a malformed `cursor` simply starts from the
top. This route never returns `400`.

### `200 OK`

```json
{
  "transmissions": [],
  "scoped": 3,
  "nextCursor": "MTc4NTU2MzQwNjcyNjo2OGQwNGY0MS02MGY4LTRhN2MtYWIxMy02ZGVmMzVhY2I0ODk",
  "hasMore": true
}
```

- `transmissions` — one page, newest first, each row the shape described above with
  its findings inlined (no second fetch needed).
- `scoped` — total matching **after all filters**: the denominator for "showing
  {page} of {scoped}".
- `nextCursor` — opaque token for the next page, or `null` when there is none.
- `hasMore` — whether more rows match beyond this page.

**`404`** — `{"error":"not_found","uuid":"…"}` for an unknown session.

```bash
curl -s "$BASE/api/sessions/$UUID/transmissions?window=1h&failuresOnly=true&limit=20"
```

## `GET /health` — liveness

No authorization, no parameters.

**`200 OK`** — `{"status":"ok"}`

It reports that the HTTP server is up; it does not probe the database.

## Retention

A session and everything in it are purged after **7 days without a POST**. The clock
runs from the last POST to `/i/{uuid}` (or from creation if none), and
`GET /api/sessions/{uuid}` returns the deadline as `expiresAt`. Once purged, the UUID
is unknown again: ingest returns `404`, and so do the dashboard routes. Nothing is
recoverable, so pull down anything worth keeping before the window closes
(`DESIGN.md` §11).
