# Deployment and operations

**Status:** operator documentation. **Last updated:** 2026-08-01.

How to run the CCE Data Delivery Validator behind a TLS edge without corrupting
the verdicts it issues. The design authority is `DESIGN.md` §4.1 (edge / proxy
contract); this document is its operational half, and the files it describes are:

| File | Role |
|------|------|
| `deploy/Caddyfile` | The §4.1 contract, encoded and commented. |
| `docker-compose.yml` | `postgres` + `app`, plus an optional `caddy` service behind the `edge` profile. |
| `deploy/smoke-proxy-contract.sh` | Post-deploy verification that the contract actually holds. |

---

## 1. Why the proxy is a correctness problem, not a plumbing problem

This service grades other people's conformance. It runs on plain HTTP behind a
TLS-terminating proxy, and it grades several requirements **from the exact bytes
and headers that arrive**. A proxy that caps, decompresses, or re-labels a
request does not raise an error anywhere — it changes the evidence, and the
service goes on issuing confident findings against the wrong input.

> A self-hoster who gets this wrong sees no failure. Their suppliers get
> **silently wrong conformance verdicts** issued under this project's name.
> Wrong grades are worse than no tool.

Hence the contract below is mandatory, and hence the smoke test exists.

---

## 2. The §4.1 proxy contract

Three terms. Each states what the edge must do, where the app depends on it, and
**what a violation looks like** — because none of them announce themselves.

### Term 1 — the scheme is advertised, and trusted only from the proxy

The proxy sets `X-Forwarded-Proto`; the app honours it **only** for requests
arriving from the address in `TRUSTED_PROXY` (Fastify `trustProxy`,
`src/app.ts:107`, default `127.0.0.1`), never blanket-`true`. This is how §1.1's
HTTPS aspect is known, and the app's port is never publicly exposed.

Caddy's `reverse_proxy` sets `X-Forwarded-For` / `-Proto` / `-Host` itself,
replacing whatever the client sent — so the edge half of this term needs **no
directive at all**. (Adding `header_up X-Forwarded-Proto {scheme}` is a no-op
Caddy warns about at startup: *"Unnecessary header_up X-Forwarded-Proto"*,
observed on v2.11.4. `deploy/Caddyfile` therefore documents the default rather
than restating it.) The half that *is* configurable is `TRUSTED_PROXY`, below.

**Failure mode — trust too narrow** (the common one: `TRUSTED_PROXY` still
`127.0.0.1` while the proxy is a container on the bridge network). The header is
ignored, `request.protocol` reads `http`, and the service's claim that "§1.1 is
enforced at the edge" is no longer backed by anything it can observe. Nothing
errors. Note the app is deliberately lenient about scheme today — the method
stage reads `request.protocol` for awareness and never rejects
(`src/ingest/stages/method.ts`) — so this misconfiguration currently degrades a
*claim* rather than a finding. Fix it anyway: the claim is on the dashboard.

**Failure mode — trust too broad** (`TRUSTED_PROXY` set to `0.0.0.0/0`, `true`,
or a range wider than the proxy). Any client can now spoof `X-Forwarded-Proto`
and `X-Forwarded-For`, so the scheme the service believes and the addresses it
logs become attacker-controlled. Scope it to the proxy and nothing else.

**Failure mode — app port publicly reachable.** If suppliers can hit the app
directly on `:3000`, they bypass TLS entirely and §1.1 is enforced for nobody.
In production, bind the mapping to loopback (`127.0.0.1:3000:3000`) or delete it
and reach the app only through the edge network.

### Term 2 — no body cap below the app's thresholds

The **app owns** the §1.4 cap. Two ceilings live in the app and must not be
shadowed by the edge:

| Ceiling | Value | Where | Purpose |
|---------|-------|-------|---------|
| §1.4 grading cap | 1 MiB (1 048 576 B) | `MAX_WIRE_BYTES`, `src/ingest/stages/size.ts` | Over this → §1.4 FAIL finding + a teaching `413`, with the transmission recorded. |
| Fastify `bodyLimit` | 2 MiB | `DEFAULT_BODY_LIMIT`, `src/app.ts` | Outer memory bound, deliberately **above** the grading cap so oversized-but-bounded bodies still reach the size stage. |

Any proxy-level cap must therefore be **strictly greater than 2 MiB**, or
absent. `deploy/Caddyfile` sets `request_body { max_size 8MB }` purely as an
abuse bound; Caddy imposes no default request-body limit of its own.

