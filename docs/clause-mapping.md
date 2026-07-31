# Requirement clause mapping: 2025 requirements ↔ PQS E006 DS01.3

**Status:** reference material. **Last updated:** 2026-07-31.

This project's requirement IDs (`1.1` … `5.3`, stored in `finding.requirement`,
rendered throughout the dashboard, and enumerated in
`src/api/compliance-matrix.ts`) come from:

> *Interoperable CCE Data Delivery — REQUIREMENTS*, 30 March 2025
> (`docs/Interoperable CCE Data Delivery - REQUIREMENTS - 20250330 .pdf`)

The forthcoming **WHO/PQS/E006/DS01.3** rewrites Clause 5 and renumbers every
requirement into `5.1.x` / `5.2.x` / `5.3.x` / `5.4.x`. Source of truth for the
new text:

> `../WHO_PQS_E006_EMS_specifications/data_delivery/Draft PQS E006 DS01.3 revision 26-Jun-2026 rth1 bm1.docx`

**Decision (2026-07-31): the internal IDs stay on the 2025 numbering for now.**
Suppliers hold the 2025 document; DS01.3 is still an unreleased draft (its own
header reads `E006/DS01.2` and its revision history is self-inconsistent).
Renumbering would have to migrate stored `finding.requirement` values, the
27-row matrix, `requirementReference.ts`, and every dashboard label at once.
DS01.3 is expected to publish soon, so treat this table as the bridge —
it exists so the eventual switch is mechanical rather than archaeological.

Quoted DS01.3 text below is the **changes-accepted** reading of the draft, not
the redline.

---

## Forward map: 2025 → DS01.3

