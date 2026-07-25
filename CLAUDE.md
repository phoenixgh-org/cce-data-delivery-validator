# CLAUDE.md

Instructions and orientation for AI agents working on the **CCE Data Delivery Validator**.

## Project overview

WHO/PQS **E006/DS01, Clause 5** obliges CCE data suppliers (RTMD and EMS
manufacturers/resellers) to deliver performance data to the countries that own
the equipment. PQS test labs prequalify the *equipment* but never test the *data
delivery* implementation — so suppliers self-grade today.

This project is a **public service that plays the employer/country (receiving)
side** of that interface, plus a web dashboard giving suppliers an independent
read on their conformance, "to the extent possible" from the receiving vantage
point.

It is the **ingest gatekeeper** in the pipeline: `ems-data-simulator` (producer)
→ **this project** (conformance) → `ColdchainDB` (store + query) → `cce-mdm`
(device identity). See `../CLAUDE.md` for the workspace-wide map and glossary.

**`DESIGN.md` is the authority on scope and locked decisions** — read it before
proposing architecture changes. Highlights: passive validation only in v1
(no active 429/503 probing, no guided retransmission scenarios); synthetic
test/sandbox data only, never real CCE data or PII; capability-URL onboarding
with no signup, where a single UUID is both the ingest path and the dashboard
key; 7-day retention after POST inactivity.

## Important references

| Location | Content |
|----------|---------|
| `DESIGN.md` | Scope, locked decisions, ingest pipeline, verifiability matrix. Start here. |
| `docs/cce-interop-0.8.x.json` | Vendored transmission JSON Schema (draft-07). See the schema-drift warning below. |
| `docs/Interoperable CCE Data Delivery - REQUIREMENTS - 20250330 .pdf` | The prose requirements from the Q1 2025 UNICEF consultation. |
| `../WHO_PQS_E006_EMS_specifications` | **Authoritative** source for the spec and schema: PQS E006 DS01 PDF, the draft DS01.3 `.docx`, the Annex-1 data-object spreadsheet, and the schema authoring folder under `data_delivery/`. |
| `../ems-data-simulator` | Produces `cce-interop`-conformant EMS/RTMD payloads with realistic faults and edge values. The first producer to deliver here; the two evolve together. |
| `../ColdchainDB` | Downstream store/query layer. Reuses this project's schema and validation logic on its ingest path, and treats `db/initdb/*.sql` as the house DB-schema style. |

**When prose and schema disagree, the schema wins** (requirement §3.2) — except
for data-object bounds and units, where Annex 1 is authoritative over the schema.

**Schema drift warning.** The vendored `cce-interop-*.json` copies here have
diverged from the authoring folder — as of 2026-07-25 `src/schemas/cce-interop-0.8.1.json`
still carries `$id`/`schemaVersion` of `0.8.0` inside a file named `0.8.1`. Diff
against `../WHO_PQS_E006_EMS_specifications/data_delivery/schemas/` before
trusting a vendored copy, and flag disagreements rather than silently
"correcting" them — reconciliation is a spec decision.

## Issue tracking

This project uses **bd (beads)**. `bd prime` is auto-injected at session start
(`.claude/settings.json` `SessionStart`/`PreCompact` hooks) and is the
authoritative, always-current workflow reference — run it manually if you need
it mid-session.

- Use `bd` for task tracking, not TodoWrite or markdown TODO lists.
- Use `bd remember` / `bd memories` for durable knowledge, not MEMORY.md files.
- `bd ready` to find work, `bd update <id> --claim`, `bd close <id>`.
- Land the plane: file follow-ups, run quality gates, and commit before
  considering work done. This repo has **no remote yet**, so there is nothing to
  push to.

## Build & test

```bash
npm install
docker compose up -d postgres   # Postgres 16; db/initdb/*.sql runs on first boot
npm run dev                     # tsx watch src/index.ts
npm test                        # tsx --test "src/**/*.test.ts"
npm run lint                    # eslint + prettier --check
npm run build                   # tsc + copy-schemas + web typecheck + vite build
```

## Architecture

```
                 ┌──────────────────────────────────────────────┐
   Supplier      │                  Service                      │
   system        │                                               │
   ──POST data──▶│  /i/{uuid}   ── ingest pipeline ──▶ findings  │
                 │                                       │       │
                 │                                       ▼       │
   Supplier      │  /d/{uuid}   ◀── dashboard API ──  datastore  │
   browser ─────▶│  web UI (create endpoint, view report,        │
                 │           opt into §1.3 auth)                 │
                 └──────────────────────────────────────────────┘
```

- `src/ingest/` — `POST /i/{uuid}`: the pipeline (`pipeline.ts`, `stages/`),
  concurrency tracking, and response-code selection.
- `src/api/` — dashboard API: sessions, scope, signatures, source, and the
  compliance/verifiability matrix.
- `src/db/` — `pg` pool and repository. DDL lives in `db/initdb/*.sql`,
  numbered and heavily commented (`10-session`, `20-transmission`,
  `30-finding`, `40-indexes`).
- `src/web/` — React + Vite dashboard (landing page, per-session report).
- `src/schemas/` + `schema-registry.ts` — vendored schema versions.

## Conventions

- **Node 20+ / TypeScript end-to-end**, ESM (`"type": "module"`). Fastify for
  HTTP, **Ajv** for JSON-schema validation, React + Vite for the dashboard.
- **Tests colocate** with source as `*.test.ts` and run on the Node test runner
  via `tsx --test` — not Jest or Vitest.
- **Schemas are vendored and pinned by content hash, never fetched at runtime.**
  `schemaVersion` is a bare-semver opaque registry key. Adding a version means
  registering the blessed bytes, not editing an existing file in place.
- **DDL is ordered and commented** — new schema goes in a new numbered file.
- Findings are the output unit: be explicit about what the receiving side can
  and cannot prove. `DESIGN.md` §7 is the verifiability matrix — respect the
  "cannot prove passively" column rather than inventing confident verdicts.
