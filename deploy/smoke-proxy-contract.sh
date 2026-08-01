#!/usr/bin/env bash
#
# smoke-proxy-contract.sh — verify the DESIGN.md §4.1 edge/proxy contract holds
# against a RUNNING deployment (deploy/Caddyfile + docs/deployment.md).
#
# A misconfigured proxy does not announce itself: it silently turns this service
# into a source of wrong conformance verdicts. This script forces the two
# contract terms that are observable from outside to show themselves, by POSTing
# through the proxy and asserting the APP produced the response — the app's JSON
# envelope (transmissionId / findingDetails / notice, src/ingest/pipeline.ts
# buildResponseBody) rather than a bare proxy error page.
#
# Checks:
#   1. Oversized body (>1 MiB, <2 MiB) → the APP's teaching 413 carrying a §1.4
#      finding. A proxy body cap would instead return its own opaque 413 with no
#      finding and no persisted transmission.
#   2. gzip body → the APP's §1.6 "decoded cleanly" PASS finding. A proxy that
#      decompressed the request would leave Content-Encoding: gzip on plaintext,
#      and the app would emit a §1.6 FAIL against a supplier who did nothing
#      wrong.
#   3. (https targets only, advisory) plain HTTP is redirected to HTTPS at the
#      edge — the visible half of contract term 1. Note that X-Forwarded-Proto
#      itself has no assertable surface today: §1.1 is graded "enforced by us"
#      and the app emits no scheme finding (src/ingest/stages/method.ts), so
#      term 1 is verified by config review + TRUSTED_PROXY agreement, not here.
#
# Usage:  deploy/smoke-proxy-contract.sh https://validator.example.org
#         BASE_URL=http://localhost:3000 deploy/smoke-proxy-contract.sh
#
# Requires: bash, curl, gzip. Mints a real (synthetic-data) session on the
# target, which the §11 retention sweep reaps after 7 days of inactivity.
#
# Note: an over-cap POST DOES persist a transmission row today (bd 833) — the
# check below therefore expects a non-null transmissionId, not the absence of one.

set -euo pipefail

BASE_URL="${1:-${BASE_URL:-}}"
if [ -z "$BASE_URL" ]; then
	echo "usage: $0 <base-url>   e.g. $0 https://validator.example.org" >&2
	exit 2
fi
BASE_URL="${BASE_URL%/}"

for tool in curl gzip; do
	command -v "$tool" >/dev/null 2>&1 || {
		echo "FATAL: $tool is required" >&2
		exit 2
	}
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() {
	printf 'FAIL  %s\n' "$1" >&2
	failures=$((failures + 1))
}
info() { printf '      %s\n' "$1"; }

# POST $2 (a file) to $1 with the extra curl args in $3.. ; writes the response
# body to $TMP/body and echoes the HTTP status. `-H Expect:` suppresses curl's
# 100-continue on large bodies (it only adds a stall here).
post_file() {
	local url="$1" file="$2"
	shift 2
	curl -sS -o "$TMP/body" -w '%{http_code}' \
		-X POST "$url" \
		-H 'Expect:' \
		--data-binary "@$file" \
		"$@"
}

body_has() { grep -qF -- "$1" "$TMP/body"; }
body_excerpt() { head -c 400 "$TMP/body"; echo; }

echo "== §4.1 proxy-contract smoke test =="
echo "target: $BASE_URL"
echo

# ---------------------------------------------------------------------------
# Setup: mint a session (also proves /api reaches the app through the proxy).
# ---------------------------------------------------------------------------
status="$(curl -sS -o "$TMP/body" -w '%{http_code}' -X POST "$BASE_URL/api/sessions")"
if [ "$status" != "201" ]; then
	fail "could not mint a session: POST /api/sessions returned $status"
	info "$(body_excerpt)"
	exit 1
fi
UUID="$(tr -d '\n' <"$TMP/body" | sed -n 's/.*"uuid":"\([0-9a-fA-F-]*\)".*/\1/p')"
if [ -z "$UUID" ]; then
	fail "could not read uuid out of the session response"
	info "$(body_excerpt)"
	exit 1