**Failure mode.** An edge cap at or below 1 MiB turns every oversized POST into
the proxy's own bare `413` — Caddy's is an **empty body**, no JSON, no finding.
No transmission row is written, no §1.4 finding is emitted, the dashboard shows
the transmission never happened, and the supplier — who has just failed a real
requirement — is told nothing about it. This is the sharpest instance of the
silent-failure problem: the tool's most useful teaching output is deleted by a
setting nobody looked at. (Reproduced deliberately during development with
`max_size 512KB`; the smoke test catches it.)

### Term 3 — the body reaches the app as sent

No request decompression, no re-encoding, no rewriting of `Content-Type`,
`Content-Encoding` or `Content-Length`. §1.4 is measured on the wire bytes
*after* content-encoding, and §1.6 grades `Content-Encoding` handling and
detects illegal double-encoding (`src/ingest/stages/encoding.ts`), so both need
the supplier's exact bytes.

Caddy does not decompress request bodies (its `encode` directive compresses
**responses** only), and `reverse_proxy` streams request bodies unbuffered by
default. The contract is therefore mostly expressed as things
`deploy/Caddyfile` deliberately does **not** configure: no `request_buffers`, no
third-party request-decompression module, no `header_up` rewriting of the
content headers.

**Failure mode — the edge decompresses.** The app receives plaintext still
labelled `Content-Encoding: gzip`, fails to gunzip it, and emits a §1.6 **FAIL**
("could not be decompressed") plus a `400` against a supplier whose request was
perfectly correct. A false accusation, delivered confidently.

**Failure mode — the edge decompresses *and* strips the header.** Now §1.4 is
measured on the decompressed size, so a compliant 900 KB-on-the-wire submission
can be graded as over the 1 MiB cap, and §1.6 is never exercised at all — the
supplier gets neither the pass they earned nor any hint why.

**Failure mode — HTTP/2 or HTTP/3 to the edge.** Framing legitimately differs
between the client hop and the upstream hop; what matters is that the body
*bytes* and the content headers are unchanged. That is exactly what the smoke
test asserts, which is why it is not optional after a topology change.

---

## 3. `TRUSTED_PROXY` in practice

`TRUSTED_PROXY` is a `proxy-addr` value (Fastify passes it straight through): a
single address, a comma-separated list, a CIDR subnet, or one of the named
groups (`loopback`, `linklocal`, `uniquelocal`).

| Topology | Value |
|----------|-------|
| Caddy on the same host, app on loopback | `127.0.0.1` (the default) |
| Caddy in the compose `edge` profile | the compose network CIDR (typically inside `172.16.0.0/12`) |
| Caddy on another host | that host's address, e.g. `10.0.2.7` |

Find the compose network's subnet before setting it, rather than guessing:

