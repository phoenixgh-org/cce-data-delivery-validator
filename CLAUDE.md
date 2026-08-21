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

It is the **ingest gatekeeper** on the receiving side: producers POST
transmissions here, and findings about their conformance are what comes out.

**This repo is public.** Do not reference sibling workspace projects or `../`
paths in this file or elsewhere in the repo; that context belongs in the
workspace-level agent file, which is loaded automatically alongside this one.

**`DESIGN.md` is the authority on scope and locked decisions** — read it before
proposing architecture changes. Highlights: passive validation only in v1
(no active 429/503 probing, no guided retransmission scenarios); synthetic
test/sandbox data only, never real CCE data or PII; capability-URL onboarding
with no signup, where a single UUID is both the ingest path and the dashboard
key; retention keyed to POST inactivity (`RETENTION_MS` in
`src/db/repository.ts` is the single source of truth for the window).

## Important references

| Location | Content |
|----------|---------|
| `DESIGN.md` | Scope, locked decisions, ingest pipeline, verifiability matrix. Start here. |
| `src/schemas/cce-interop-*.json` | Vendored transmission JSON Schemas — the **only** copy in this repo. Registered in `src/schema-registry.ts`; 0.8.1 (JSON Schema 2020-12) is current, and 0.8.0 (draft-07, compiled per-entry with the matching Ajv build) is registered as the deliberate outdated cohort. Registering a further version is a spec decision, not mechanical work — ask before vendoring one. |
| `docs/internal/Interoperable CCE Data Delivery - REQUIREMENTS - 20250330 .pdf` | The prose requirements from the Q1 2025 UNICEF consultation. **Local-only**: `docs/internal/` is gitignored, so it is absent from a fresh clone. |
| WHO PQS E006/DS01 (PQS catalogue) and `https://docs.2to8.cc/cce-data-interop/` | **Authoritative** public sources for the spec, Annex 1 data objects, and the published `cce-interop` schemas. |

**When prose and schema disagree, the schema wins** — except for data-object
bounds and units, where Annex 1 is authoritative over the schema.

This is a deliberate house rule, not a restatement of current spec text: a
schema is less ambiguous than prose and prevails as a practical matter of
enforcement, and a supplier who believes the two conflict should resolve it
through PQS channels rather than expect the validator to grade against prose.
Keep it even where the published spec supplies no tiebreaker. Clause-by-clause
mapping lives in `docs/clause-mapping.md`.

**Schema provenance.** A vendored copy must be byte-identical to the published
artifact. Re-verify before trusting one, and **flag disagreements rather than
silently "correcting" them** — reconciliation is a spec decision.

```bash
curl -sL https://docs.2to8.cc/cce-data-interop/schemas/cce-interop-0.8.1.json | sha256sum
sha256sum src/schemas/cce-interop-0.8.1.json   # must match
```

**The `$id` is not the download location.** Published schemas declare
`$id: https://schemas.2to8.cc/schemas/cce-interop-<version>.json`, but **that
host does not resolve**. The artifact lives at
`https://docs.2to8.cc/cce-data-interop/schemas/cce-interop-<version>.json` —
different host, different path. This is the live proof of DESIGN §9's rule that
`$id` is an *identifier*, never a locator, and that we never fetch at runtime.

## Issue tracking

This project uses **bd (beads)**. `bd prime` is auto-injected at session start
(`.claude/settings.json` `SessionStart`/`PreCompact` hooks) and is the
authoritative, always-current workflow reference — run it manually if you need
it mid-session.

- **`.beads/` is untracked and gitignored**: tracker state is not published to
  this repo. Do NOT commit `.beads/issues.jsonl` or add an export-and-commit
  step (including inside automated loops), and do not install bd's git hooks
  (`bd hooks install`) — they re-stage the export on every commit. bd state
  lives in the local Dolt DB and syncs across machines out of band. Referencing
  bd ids in commit messages and code comments stays fine — they are opaque
  without the tracker.
- Use `bd` for task tracking, not TodoWrite or markdown TODO lists.
- Use `bd remember` / `bd memories` for durable knowledge, not MEMORY.md files.
- `bd ready` to find work, `bd update <id> --claim`, `bd close <id>`.
- Land the plane: file follow-ups, run quality gates, and commit before
  considering work done. The remote is
  `git@github.com:phoenixgh-org/cce-data-delivery-validator.git` (`origin`);
  push only when asked.

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
  `30-finding`, `40-indexes`, `50-session-auth-bearer`).
- `src/web/` — React + Vite dashboard (landing page, per-session report).
- `src/schemas/` + `schema-registry.ts` — vendored schema versions.

## Conventions

- **Node 22+ / TypeScript end-to-end**, ESM (`"type": "module"`). Fastify for
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
- **Commit messages should be clear and concise**