fi
INGEST="$BASE_URL/i/$UUID"
pass "session minted ($UUID); /api reaches the app through the proxy"

# ---------------------------------------------------------------------------
# Check 1 — oversized body reaches the APP, not the proxy's 413.
#   1.5 MiB of padding: over the §1.4 grading cap (1 MiB) and under the app's
#   Fastify bodyLimit (2 MiB), i.e. the window in which the app owes a finding.
# ---------------------------------------------------------------------------
{
	printf '{"pad":"'
	head -c 1572864 /dev/zero | tr '\0' 'x'
	printf '"}'
} >"$TMP/big.json"

status="$(post_file "$INGEST" "$TMP/big.json" -H 'Content-Type: application/json; charset=utf-8')"
if [ "$status" != "413" ]; then
	fail "oversized POST returned $status, expected the app's 413"
	info "$(body_excerpt)"
elif ! body_has '"requirement":"1.4"'; then
	fail "413 carried no §1.4 finding — this looks like the PROXY's 413, not the app's"
	info "the edge is capping request bodies below the app's threshold; see contract term 2"
	info "$(body_excerpt)"
elif ! body_has '"findingDetails"'; then
	fail "413 body is not the app's envelope (no findingDetails) — a proxy answered"
	info "$(body_excerpt)"
elif body_has '"transmissionId":null'; then
	fail "413 persisted no transmission (transmissionId null) — expected a recorded row"
	info "$(body_excerpt)"
else
	pass "oversized POST → the APP's 413 with a §1.4 finding and a persisted row"
fi

# ---------------------------------------------------------------------------
# Check 2 — a gzip body arrives still compressed (no edge decompression).
#   The payload need not be schema-valid: stage 5 (encoding) runs before parse
#   and schema, so the §1.6 PASS finding is present whatever the later verdict.
# ---------------------------------------------------------------------------
printf '{"meta":{"schemaVersion":"0.8.1"},"smoke":"proxy-contract"}' >"$TMP/small.json"
gzip -c "$TMP/small.json" >"$TMP/small.json.gz"

status="$(post_file "$INGEST" "$TMP/small.json.gz" \
	-H 'Content-Type: application/json; charset=utf-8' \
	-H 'Content-Encoding: gzip')"
if ! body_has '"findingDetails"'; then
	fail "gzip POST returned $status without the app's JSON envelope — a proxy answered"
	info "$(body_excerpt)"
elif body_has 'could not be decompressed'; then
	fail "app reports the gzip body as undecodable (status $status)"
	info "the edge decompressed the request body; §1.6/§1.4 now grade bytes the supplier never sent"
	info "$(body_excerpt)"
elif ! body_has 'gzip decoded cleanly'; then
	fail "no §1.6 pass finding in the response (status $status)"
	info "expected the app's 'Content-Encoding gzip decoded cleanly' finding"
	info "$(body_excerpt)"
else
	pass "gzip POST → the APP decoded it itself (§1.6 pass); bytes arrived as sent"
fi

# ---------------------------------------------------------------------------
# Check 3 (advisory) — plain HTTP is redirected to HTTPS at the edge.
# ---------------------------------------------------------------------------
case "$BASE_URL" in
https://*)
	plain="http://${BASE_URL#https://}"
	status="$(curl -sS -o /dev/null -w '%{http_code}' "$plain/health" || echo 000)"
	case "$status" in
	301 | 302 | 307 | 308) pass "plain HTTP is redirected to HTTPS at the edge ($status)" ;;
	000) info "ADVISORY: plain HTTP did not answer at all (also acceptable)" ;;
	*) info "ADVISORY: http://.../health returned $status — expected a redirect to https" ;;
	esac
	;;
*)
	info "ADVISORY: target is not https:// — skipping the edge-redirect check"
	;;
esac

echo
if [ "$failures" -ne 0 ]; then
	echo "== $failures contract check(s) FAILED — do not accept verdicts from this deployment =="
	exit 1
fi
echo "== proxy contract holds =="
