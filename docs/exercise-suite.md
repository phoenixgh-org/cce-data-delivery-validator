# The conformance exercise suite

**Status:** contributor documentation. **Last updated:** 2026-08-05.

`npm run exercise` drives a **running** validator through every requirement the §7
matrix says we grade, once in the passing direction and once in the failing one,
then checks what came back. This document is its internals: the case model, the
transform vocabulary, how coverage is computed, and how to add a case. The
how-to-run lives in the [README](../README.md#exercising-a-running-instance--npm-run-exercise).

> ### ⚠ Synthetic test data only
>
> Every byte the suite sends is built from its own baseline and transform
> vocabulary. It reads no real CCE data, and it must never be pointed at a session
> holding any (`DESIGN.md` §2, §12). It creates its own session on every run, so
> it never writes into one it did not mint.

The code is `src/exercise/`:

| Path | Role |
|------|------|
| `case.ts` | The case model — what a case may declare, and how a POST is materialized. |
| `baseline.ts` | The pluggable baseline generators (one canonical, schema-valid payload — `rtm` or `ems`). |
| `transforms/payload.ts` | Payload mutators: what is in the body. |
| `transforms/transport.ts` | Transport wrappers: how it goes on the wire. |
| `cases/{transport,payload,sequence}.ts` | The case table, one module per requirement domain. |
| `cases.ts` | The index that concatenates them into `EXERCISE_CASES`. |
| `runner/client.ts` | The only module that opens a socket. |
| `runner/assertions.ts` | Pure grading of a case from statuses + findings. |
| `runner/coverage.ts` | The join onto `COMPLIANCE_MATRIX`. |
| `runner/run.ts` | The CLI: resolve target, play, print, exit code. |

## The case model: data, not code

A case declares what it targets and what should happen; it never carries the logic
that makes it happen. That is what lets two consumers share one definition without
drifting: the live runner, and the colocated unit tests that run in CI where no
server exists.

Each case declares:

- **`requirements`** — `COMPLIANCE_MATRIX` ids, so coverage is a join and not an
  annotation someone has to remember to update;
- **`direction`** — `pass` (a conformant supplier's traffic) or `fail` (traffic the
  validator must catch), plus a `fault` naming the defect when it is a `fail`;
- **`posts`** — an ORDERED list of one or more POSTs, each a set of named transforms
  applied to the baseline plus the HTTP status it should come back with;
- **`expectedFindings`** — the findings the session must show afterwards.

…plus the three **declarative capabilities** below — `setup`, `delivery`, `baseline` —
which say what a case needs, never how to arrange it.

A multi-POST case is how the sequence-dependent heuristics (§1.8 duplicates, §2.1
serial delivery) are exercised without inventing a second mechanism — a single-POST
case is just a list of one.

### Expected findings are presence-based, not exhaustive

The runner pools the findings attributable to a case's POSTs and requires each
expectation to appear at least once, matched on `(requirement, severity)` only.
`detail` is prose the graders may reword, so it is deliberately not part of the
contract; and pooled findings a case does not name never fail it.

Exhaustive matching was considered and rejected: an accepted POST legitimately
accumulates findings the case has no interest in — the §1.2/§1.6/§1.8 passes every
200 earns — so exhaustiveness would make cases brittle against grader evolution
rather than against the defect they target. The accepted cost is that a case cannot
prove a defect did not *leak*; that is a property of the whole session, not of one
case.

Attribution is by **transmission id**: the ingest response names the row it wrote and
the dashboard API reports findings against that same id, so a case's pool is exactly
the findings its own POSTs produced, even though the whole table shares one session.
Expectations pool per case, not per POST. A case may expect **no** findings at all —
a 405 halts before persistence, so the status *is* the grade.

## Two transform families

Payload mutators change **what** is sent; transport wrappers change **how** it is
delivered. Materialization always runs the payload family first and the transport
family second, whatever order a case lists them in — a wrapper operates on the
serialized bytes — and honors declaration order within each family.

| Family | Examples | Reaches |
|--------|----------|---------|
| Payload | `dropRequiredField`, `setInvalidValue`, `setSchemaVersion`, `addCustomDataObject`, `declareCustomDataSchema`, `regularCadence` / `irregularCadence`, `setTransferId`, `addSolarPowerToMainsRecord` / `duplicateVersionStringsIntoRecords` (EMS-only) | §3.1, §3.2, §3.4, §1.8 |
| Transport | `method`, `unparseableBody`, `contentType`, `bearerCredential` / `noAuth` / `badAuth`, `oversize`, `gzip` / `doubleGzip` / `unsupportedEncoding` | §1.1, §1.2, §1.3, §1.4, §1.6 |

Transport wrappers are what reach the §6 halts (405/413/400/401) that short-circuit
the pipeline before any schema work — a suite that only mutated payloads would never
touch them. Each transform is a pure function with a self-documenting `name`
(`dropRequiredField(/data/0/AMID)`), which is what the runner reports.

### `schemaOutcome` is three-way

Every payload mutator declares what it does to the payload's standing at the §6
schema stage:

- **`valid`** — the payload still validates; any defect lives above Ajv (§3.1/§3.4
  semantics) or the mutator is benign scaffolding;
- **`invalid`** — Ajv must reject it (a §3.2 violation);
- **`unsupported-version`** — Ajv is never reached: `meta.schemaVersion` names a
  version the registry does not carry, which the stage grades as a §3.2 fail before
  validating anything.

Combining is by dominance: `invalid` wins, then `unsupported-version`, else `valid`.

**Currency is not an outcome.** A payload declaring a registered-but-older version is
plainly `valid` — the registry resolves it and its own compiled validator accepts the
body — even though the stage then records `info` + `outdated` rather than a §3.2
pass. A fourth `outdated` value was rejected: it would conflate "did Ajv accept
this?" with "is this the newest version we know?". Currency is expressed where it
belongs, in the case's expected findings and status.

The declaration is not a comment. `cases.test.ts` runs every materialized payload
through the real registry and the real Ajv validator and asserts the declared
outcome, so a vocabulary entry that stops doing what it claims fails CI.

## Declarative capabilities

Three things a case may need are not expressible as POSTs, and all three are
**markers the runner reads** rather than callbacks — the table stays data a CI test
can read.

**`setup: 'auth-enabled'`** — the session must opt into §1.3 auth first, and the
runner must thread the show-once credential into the transport context. Every §1.3
case needs it, the fail ones included: `noAuth()`/`badAuth()` only provoke a 401 on a
session where auth is actually enabled.

Enabling auth is **sticky and session-global**: it flips `auth_enabled` on the session
row, and from then on the pipeline 401s every uncredentialed POST before the body,
schema and semantic stages run. So the runner **partitions rather than toggles** —
plain cases first, one opt-in, then the `auth-enabled` cases — and leaves auth on when
the run ends. One transition per run is fewer moving parts than one per case, and the
end state honestly shows a dashboard reader that §1.3 was exercised. (The disable
route exists and is exposed in the dashboard; the runner deliberately does not use it.)
Authors can therefore put a §1.3 case anywhere in the table.

**`delivery: 'concurrent'`** — the case's POSTs are fired together instead of one after
the other. `sequential` is the default and what every other case wants; it is
load-bearing for §1.8, whose duplicate lookup only sees rows that have already
persisted. Concurrency exists for exactly one heuristic, §2.1, and is the only way to
reach its fail branch: the grader reads the in-flight count captured at handler entry,
which nothing but a genuinely overlapping request on the same session can push above 1.

**`baseline: emsBaseline`** — the case is built on a payload the default generator
does not produce. Today that means the schema's **EMS branch**: the root `if/then/else`
on `meta.transferType` sends an `ems` payload to `$defs/ems-report` and `$defs/ems-record`
instead of the `rtmd` pair, and the two are materially different. Absent means the
default (`rtm`) baseline, which is every case written before the field existed.

Precedence runs **case first**: `materializeCase(kase, { baseline })` substitutes for
the *default*, so a caller can retarget a case that declared nothing but can never
quietly downgrade one that named its branch. That asymmetry is the point — "declares
EMS, materializes rtm" is precisely the silent cap the field exists to prevent, and
neither consumer names a baseline (`runner/run.ts` passes only the transport context,
`cases.test.ts` only the §1.3 credential), so a case that cannot say it for itself
would have been played against the wrong branch while still reading as an EMS exercise.

The three are orthogonal — `delivery` says how one case's POSTs go out, `setup` says
what state the session needs first, `baseline` says what is in them — and concurrency
never spans cases, so a burst cannot leak a §2.1 fail into a neighbour's pool.

## The baseline is a seam

The canonical payload sits behind a `BaselineGenerator` function rather than a
constant, so it can be swapped — e.g. for simulator-grade realism from
`../ems-data-simulator` — without touching the case table or the runner. The default
is seeded from `src/ingest/fixtures/transmissions.ts`, the repo's existing single
source of truth for "a transmission that reaches the §6 happy-path 200"; the EMS
generator is hand-built beside it, because that fixture module is the §6 conditional-
failure set and its one valid payload is `rtm`.

The contract is three clauses, owed by **every** generator and asserted generically
over `BASELINE_GENERATORS` so a generator added later is held to them without a new
test: the payload is **schema-valid** against the version it names, **freshly owned**
on every call, and carries a **distinct `meta.transferId` per (caseId, index)**. That
last one is an obligation rather than a quirk of the fixture generator (bd b8r): the
runner plays the whole table against ONE session and §1.8 is session-scoped, so a
generator holding `transferId` constant — the obvious shape for one seeded from
`../ems-data-simulator` output — would make every non-replay case record a §1.8 fail
from table ordering alone. Both shipped generators stamp `<caseId>#<index>`; a case
that *wants* a duplicate pins the id itself with `setTransferId` on every POST rather
than trusting two baseline calls to return identical bytes.

Cases must not lean on more than those three clauses.

### Both branches of the schema: the EMS cases

Two generators ship. `fixtureBaseline` (the default) sends `rtm`; `emsBaseline` sends
`ems`, and a case reaches it by declaring `baseline: emsBaseline`. Until it existed the
table was rtm-only, so `$defs/ems-report`, `$defs/ems-record` and their `oneOf`s were
validated **nowhere** in this repo, live or in CI — while EMS manufacturers are the
primary E006 audience and RTMD is the interop schema's deviation.

Three §3.2 cases use it, filed in `cases/payload.ts` with the other schema-conformance
cases — grouping is by requirement domain, never by payload type:

| Case | What it proves |
|---|---|
| `3.2-pass-ems-baseline` | A conformant EMS transmission validates and is accepted 200. Its three 15-minute-spaced records also earn the incidental §3.4 and §3.1 passes the single-record rtm fixture cannot. |
| `3.2-fail-ems-mains-and-solar-power` | `ems-record`'s power `oneOf` is mains (`SVA`) XOR solar (`DCSV`+`DCCD`); each branch carries an explicit `not` against the other's fields, so a record claiming both matches **neither** — and zero matches violates a `oneOf` exactly as two do. |
| `3.2-fail-ems-version-strings-in-both-places` | `ems-report` lets `LSV`/`EMSV` sit on the report **or** on every record; putting them in both places matches **both** branches, which a `oneOf` also rejects. |

The two fails are deliberately the opposite ways a `oneOf` can break, and between them
they produce the multi-branch Ajv error set no rtm case can: a failed `oneOf` reports
every branch's complaints at once, unlike the single `required`/`maximum` errors the
rtm cases trigger. Their mutators **throw** when handed a payload without the mains /
report-level shape their invalidity depends on, so an EMS case that forgets the
declaration cannot materialize at all.

**Not here: a mixed-type payload** (rtm and ems reports in one transmission). Dropped
2026-08-05; the design question is bd `dal`, and it is not answered by implementing one.

## What CI checks, and what only a live run can

The suite itself never runs in CI: it needs a server, so it has its own npm script and
sits outside `npm test`'s glob. But the case table and transforms are pure, so the
colocated tests — which **do** run in CI — check the half that needs no server:

| Checked in CI (`npm test`) | Only checkable live (`npm run exercise`) |
|---|---|
| Every materialized payload really behaves as its case DECLARED: `invalid` rejected by the vendored Ajv, `unsupported-version` unresolvable in the registry, `valid` clean (`cases.test.ts`). Direction is not the test — most fail-direction cases carry a schema-valid payload whose defect lives above Ajv: transport, sequence, or §3.1/§3.4 semantics | The HTTP status each POST actually returns |
| A case expecting the §3.2 outdated grade names a registered version that really is older than current | That the finding the grader records is the one expected |
| Transport wrappers really produce the method/headers/bytes they claim | The §2.1 overlap (a timing fact — see below) |
| Table invariants: unique ids, distinct transferIds outside deliberate replays, §1.3 cases declare their setup, §2.1 fail cases declare concurrent delivery, and a case declaring the EMS baseline really materializes an `ems`-typed payload | The end-to-end pipeline, database and dashboard API |
| The coverage join, that every gradeable requirement is claimed in both directions, and that no claimed row is printed without the payload types it was exercised with | |

The live script and the CI-tested core import the **same** case definitions, so they
cannot drift apart.

**The §2.1 fail case is a measured timing fact, not a guarantee.** Its three POSTs
overlap only if a later request enters before the first leaves; the window is the whole
body → schema → semantic → persist path, database round trips included, so against a
local or normally loaded instance three sockets opened in the same tick overlap
comfortably (measured 9/9 consecutive runs against a local instance + compose Postgres).
That is precisely why it is a live assertion and never a CI one. If it ever fails, the
right response is to **say so** — dropping it would leave §2.1 with no fail-direction
exercise at all.

## Coverage is a mechanical join

Which requirements the suite exercises is computed, never annotated. `computeCoverage`
joins the case table onto `COMPLIANCE_MATRIX` — the same 27 rows the dashboard grades
against — and reports per row:

- **`covered`** — at least one pass-direction *and* one fail-direction case;
- **`partial`** — claimed in one direction only;
- **`uncovered`** — a gradeable row no case claims (the visible gap);
- **`uncovered-by-design`** — not gradeable from the receiving side at all.

**Gradeable** is the matrix's own definition: the row's PRIMARY class (`classes[0]`, the
one `deriveStatus` grades on) is `verified` or `heuristic`. Every other primary class —
`active-only`, `attestation`, `enforced`, `none` — describes something a passive
receiver cannot grade (`DESIGN.md` §7), so those rows are reported as uncovered by
design rather than as gaps. Reusing the matrix's classes means a requirement that
becomes gradeable later joins the gradeable set here automatically.

**A claim is `requirements`, not `expectedFindings`.** A case targeting §1.2 while
observing the incidental §3.2 pass every accepted POST earns is not an exercise *of*
§3.2 — letting it count as one would make coverage look complete the moment any case
passed the schema stage. A requirement id the matrix does not carry (a typo, a retired
id) is surfaced separately rather than silently dropped.

The runner prints this report on every run, and `runner/coverage.test.ts` pins the
current state as a CI fact: every gradeable requirement — §1.1, §1.2, §1.3, §1.4, §1.6,
§1.8, §2.1, §3.1, §3.2, §3.4 — is exercised in both directions.

### …in two dimensions, because direction alone was a silent cap

The join counts **requirements**, not payload types. That was an honest answer only
while every case sent the same payload: the moment the table gained EMS cases,
`covered (both directions)` started meaning *covered for rtm* on every row but §3.2 —
a green line claiming more than it has, which is the one thing this report exists not
to do.

So each row also carries the payload types its pass and fail cases send — read off each
case's baseline via `payloadTypeOf`, so the answer is the same one materialization
gives — and every claimed requirement is printed **with** them:

```
coverage — 10 gradeable requirement(s), payload types sent: ems rtm
  [types] after a requirement are the payload branches it was exercised with — [rtm] means rtm ONLY
  covered (both directions)  1.1[rtm] 1.2[rtm] … 3.2[ems,rtm] 3.4[rtm]
```

A type exercised in only one direction of an otherwise-covered row is marked as such
(`3.2[ems(fail-only),rtm]`): catching EMS defects is not the same as accepting
conformant EMS traffic, and that is the same cap one level down. The annotation is
computed from the table, so it cannot go stale — including the day a requirement other
than §3.2 grows an EMS case.

The type dimension **qualifies** a verdict; it never gates one. `covered` still means
both DIRECTIONS, which is what the epic's acceptance criterion is about, and an rtm-only
row is not automatically a gap to close — a §1.1 405 halts before the schema stage runs
at all, so an EMS twin of it would exercise nothing the rtm one does not. Which types a
row has is a fact the report must state rather than hide. The payload type of a case is read from its **baseline**, not from what its
mutators wrote: `3.2-fail-invalid-transfer-type` sets `meta.transferType` to
`thermometer` to prove the enum bites, and that is no branch of anything.

## Why 0.8.0 is registered

The §3.2 **pass-outdated** case (`3.2-pass-outdated-schema-version`) depends on the
registry carrying a second, older version. It does: 0.8.0 was dropped when 0.8.1
published, then **restored on 2026-08-04** (bd 8qa.4, amending fvw) precisely because a
single registered version leaves the outdated-but-valid grade unreachable by
construction — with nothing older than current, no transmission can earn the OUTDATED
SCHEMA signal, and neither the grade nor the dashboard tag can be exercised end to end.
0.8.0 is also the version a supplier is likeliest to still be sending. 0.8.2/0.8.3 exist
upstream but stay unregistered, so current remains 0.8.1 (`DESIGN.md` §9).

Registration is per dialect — 0.8.0 declares draft-07, 0.8.1 declares 2020-12 — so the
two entries compile under different Ajv builds in their own instances. The case sends
the baseline unmodified apart from the version string, having been verified to validate
against 0.8.0's bytes as well as 0.8.1's; a future baseline that trips one of the bounds
the two releases differ on must declare the adjustment in that case rather than quietly
skipping the older version.

## Adding a case

1. Put it in the module for its requirement **domain** — `cases/transport.ts` (§1.x),
   `cases/payload.ts` (§3.1/§3.2), `cases/sequence.ts` (§1.8/§2.1/§3.4). Grouping is by
   domain, not by `fault.layer`: the §3.4 cases mutate a payload but grade a sequence
   heuristic, so they live with the sequence table. Nor is it by **payload type**: a
   case on the schema's EMS branch is one that DECLARES `baseline: emsBaseline` and
   still lives with its domain — the EMS §3.2 cases sit in `cases/payload.ts` beside the
   rtm ones. Do not open a module or a directory for a payload type; which branch a case
   exercises is a field to read off the case, not a file location.
2. Give it a stable, unique id of the form `<requirement>-<direction>-<slug>`.
3. Read the expected status and findings **off the pipeline** (`src/ingest/route.ts` and
   the stage that owns them), not off the requirement prose. Both files' headers record
   what each stage does; if the answer is not there, the stage's own tests have it.
4. Reuse the transform vocabulary. Reach for a new transform only when the mutation is
   genuinely new, and declare its `targets` and `schemaOutcome` when you do — CI checks
   the latter against real Ajv.
5. Run `npm test`. The table invariants in `cases.test.ts` will object if the case
   collides with another's transferId, expects a fail finding in the pass direction,
   reaches for a credential without `setup: 'auth-enabled'`, or names a requirement the
   matrix does not carry.
6. Then run it for real against a live instance — the status and finding halves are only
   provable there.
