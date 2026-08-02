# Contributing

Thanks for taking an interest. This is a small project with a few conventions you
cannot guess from the code — they are all listed below. `DESIGN.md` is the
authority on scope and locked decisions; read it before proposing an
architectural change.

## Issues

Use **GitHub issues** on this repository. (Internally the project tracks work in
`bd` (beads), a local issue database — which is why commit messages carry ids
like `(dkz.15)`. You do not need it to contribute, and there is nothing for you
to file there.)

## Setup

Node **20+**, TypeScript and ESM end to end. Postgres 16 comes from compose.

```bash
npm install
docker compose up -d postgres   # db/initdb/*.sql runs on FIRST boot of the volume
npm run dev                     # tsx watch src/index.ts, API on :3000
```

## Gates

All four must be green before a commit:

```bash
npm run lint       # eslint + prettier --check (prettier covers markdown too)
npm test           # pure-logic subset — see the warning below
npm run test:db    # the full suite, against the compose-local Postgres
npm run build      # tsc + copy-schemas + web typecheck + vite build
```

**`npm test` without a database is not a full run.** The suites that need
Postgres probe it once and skip themselves entirely when it is unreachable, so a
bare `npm test` is green with ~51 skips and the whole persistence and
ingest-integration layer never executed. `npm run test:db` is the same suite with
`DATABASE_URL` preset; it must report **zero skips**. CI
(`.github/workflows/ci.yml`) runs against a real Postgres and **fails on any
skip**.

If you see skips under `test:db`, the database is unreachable — or its schema
predates a DDL file, since `db/initdb/` is applied only on first boot. Apply the
missing file by hand, or `docker compose down -v` and let it re-initialize.

## Conventions

- **Tests colocate** with their source as `*.test.ts` and run on the **Node test
  runner** via `tsx --test` — not Jest, not Vitest. Follow the surrounding style
  (`node:test` + `node:assert/strict`).
- **DDL is append-only.** New schema goes in a **new numbered file** under
  `db/initdb/` (`10-session.sql`, `20-transmission.sql`, …), commented in the
  house style. Never edit an existing numbered file in place — deployed databases
  applied it on first boot and will never see the edit.
- **Schemas are vendored and pinned by content hash, never fetched at runtime.**
  `src/schemas/cce-interop-*.json` is the only copy in this repo, registered in
  `src/schema-registry.ts`. Adding a version means registering the blessed
  upstream bytes as a new file; it never means editing an existing one.
  `schemaVersion` is an opaque registry key, and the `$id` inside a schema is an
  **identifier, not a download location** (`DESIGN.md` §9).
- **Where prose requirements and the JSON schema disagree, the schema wins** —
  except for data-object bounds and units, where E006/DS01 Annex 1 is
  authoritative over the schema. See `docs/clause-mapping.md` for why this house
  rule outlives its original citation.
- **Findings are the output unit, and honesty about them is the point.**
  `DESIGN.md` §7 is the verifiability matrix; respect its "cannot prove
  passively" column rather than inventing a confident verdict.
- **Synthetic data only**, in tests and fixtures as well as in the service. Never
  commit real facility, device, or personal data. See `SECURITY.md`.

## Pull requests

Keep the change scoped to one thing, state which requirement or design section it
touches, and say how you verified it. Contributions are accepted under the
project's [MIT license](LICENSE).
