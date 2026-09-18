# The conformance exercise suite

**Status:** contributor documentation. **Last updated:** 2026-09-17.

A service that grades other people's conformance should be held to the same bar,
and the only honest way to check the receiving side is to drive a deployed
instance the way a supplier would. `npm run exercise` does that: it plays a table
of 65 synthetic cases against a **running** validator and checks five things.

- **Requirements, both directions.** Every requirement the §7 matrix says we grade
  is exercised once in the passing direction and once in the failing one.
- **Advisories, both halves.** Every registered advisory is fired by a case built
  to provoke it, and conformant traffic is asserted to draw none.
- **The DS01.3 shadow run.** Cases declare what the unpublished Annex 4 draft
  would make of a payload the contract in force accepts.
- **The advisory copy.** The prose a supplier would actually read is audited
  run-wide for shape and vocabulary.
- **The grading lens.** The DS01.3 summary rows the instance serves are checked
  against the findings and verdicts it serves beside them.

This document is its internals: the case model, the transform vocabulary, how
coverage is computed, and how to add a case. The how-to-run lives in the
[README](../README.md#exercising-a-running-instance--npm-run-exercise).

> ### ⚠ Synthetic test data only
>
> Every byte the suite sends is built from its own baseline and transform
> vocabulary. It reads no real CCE data, and it must never be pointed at a session
> holding any (`DESIGN.md` §2, §12). It creates its own session on every run, so
> it never writes into one it did not mint.

The code is `src/exercise/`:

| Path                                           | Role                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `case.ts`                                      | The case model — what a case may declare, and how a POST is materialized.                            |
| `baseline.ts`                                  | The pluggable baseline generators (one canonical, schema-valid payload — `rtm` or `ems`).            |
| `transforms/payload.ts`                        | Payload mutators: what is in the body.                                                               |
| `transforms/transport.ts`                      | Transport wrappers: how it goes on the wire.                                                         |
| `cases/{transport,payload,sequence,shadow}.ts` | The case table, one module per requirement domain.                                                   |
| `cases/shadow.test.ts`                         | The CI stand-in for a shadow expectation: every `ds013`-graded case put through the draft validator. |
| `cases.ts`                                     | The index that concatenates them into `EXERCISE_CASES`.                                              |
| `runner/client.ts`                             | The only module that opens a socket.                                                                 |
| `runner/assertions.ts`                         | Pure grading of a case from statuses + findings.                                                     |
| `runner/coverage.ts`                           | The joins onto `COMPLIANCE_MATRIX`, the advisory catalogue and the DS01.3 matrix.                    |
| `runner/run.ts`                                | The CLI: resolve target, play, print, exit code, and --help.                                         |

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
- **`expectedFindings`** — the findings the session must show afterwards, each naming
  a `requirement` and a `severity`, plus an optional `profile` (which lineage graded
  it) and an optional `outdated` (the modifier the finding must carry).

…plus the three **declarative capabilities** below — `setup`, `delivery`, `baseline` —
which say what a case needs, never how to arrange it.

A multi-POST case is how the sequence-dependent heuristics (§1.8 duplicates, §2.1
serial delivery) are exercised without inventing a second mechanism — a single-POST
case is just a list of one.

### Expected findings are presence-based, not exhaustive

The runner pools the findings attributable to a case's POSTs and requires each
expectation to appear at least once, matched on `(requirement, severity, profile)`,
narrowed further by `outdated` when an expectation names it. `detail` is prose the
graders may reword, so it is deliberately not part of the contract; and pooled
findings a case does not name never fail it.

Exhaustive matching was considered and rejected: an accepted POST legitimately
accumulates findings the case has no interest in — the §1.2/§1.6/§1.8 passes every
200 earns — so exhaustiveness would make cases brittle against grader evolution
rather than against the defect they target. The accepted cost is that a case cannot
prove a defect did not _leak_; that is a property of the whole session, not of one
case.

Attribution is by **transmission id**: the ingest response names the row it wrote and
the dashboard API reports findings against that same id, so a case's pool is exactly
the findings its own POSTs produced, even though the whole table shares one session.
Expectations pool per case, not per POST. A case may expect **no** findings at all —
a 405 halts before persistence, so the status _is_ the grade.

A case may also name findings that must **not** appear in its own pool, in
`absentFindings`. That is the complement of the presence rule rather than a retreat
from it: only the ids a case names are judged, so a pooled finding nothing names is
still ignored. An entry names `(requirement, profile)` and no severity — silent means
no finding of that id under that lineage, at any severity — and a pooled finding that
matches one fails the case with `unexpected finding §<id> <severity> [<profile>] —
case declared it absent`. It exists because each advisory's header documents a
population it deliberately says nothing about (solar records, an explained null, a
series under the twelve-record padding floor), and until a case could state an
absence, those rules were exercised nowhere. The scope is still the case: the pool is
the findings of that case's own transmissions, so this is not a run-wide "no stray
findings anywhere" check, and it is not meant to become one.

## Two transform families

Payload mutators change **what** is sent; transport wrappers change **how** it is
delivered. Materialization always runs the payload family first and the transport
family second, whatever order a case lists them in — a wrapper operates on the
serialized bytes — and honors declaration order within each family.

| Family    | Examples                                                                                                                                                                                                                                                             | Reaches                      |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Payload   | `dropRequiredField`, `setInvalidValue`, `setSchemaVersion`, `addCustomDataObject`, `declareCustomDataSchema`, `regularCadence` / `irregularCadence`, `setTransferId`, `padToWireCap`, `addSolarPowerToMainsRecord` / `duplicateVersionStringsIntoRecords` (EMS-only) | §3.1, §3.2, §3.4, §1.4, §1.8 |
| Transport | `method`, `unparseableBody`, `contentType`, `bearerCredential` / `noAuth` / `badAuth`, `oversize`, `gzip` / `doubleGzip` / `unsupportedEncoding`                                                                                                                     | §1.1, §1.2, §1.3, §1.4, §1.6 |

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
the _default_, so a caller can retarget a case that declared nothing but can never
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
https://github.com/phoenixgh-org/ems-data-simulator/ — without touching the case
table or the runner. The default
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
https://github.com/phoenixgh-org/ems-data-simulator/ output — would make every
non-replay case record a §1.8 fail
from table ordering alone. All three shipped generators stamp `<caseId>#<index>`; a
case that _wants_ a duplicate pins the id itself with `setTransferId` on every POST rather
than trusting two baseline calls to return identical bytes.

Cases must not lean on more than those three clauses.

### Both branches of the schema: the EMS cases

Three generators ship. `fixtureBaseline` (the default) sends `rtm`. `dualPassBaseline`
sends the other valid rtm fixture — the one carrying the five logger-identity
properties, so it validates under BOTH registered lineages — which is what a readiness
case needs when it wants a payload the shadow run has nothing to say about.
`emsBaseline` sends `ems`. A case reaches a non-default generator by declaring it, for
example `baseline: emsBaseline`. Until `emsBaseline` existed the table was rtm-only, so `$defs/ems-report`, `$defs/ems-record` and their `oneOf`s were
validated **nowhere** in this repo, live or in CI — while EMS manufacturers are the
primary E006 audience and RTMD is the interop schema's deviation.

Twenty-three cases declare it today — the advisory and readiness tables reach for the
EMS branch too — and **five** of them target §3.2. Those five are filed in
`cases/payload.ts` with the other schema-conformance cases; grouping is by requirement
domain, never by payload type:

| Case                                          | What it proves                                                                                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `3.2-pass-ems-baseline`                       | A conformant EMS transmission validates and is accepted 200. Its three 15-minute-spaced records also earn the incidental §3.4 and §3.1 passes the single-record rtm fixture cannot.                                                               |
| `3.2-fail-ems-mains-and-solar-power`          | `ems-record`'s power `oneOf` is mains (`SVA`) XOR solar (`DCSV`+`DCCD`); each branch carries an explicit `not` against the other's fields, so a record claiming both matches **neither** — and zero matches violates a `oneOf` exactly as two do. |
| `3.2-fail-ems-version-strings-in-both-places` | `ems-report` lets `LSV`/`EMSV` sit on the report **or** on every record; putting them in both places matches **both** branches, which a `oneOf` also rejects.                                                                                     |
| `3.2-fail-ems-null-tvc-without-lerr`          | A null `TVC` with no `LERR` beside it matches no branch of the record's null-explanation `oneOf` — the same zero-match shape as the power case, on a different rule.                                                                              |
| `3.2-pass-ems-null-tvc-explained`             | The other side of that conditional: a null `TVC` accompanied by an `LERR` validates, so the rule is exercised in both directions rather than only where it bites.                                                                                 |

Between them the three fails cover both ways a `oneOf` can break — zero matches twice
(the power partition and the TVC/LERR conditional) and two matches once (the version
strings) — and they produce the multi-branch Ajv error set no rtm case can: a failed
`oneOf` reports every branch's complaints at once, unlike the single
`required`/`maximum` errors the rtm cases trigger.

The TVC/LERR conditional is worth naming on its own. It is the schema rule that lets a
null temperature stand when an error code explains it, and it is where
`adv.unexplained_null_temp` stops on the EMS branch: an absent, `null`, or empty-string
`LERR` beside a null `TVC` is already a §3.2 fail, so an advisory there would restate it
rather than add anything. The rule has one opening, and the advisory's EMS arm is
exactly that opening — `minLength: 1` counts characters rather than content, so a `LERR`
of blank space validates and explains nothing. The advisory case
`adv.unexplained_null_temp-fail-ems-blank-logger-error-code` is that opening exercised;
the RTMD arm keeps a case of its own, since `rtmd-record` carries no such conditional at
all.

The two ORIGINAL mutators — `addSolarPowerToMainsRecord` and
`duplicateVersionStringsIntoRecords` — **throw** when handed a payload without the mains
or report-level shape their invalidity depends on, so an EMS case that forgets the
`baseline` declaration cannot materialize at all. `setInvalidValue('/data/0/records/0/TVC', null)`,
which the null-TVC fail uses, throws on nothing: it simply writes the value, and the
invalidity it claims is held by `cases.test.ts`'s real-Ajv check on the declared
`schemaOutcome` instead.

**Not here: a mixed-type payload** (rtm and ems reports in one transmission). Dropped
2026-08-05; the design question is bd `dal`, and it is not answered by implementing one.

## Advisory cases

An advisory is an observation the service offers a supplier, not a requirement it
grades — so the case model treats it as a first-class target while the coverage join
refuses to count it as a requirement. Eighteen cases exercise the thirteen registered
advisories today.

**Where they live.** In `cases/payload.ts`, beside the requirement cases. The grouping
rule is unchanged: an advisory reads the body, so it belongs with the payload domain.
There is no advisory module and no advisory directory.

**One exception, and the rule it follows.** `adv.abst_window_overlap` is graded from how
two transmissions relate rather than from one body — one delivery's `ABST` window against
the windows earlier deliveries in the session recorded for the same appliance — so its
cases live in `cases/sequence.ts` with the other multi-POST heuristics. The grouping rule
did not change; this advisory is simply a sequence heuristic that happens to be an
advisory.

**`requirements` is empty.** Every `adv.*` case declares `requirements: []` (by1c.42),
because an advisory is not a `COMPLIANCE_MATRIX` row: naming one in `requirements`
would be reported as an unknown requirement, and naming a §7 id the case does not
actually target would inflate requirement coverage. What the case claims is its
`expectedFindings`.

**The id is the claim.** An advisory case is named `adv.<id>-fail-<slug>`, and
`cases.test.ts` reads the id up to the first hyphen and requires the case to expect
that same id as an `info` finding under the contract profile. Both halves of that
matter: `info` is the only severity `advisory()` can build, and a shadow-profile
expectation would grade the unpublished draft rather than the catalogue in force. A
mistyped expectation therefore fails CI instead of quietly crediting the exercise to
the wrong advisory.

**A fire case** sends traffic built to provoke exactly one advisory, in direction
`fail`, and expects `{ requirement: 'adv.<id>', severity: 'info' }`. It may expect
other findings too — a payload that draws an advisory is usually still accepted 200
and still earns the incidental §3.2 pass — and it may carry a `ds013` expectation,
since planting a defect is a statement about the draft as well as about the advisory.

**A silence case** is the other half of the catalogue's contract, and it is an ordinary
pass-direction case carrying `absentFindings`: the payload is conformant traffic the
advisory must NOT speak about. Thirteen cases declare an absence today. Most name a
single advisory — the population its own header says it is silent on, such as solar
records or an explained null — while the two baseline pass cases,
`3.2-pass-baseline` and `3.2-pass-ems-baseline` — and the EMS readiness pass case
`readiness.ems_dual_pass` — declare the **whole** catalogue silent by mapping
`ADVISORY_IDS` off the registry, so an advisory that starts firing on a clean payload
fails a case rather than passing unnoticed. Reading the list off the registry keeps the
table data: an advisory added later is covered by those cases without anyone editing
them.

Coverage of the catalogue is a mechanical join like requirement coverage, and it is
what pins "every registered advisory has a fire case" as a CI fact — see
[The advisory join](#the-advisory-join) below for how it reads `expectedFindings` and
why it deliberately says nothing about silence.

## What CI checks, and what only a live run can

The suite itself never runs in CI: it needs a server, so it has its own npm script and
sits outside `npm test`'s glob. But the case table and transforms are pure, so the
colocated tests — which **do** run in CI — check the half that needs no server:

| Checked in CI (`npm test`)                                                                                                                                                                                                                                                                                                                                | Only checkable live (`npm run exercise`)                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Every materialized payload really behaves as its case DECLARED: `invalid` rejected by the vendored Ajv, `unsupported-version` unresolvable in the registry, `valid` clean (`cases.test.ts`). Direction is not the test — most fail-direction cases carry a schema-valid payload whose defect lives above Ajv: transport, sequence, or §3.1/§3.4 semantics | The HTTP status each POST actually returns                                                                                                   |
| A case expecting the §3.2 outdated grade names a registered version that really is older than current                                                                                                                                                                                                                                                     | That the finding the grader records is the one expected                                                                                      |
| Transport wrappers really produce the method/headers/bytes they claim                                                                                                                                                                                                                                                                                     | The §2.1 overlap (a timing fact — see below)                                                                                                 |
| Table invariants: unique ids, distinct transferIds outside deliberate replays, §1.3 cases declare their setup, §2.1 fail cases declare concurrent delivery, and a case declaring the EMS baseline really materializes an `ems`-typed payload                                                                                                              | The end-to-end pipeline, database and dashboard API                                                                                          |
| The coverage join, that every gradeable requirement is claimed in both directions, that every registered advisory has a fire case, and that no claimed row is printed without the payload types it was exercised with                                                                                                                                     | The advisory copy a live instance actually served (`auditAdvisoryCopy` — see below)                                                          |
| The draft verdict behind every shadow expectation: `cases/shadow.test.ts` puts each case carrying a `ds013` expectation — thirteen today, from the readiness module and the advisory table alike — through the Annex 4 draft validator and asserts the `pass`/`fail` the case declared                                                                    |                                                                                                                                              |
| The lens audit's own rules, against synthetic rows, findings and verdicts (`runner/assertions.test.ts`), and the DS01.3 half of the coverage join (`runner/coverage.test.ts`)                                                                                                                                                                             | That the DS01.3 summary rows a live instance serves agree with the findings and verdicts it serves beside them (`auditLensRows` — see below) |

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

**The advisory copy is audited run-wide, not case by case.** Every advisory carries a
one-line `summary` beside its `detail`, and that prose reaches the supplier through the
repository, the dashboard API and the browser — a path no pure test can walk. So the
runner holds the copy a live instance actually served to one session-level invariant
(`auditAdvisoryCopy` in `runner/assertions.ts`): each advisory finding has a non-blank
summary and a non-blank detail, and neither uses the defect vocabulary the category is
closed to. The word list is imported from `ADVISORY_COPY_BANNED_WORDS` beside
`advisory()`, so the per-check copy tests and the runner cannot drift apart, and the
clause-1.8 phrase "a delivery failure" is removed before the bar is applied rather than
struck off it. It is deliberately not an `ExpectedFinding` field: the copy is prose a
grader may reword, and a case matching on it would fail on an edit that changed no
behaviour. The runner prints one line per distinct `(advisory, summary)` pair, and a
violation fails the run on its own — exit 1 even with every case green. Two things are
softer than that: a summary over 90 characters is a warning, because the counts a
summary carries grow with the payload, and a target that serves no summary on **any**
advisory is reported as an instance fact rather than a failure. A target that serves
some and not others is a violation, which is the regression the audit exists to catch.

**The grading lens is audited against the evidence beneath it.** The dashboard can be
switched from the UNICEF Q1 2025 requirements to the DS01.3 draft, and under that lens
every count is folded at read time: a §1.4 failure is counted on clause 5.1.5, a §3.1
custom-object finding on 5.3.5, and the Annex 4 validator's own findings on 5.3.2. The
fold and the verdict rule are pure and unit-tested. What no pure test reaches is the
path between them on a real instance — the scoping, the join onto the draft matrix, the
serialization, and the fact that the numbers a supplier reads on one page are the
numbers the rows beneath them carry. So once the table has been played the runner reads
the session summary again under `?lens=ds013` and holds it to one invariant
(`auditLensRows` in `runner/assertions.ts`):

- each served row's `counts.fail` equals the number of fail findings the run's own
  findings fold onto that clause;
- no failure folds onto a clause the draft package does not serve;
- every transmission contributing a failure to a row carries a `fail` verdict under that
  lineage, and every transmission whose verdict is `fail` has a row carrying it.

That last pair is the point of the pass. Without the first half a clause could be graded
off traffic the page calls clean; without the second a supplier could be told the draft
fails a transmission with no row to open. The block prints both numbers per failing row,
so a run can be checked against the page without opening the dashboard:

```
grading lens — ds013: 27 row(s) served, 10 carrying a failure
  5.1.3   2 fail (folded 2) from 2 transmission(s)
  5.1.5   1 fail (folded 1) from 1 transmission(s)
  5.3.2   199 fail (folded 199) from 49 transmission(s)
```

A disagreement fails the run on its own — exit 1 even with every case green — for the
same reason an advisory served with no summary does: those numbers are part of what the
service delivers. Two things are softer, and the tolerance is asymmetric in the same way
the copy audit's is. A target that does not know the lens answers HTTP 400
`unknown_lens`, and a target older than per-profile verdicts serves none for the draft
lineage; each is reported as a fact about the instance and grades nothing, because
failing there would say "this validator is broken" about one that simply predates the
feature.

## Coverage is a mechanical join

Which requirements the suite exercises is computed, never annotated. `computeCoverage`
joins the case table onto `COMPLIANCE_MATRIX` — the same 27 rows the dashboard grades
against — and reports per row:

- **`covered`** — at least one pass-direction _and_ one fail-direction case;
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
observing the incidental §3.2 pass every accepted POST earns is not an exercise _of_
§3.2 — letting it count as one would make coverage look complete the moment any case
passed the schema stage. A requirement id the matrix does not carry (a typo, a retired
id) is surfaced separately rather than silently dropped.

The runner prints this report on every run, and `runner/coverage.test.ts` pins the
current state as a CI fact: every gradeable requirement — §1.1, §1.2, §1.3, §1.4, §1.6,
§1.8, §2.1, §3.1, §3.2, §3.4 — is exercised in both directions.

### …in two dimensions, because direction alone was a silent cap

The join counts **requirements**, not payload types. That was an honest answer only
while every case sent the same payload: the moment the table gained EMS cases,
`covered (both directions)` started meaning _covered for rtm_ on every row but §3.2 —
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

### The advisory join

The requirement join above is blind to advisories by construction. An advisory is
deliberately not a requirement, so every `adv.*` case declares `requirements: []` — which
means a registered advisory with no case at all looked exactly like one with ten. That is
how `adv.null_padding` came to be the one advisory the live run never exercised, without
a single test objecting.

So the report carries a second join, onto `ADVISORY_IDS` — the list the advisory registry
itself exports, built from each check module's own id constant, so it grows with the
catalogue rather than beside it. An advisory counts as **fired** when at least one case
expects `{ requirement: <id>, severity: 'info' }` under the contract profile. Both halves
of that matter: `info` is the only severity `advisory()` can build, and a shadow-profile
expectation grades an unpublished draft, so counting one would report the contract
catalogue as exercised by a run that never touched it.

This join reads `expectedFindings`, which is the mirror image of the requirement rule and
holds for the same reason. There, counting findings would inflate coverage, because every
accepted POST earns an incidental §3.2 pass. Here `requirements` is empty on every
advisory case by design, so the expectation _is_ the claim — a case cannot expect an
advisory it did not set out to provoke.

Fired advisories are annotated with payload types exactly as requirements are:

```
advisories — 13 registered: fired 13
  [types] after an advisory are the payload branches its fire case(s) send — [ems] means ems ONLY
  fired                      adv.null_identity[ems,rtm] adv.null_padding[ems] adv.date_format[ems,rtm] …
  NOT EXERCISED              —
```

`runner/coverage.test.ts` pins the live fact: every registered advisory has a fire case.
A new check added to `ADVISORY_CHECKS` therefore lands in CI as a failure naming its own
id, rather than as a quiet line in the runner's report.

The section reports **exercise, not correctness**. A fired advisory is known to be
reachable; whether it stays silent on conformant traffic is the other half of the
catalogue's contract, and the coverage join says nothing about it. That half is now
expressible in the cases themselves: `absentFindings` lets a case declare which
advisories its payload must NOT draw, and three cases — the two baseline pass cases and
the EMS readiness pass case — declare the whole catalogue silent by reading
`ADVISORY_IDS` off the registry. Read `fired 12` as "every advisory is reachable" and
the silence cases as the other half — neither line alone says "the catalogue behaves".

### Shadow cases, and the DS01.3 half of coverage

A transmission whose declared `schemaVersion` resolves to a registered lineage is graded
twice: once against the contract in force (`cce-interop`, profile `2025`) and once
against the DS01.3 Annex 4 delivery-schema proposal (profile `ds013`). The second run changes no status and no verdict, because the draft is
unpublished — what it produces is readiness information. The `readiness.*` cases in
`cases/shadow.ts` exercise it.

Three fields carry that:

- **`ExpectedFinding.profile`** names the lineage a finding must come from. Absent means
  the contract profile, which is what every case written before shadow grading expects.
  It is part of the match, not a label: one transmission now carries findings of both
  lineages, so an expectation matched on `(requirement, severity)` alone could assert a
  contract pass and be satisfied by a draft one.
- **`ExerciseCase.shadowClauses`** records the DS01.3 clauses a case exercises, e.g.
  `['5.3.2']`. It is the claim the DS01.3 coverage join reads.
- **`ExerciseCase.requirements`** stays 2025 ids, unchanged.

The two kinds of id stay in separate fields because `COMPLIANCE_MATRIX` is 2025-only by
construction: a DS01.3 clause is not a row there, so an id added to `requirements` would
be reported as an _unknown requirement_ rather than as coverage. What the case actually
asserts about the shadow run is still its `expectedFindings` entries carrying `profile`;
`shadowClauses` says what the case is about.

Each package is now joined onto its own matrix and the two are reported side by side. The
DS01.3 join reads `shadowClauses` against the 27 clauses the grading lens serves, and
says which of them the table exercises:

```
DS01.3 rows — 27 clause(s): exercised 1, not exercised 26
  a clause is exercised when a case names it in `shadowClauses` — reported, never failed
  exercised                  5.3.2[ems,rtm]
  not exercised              5.1.1 5.1.2 5.1.3 5.1.4 5.1.5 5.1.6 5.1.7 …
```

**Exercised**, not covered, and the word is chosen. The 2025 join grades a row on being
claimed in both directions; this one asks only whether any case names the clause, because
the draft is unpublished and a run against it is preparation rather than grading. A
clause with no exercise is therefore printed, never failed. A clause the draft adds is
informational unless a finding code feeds it — `NEW_FED_BY` in `src/api/matrix-ds013.ts`,
which today names 5.3.5 alone — so five of the 27 rows are ones the receiving side files
no finding under at all, and a CI failure demanding a case for each would be demanding an
exercise that does not exist. What CI
does pin is the mechanical half: a clause a case names that the draft matrix does not
carry is reported as an unknown claim, exactly as a mistyped requirement id is.

Caution: an exercised clause is not a graded one. The line counts claims, so a case that
names a clause and asserts nothing under that lineage would read as exercise. What keeps
the two together is `cases.test.ts`, which fails any case recording a clause it expects
no finding on.

A readiness case is **direction `pass`**. Direction describes the contract's point of
view, which is the only view that grades: a payload the validator accepts with a §3.2
pass is conformant traffic whatever the draft would make of it. Such a case therefore
declares no `fault`, and `cases.test.ts` reads the pass-direction "no fail findings" rule
as contract fails only.

One case the design asked for does not exist. A `meta.transferredAt` carrying a `+03:00`
offset is invalid under `cce-interop` 0.8.1 as well — that schema already pins the field
to a pattern ending in `Z` — so the trailing `Z` is not a DS01.3 tightening, an offset is
a §3.2 fail and a 422 under the contract, and the draft's clause 5.3.3 is reachable only
on a payload the contract already rejects.

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
   `cases/payload.ts` (§3.1/§3.2), `cases/sequence.ts` (§1.8/§2.1/§3.4),
   `cases/shadow.ts` (readiness under the DS01.3 shadow run). Grouping is by
   domain, not by `fault.layer`: the §3.4 cases mutate a payload but grade a sequence
   heuristic, so they live with the sequence table. Nor is it by **payload type**: a
   case on the schema's EMS branch is one that DECLARES `baseline: emsBaseline` and
   still lives with its domain — the EMS §3.2 cases sit in `cases/payload.ts` beside the
   rtm ones. Do not open a module or a directory for a payload type; which branch a case
   exercises is a field to read off the case, not a file location. An advisory case has
   no requirement domain; it goes in `cases/payload.ts` — see
   [Advisory cases](#advisory-cases).
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

If the case changes what this document says, edit the prose and bump the **Last
updated** header in the same commit, so the header never lags the text. That mirrors
the rule `DESIGN.md` carries for the same reason.