| 2025 | Summary | DS01.3 | Change |
|------|---------|--------|--------|
| 1.1 | UTF-8 JSON via HTTPS POST | 5.1.3 | Merged with 1.2 into one clause |
| 1.2 | `Content-Type` header | 5.1.3 | Merged into 5.1.3; no standalone clause |
| 1.3 | Auth: token header or Basic | **5.1.5** | **+Bearer (RFC 6750)** — three methods; RFC 7617 cited for Basic; employer specifies method and supplies credentials; "per-country" → "per-employer" |
| 1.4 | Body ≤ 1MB post-encoding | 5.1.6 | Unchanged |
| 1.5 | Expect standard 2xx/4xx/5xx | **5.1.7** | **Expanded**: 2xx = employer accepted responsibility; **3xx must not be auto-followed on POST**; **response body is not authoritative** for success/failure |
| 1.6 | Gzip, no double-encoding | 5.1.8 | Unchanged |
| 1.7 | Custom headers permitted | **5.1.9** | **+constraint**: custom headers "shall not carry information that is required by employers to correctly process the payload" |
| 1.8 | No duplicates except allowed conditions | **5.1.10** | **should → shall.** Three exception conditions unchanged |
| 2.1 | Serial delivery by default | 5.2.1 | "concurrency limit" → "rate-limiting strategy" |
| 2.2 | Batching; ideally within minutes | 5.2.2 | Unchanged ("remote data system" → "supplier's platform") |
| 2.3 | Alarms ≤ 15 min, incl. data since last attempt | 5.2.3 | **Unchanged** — the "include all data since the last attempted transmission" duty was already in the 2025 text |
| 3.1 | Adopt DS01 objects + transmission meta fields | **5.3.3** | See [§3.1 detail](#31--513-metadata-table) below — several changes |
| 3.2 | Validates against the schema | **5.3.2** | **Precedence rule removed** — see [§3.2 detail](#32--532-precedence) below |
| 3.3 | Transmit all collected objects | 5.3.4 | "objects they collect" → "objects they recorded" |
| 3.4 | Preserve logger time resolution | 5.3.6 | "recorded on the logger" → "on the monitoring device" (covers RTMD) |
| 4.1 | Retry on non-2xx | **5.4.1** | Restated as "receive an HTTP **4xx or 5xx**, **or no response** (connection failure or timeout)". 3xx moves to 5.1.7 |
| 4.2 | ≥6 retries / 24h, non-blocking | 5.4.1 | Unchanged; folded into 5.4.1 |
| 4.3 | Abandon on permanent failures | **5.4.1** | **should → shall not retry.** Code list **unchanged** (501, 505, all 4xx except 404/408/409/429) |
| 4.4 | Backoff strategy + describe to employer | 5.4.2 | Unchanged |
| 4.5 | 429 `Retry-After`, longer of the two | 5.4.2 | Merged into 5.4.2; unchanged |
| 4.6 | Log failed attempts | 5.4.3 | Unchanged |
| 4.7 | Email contact + SLA | 5.4.5 | Unchanged |
| 4.8 | Monitor transmission status | 5.4.6 | Unchanged |
| 4.9 | Notify staff/employer on elevated failures | 5.4.7 | Unchanged |
| 5.1 | Retransmit last 6 months | 5.4.4 | Merged into one clause; **"manually"** added — no API obligation |
| 5.2 | Filter retransmit by time range | 5.4.4 | Merged into 5.4.4 |
| 5.3 | Filter all vs never-sent | 5.4.4 | Merged into 5.4.4 |

## Reverse map: DS01.3 clauses with no 2025 equivalent

| DS01.3 | Requirement | Note |
|--------|-------------|------|
| 5.1.1 | Data access — employer has exclusive rights over who may access hosted data | Inherited from DS01.2 prose |
| 5.1.2 | Transmission of data; **alternate transports** (MQTT, AMQP, WebSockets) permitted by mutual agreement, HTTPS must remain available | Inherited from DS01.2 prose |
| 5.1.11 | **Frequency: within 24 hours** of receipt, best-effort | **New outer bound.** Does *not* replace 5.2.2's "ideally within a few minutes" — that survives verbatim |
| 5.1.12 | Pull API permitted but does not satisfy the push obligation; if implemented must serve Annex-4-compliant JSON | New |
| 5.3.1 | General payload contents (country, device, manufacturer identification, all objects/alarms/errors) | Inherited from DS01.2 prose |
| 5.3.5 | **Manufacturer-specific data objects** must be described by a schema carried in `meta.customDataSchema` | New; depends on the new metadata field |

## Dropped with no successor

**Attachment 2 — Country Guidance** (2025 document) has no DS01.3 counterpart:
DS01.3 is supplier-facing only. Attachment 2 is the source of this project's
400-vs-422 response-code selection, the valid-certs / no-supplier-installed-
intermediates edge requirement (`DESIGN.md` §4.1), the 503-vs-429 overload
guidance, "accept and gracefully handle duplicate data", and "do not expect
in-order delivery". **Keep citing the 2025 document for these** — they are not
in DS01.3 and will not be.

---

## Clause-level detail

### 3.1 → 5.1.3 metadata table

The five metadata fields (`transferId`, `transferSrc`, `transferType`,
`schemaVersion`, `transferredAt`) survive, with these changes:

- **`meta.customDataSchema` added** — required only when the payload contains
  manufacturer-specific data objects. By reference: a versioned, immutable URL.
  Inline: a JSON schema bearing a versioned `$id`. An array is permitted.
  **Not present in `cce-interop-0.8.1.json`.**
- **Location made explicit** — the fields "reside in the transmission envelope
  (`meta`)". The 2025 document never said where they lived. This is the one
  place §3.1 acquires meaning independent of §3.2's schema check.
- **`transferredAt` tightened** — 2025: "ISO8601 format with explicit timezone
  offset". DS01.3: **UTC, RFC 3339, with the `Z` specifier, zero offset**. A
  previously-conformant `+05:30` is no longer conformant.
- **`transferType` should → shall** for the `ems` / `rtm` selection.
- **`schemaVersion` decoupled from `$id`** — the phrase "located in the `$id`
  field of the transmission schema" is gone; it now reads "from Annex 4".
  Together with the example moving `0.1.1` → `0.7.2`, this resolves two of the
  five upstream proposals tracked in `cce-data-delivery-validator-ven`.
- **`DLST` is deliberately absent.** A `DLST` row (map of CCE performance
  properties to RTMD sensor details) was inserted into this table in Nov 2025
  and removed 2026-06-25. This is a **scoping decision, not an oversight**:
  `DLST` concerns RTMDs, which have their own specification (E006/TR03), so it
  is being coupled to upcoming RTMD spec revisions instead. **`DLST` has not
  been removed from the JSON schema and will not be** — continue to validate it.
- Annex renamed: "Attachment 1: Schema for Interoperable CCE Data Transmission"
  → **"Annex 4: Schema for Interoperable CCE Data Transmission"**.

### 3.2 → 5.3.2 precedence

2025 §3.2 ended: *"If there are discrepancies between this document and the JSON
schema published in Attachment 1, **the JSON schema shall take precedence**."*

DS01.3 §5.3.2 replaces that with: *"…**the supplier shall notify the employer of
any discrepancies**."* The phrase "take precedence" appears **zero times** in the
DS01.3 draft. The new text imposes a notification duty and supplies no tiebreaker.

**Decision (2026-07-31): this project keeps schema-precedence as its internal
grading rule regardless.** A schema is less ambiguous than prose and will prevail
as a practical matter of enforcement. A supplier who believes the schema
contradicts the requirements text should resolve that through PQS channels — not
by expecting the validator to grade against prose. See `CLAUDE.md`.

The Annex 1 carve-out is unaffected: for **data-object bounds and units**,
Annex 1 remains authoritative over the schema.