```bash
docker network inspect "$(docker compose ps -q app \
  | xargs docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')" \
  -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

Set it in `.env` next to `docker-compose.yml` (compose reads it automatically):

```dotenv
TRUSTED_PROXY=172.16.0.0/12
```

Scope it as tightly as the topology allows: every address you trust is an
address that can lie to you about the scheme.

---

## 4. Environment variable surface

Everything the app reads. Anything not listed here is not consulted.

| Variable | Default | Read at | Notes |
|----------|---------|---------|-------|
| `PORT` | `3000` | `src/index.ts` | Listen port. |
| `HOST` | `0.0.0.0` | `src/index.ts` | Listen address. `0.0.0.0` is correct inside a container; the container's *publication* is what must be restricted (term 1). |
| `TRUSTED_PROXY` | `127.0.0.1` | `src/app.ts` | Whose `X-Forwarded-*` headers are believed. See §3. |
| `RETENTION_SWEEP_MS` | `3600000` (1 h) | `src/index.ts` | Cadence of the §11 retention sweep. Cadence only — the 7-day window itself is not env-tunable. |
| `DATABASE_URL` | unset | `src/db/pool.ts` | Preferred when set; passed to `pg` verbatim. |
| `PGHOST` `PGPORT` `PGDATABASE` `PGUSER` `PGPASSWORD` | unset | `pg` (node-postgres) | Fallback used only when `DATABASE_URL` is unset. |
| `NODE_ENV` | `production` in the image | `Dockerfile` runtime stage | Not read by app code directly. |

There is **no** TLS/cert/HTTPS variable in the app: TLS is entirely the edge's
job, and the app must never be asked to terminate it.

Compose-level variables (read by `docker-compose.yml`, not by the app):
`POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT`,
`APP_PORT`, plus `TRUSTED_PROXY` passed through to the app.

[`.env.example`](../.env.example) is the annotated starting point for both
blocks — copy it to `.env` and edit. Two things it makes explicit and this table
does not: `.env` is read by **compose only** (the app has no dotenv dependency,
so running it outside compose means exporting the app-level variables
yourself), and the `cce_validator` database/user/password trio is a published
default that **must** be changed before any public deployment.

---

## 5. Bring-up

### Development (unchanged)

```bash
docker compose up -d postgres   # DB only; db/initdb/*.sql runs on first boot
npm run dev                     # app on :3000, no proxy, TRUSTED_PROXY=127.0.0.1
```

`docker compose up -d` still brings up exactly `postgres` + `app`. The `caddy`
service sits behind the `edge` **profile**, so it never starts unless asked —
that is why it was added to the existing compose file rather than a separate
one: one topology, one file, zero effect on the dev flow.

### Production (with the TLS edge)

1. Edit `deploy/Caddyfile`: replace `validator.example.org` with the real
   hostname, and uncomment/set the ACME `email`.
2. Point DNS at the host; open `:80` and `:443` (`:80` is required for the
   ACME HTTP challenge and for the HTTPS redirect).
3. Set `TRUSTED_PROXY` in `.env` per §3.
4. Stop publishing the app port publicly — bind it to `127.0.0.1` or remove the
   `ports:` entry for `app`.
5. Bring it up and verify:

```bash
docker compose --profile edge up -d
deploy/smoke-proxy-contract.sh https://validator.example.org
```

### Standalone Caddy (no compose)

If Caddy is managed outside compose (host package, existing edge), the same file
still applies — change the upstream from `app:3000` to `127.0.0.1:3000` and run
`caddy run --config deploy/Caddyfile`. The contract, not the packaging, is what
matters; the smoke test is the acceptance criterion either way.

---

## 6. Verifying the contract

```bash
deploy/smoke-proxy-contract.sh https://validator.example.org
```

The script mints a real session on the target and POSTs through the proxy,
asserting each time that the **app** produced the response — its JSON envelope
(`transmissionId`, `findingDetails`, `notice`) rather than a proxy error page:

1. **Oversized body** (1.5 MiB: over §1.4, under the Fastify ceiling) must come
   back as the app's `413` carrying a `"requirement":"1.4"` finding **and** a
   non-null `transmissionId`. A `413` without a finding is the proxy's, and
   means term 2 is violated.
2. **gzip body** must come back with the app's §1.6 *"gzip decoded cleanly"*
   pass finding. A §1.6 *"could not be decompressed"* failure means the edge
   decompressed the request — term 3 violated.
3. **Advisory:** plain HTTP is redirected to HTTPS at the edge.

Run it after every deployment, proxy upgrade, or Caddyfile edit. It is cheap and
it is the only thing standing between a config typo and a stream of wrong
verdicts.

**What it cannot check.** `X-Forwarded-Proto` has no assertable surface today:
§1.1 is classified 🔒 *enforced by us* in the §7 matrix and the app emits no
scheme finding, so term 1 is verified by config review plus `TRUSTED_PROXY`
agreement — not by the script. Check 3 covers only the visible half (the edge
redirect).

**Side effects.** The script creates one session and up to two transmissions of
synthetic data on the target, all reaped by the §11 retention sweep after 7 days
of inactivity. Note that the oversized and undecodable-gzip cases **do** persist
a transmission row today (bd `833`), with `raw_body` holding the raw wire bytes;
the script asserts that reality rather than the absence of a row.

---

## 7. Operational notes

- **Certificates.** Caddy provisions and renews Let's Encrypt certs
  automatically, which is what satisfies DESIGN §12 / Country Guidance
  Attachment 2 (valid certs, no supplier-installed intermediates). The
  `caddydata` volume holds the certs and ACME account — back it up or accept
  re-issuance on volume loss.
- **Retention.** Sessions idle for 7 days are purged with their transmissions
  and findings (`DESIGN.md` §11). Nothing else expires; the DB volume grows with
  active use.
- **Synthetic data only.** The service is for test/sandbox payloads. Capability
  UUIDs are bearer secrets that appear in URLs — and therefore in Caddy's access
  log. Treat the proxy logs accordingly (`DESIGN.md` §12).
- **Caddy version sensitivity.** `deploy/Caddyfile` is `caddy validate`-clean on
  **v2.11.4**, and the full smoke test was run through a real Caddy of that
  version in front of the app. The unbuffered-streaming and
  no-request-decompression behaviours are v2 defaults; confirm both against the
  version you actually deploy with
  `docker compose run --rm caddy caddy validate --config /etc/caddy/Caddyfile`
  before going live. If a build rejects the directive, remove it rather than
  lowering it — unbounded is contract-correct, a low cap is not.
