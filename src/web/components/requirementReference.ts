/**
 * Static frontend reference for the §7 requirements (108.5). The API's
 * `ComplianceRow` carries only a short `summary` — the full spec language and
 * the "how we check it" guidance live nowhere in the response. This map ports
 * that prose from the redesign prototype (`redesign/data.js` REQUIREMENTS) so
 * the ComplianceCard drill-down can render it.
 *
 * SOURCE OF TRUTH for `text`: the 2025 requirements document, "Interoperable CCE
 * Data Delivery - REQUIREMENTS - 20250330" (docs/internal/, gitignored — absent
 * from a fresh clone). Every entry was re-derived from that PDF on 2026-07-31;
 * the prototype's paraphrases had drifted (§4.3 blurred the exact 404/408/409/429
 * carve-out into "most 4xx", §2.2 said "from the logger" where the document says
 * "by the remote data system", §1.3 invented an RFC 6750 Bearer scheme). Quote the
 * document; do NOT restate it in RFC 2119 keywords — the document's own "shall" /
 * "should" / "may" carry its obligation levels and MUST be preserved. Section
 * numbering stays on the 2025 document (decided 2026-07-31); docs/clause-mapping.md
 * carries the DS01.3 correspondence.
 *
 * IMPORTANT — this is a STATIC reference, not data:
 *  - `text` is the spec language, true regardless of traffic, quoted as-is.
 *  - `guidance` is the GENERAL how-we-check-it explanation. The prototype's
 *    guidance interleaved mock-specific statistics ("4 of your transmissions
 *    omitted charset", "One transmission was 1.34 MB", "every request
 *    authenticated", "12 of your transmissions used gzip", "5 transmissions
 *    failed validation", "transferId rtm-4471 delivered 3 times", …). Those
 *    are LIES against real traffic, so they are STRIPPED here — only the
 *    general explanation that holds for any session is kept.
 *
 * Requirement ids are bare (e.g. '1.1', '3.2'); the "§" prefix is display-only.
 * A requirement with no entry here falls back to the row's `summary` and omits
 * the guidance note (handled by the caller).
 */

export interface RequirementReference {
  /** Spec language (verbatim from the requirements doc). */
  text: string;
  /** General how-we-check-it explanation, free of session-specific stats. */
  guidance: string;
}

/** Bare requirement id → spec text + general guidance. */
export const REQUIREMENT_REFERENCE: Record<string, RequirementReference> = {
  '1.1': {
    text: 'Data supplier shall transmit CCE data as UTF-8-encoded JSON via HTTPS POST to the employer system.',
    guidance:
      'HTTPS is terminated at our edge, so non-TLS traffic never reaches the validator — this half is enforced, not a test of your choice. We verify the POST method and that the body parses as UTF-8 JSON from your actual traffic.',
  },
  '1.2': {
    text: 'Data supplier shall specify the content type and character encoding of the request body using the Content-Type HTTP header (e.g., Content-Type: application/json; charset=utf-8).',
    guidance:
      'We inspect the Content-Type header on every POST and grade against the requirement\'s example value. A missing charset, a different media type, or "text/json" all fail.',
  },
  '1.3': {
    text: "Data supplier shall, at employer's discretion, authenticate against employer system by either: posting an access token in an HTTP header specified by the employer (e.g., x-api-key) — the name of the HTTP header should be configurable on a per-country basis — OR using HTTP Basic Authentication (Authentication header).",
    guidance:
      'Auth is opt-in: enable it from the endpoint panel, pick a method there, and we generate the credential for you. Three are offered — an access token in a configurable header (the quoted text\'s first option), HTTP Basic, and "Authorization: Bearer <token>" (RFC 6750), which DS01.3 clause 5.1.5 adds to the two named above. Once enabled we enforce the chosen method and grade §1.3 from real traffic; a credential presented under the wrong scheme fails like a wrong secret. Note the requirement names the Basic credential carrier the "Authentication" header; HTTP Basic in practice uses Authorization, which is what we read.',
  },
  '1.4': {
    text: 'Data supplier shall limit the size of HTTP request bodies to a maximum of 1 megabyte (1MB), measured after any applicable content encoding (e.g., compression) is applied.',
    guidance:
      'We measure the raw request body length (post-compression). Bodies over the cap are rejected with 413. Split large payloads across multiple transmissions or enable gzip.',
  },
  '1.5': {
    text: 'Data supplier shall expect the employer system to use standard HTTP 2xx, 4xx, and 5xx response codes, corresponding to their conventional meanings. Data supplier may receive JSON in the response body, containing additional details.',
    guidance:
      'We return correct status codes, but whether your client interprets them correctly is internal to your system and not observable from the receiving side.',
  },
  '1.6': {
    text: 'If employer system supports it, data supplier may transmit binary Gzip-compressed request bodies with a corresponding HTTP Content-Encoding header (i.e., Content-Encoding: gzip). When transmitting compressed request bodies, data supplier shall NOT further encode (e.g., Base64) the binary request body.',
    guidance: 'We decompress declared gzip bodies and detect illegal double-encoding.',
  },
  '1.7': {
    text: "Data supplier may include custom HTTP headers in their requests. The name of a custom header can be any reasonable value that doesn't conflict with the names of well-defined HTTP headers.",
    guidance:
      'Permissive — there is nothing to grade here. We tolerate any extra headers your stack sends and do not judge their names.',
  },
  '1.8': {
    text: 'Data supplier should NOT send duplicate data to employer system except under the following conditions: data is retransmitted at the explicit request of the employer; data is retransmitted following a delivery failure or when delivery status is ambiguous; a system malfunction, outage, or recovery process necessitates re-sending data to ensure data integrity.',
    guidance:
      'We observe repeated transferId values but cannot judge whether a repeat was a justified retry.',
  },
  '2.1': {
    text: 'To prevent excessive load on the employer system, the data supplier shall, by default, deliver CCE data serially (i.e., no more than one in-flight request at a time). Data supplier may increase concurrency if employer and data supplier mutually agree on a concurrency limit and if data supplier strictly adheres to the agreed limit.',
    guidance:
      'We track concurrent in-flight requests per endpoint to see whether delivery is serial.',
  },
  '2.2': {
    text: 'Data supplier may transmit CCE data in batches on standard intervals. Ideally, data supplier should transmit CCE data (batched or not) to the employer within a few minutes after it is received by the remote data system.',
    guidance:
      'The time your remote data system received the data is unknown to us, so we cannot measure that latency from the receiving side.',
  },
  '2.3': {
    text: 'Data supplier shall send CCE Alarm notifications to employer no more than 15 minutes after the notification is received by the remote data system. When transmitting CCE alarm notifications, data supplier shall include all CCE data that was collected since the last attempted transmission of CCE data for the affected CCE device.',
    guidance:
      'The time the alarm notification reached your remote data system is internal to your platform and not observable here.',
  },
  '3.1': {
    text: 'When sending CCE data to employers, data supplier shall adopt the Data Objects naming conventions and definitions from WHO/PQS/E006/DS01, Annex 1: Cold Chain Data Objects, plus the following additional Data Object definitions: transferId, transferSrc, transferType, schemaVersion, and transferredAt (all required).',
    guidance: 'The schema enforces the transmission metadata block and DS01 object shapes.',
  },
  '3.2': {
    text: 'Data supplier shall transmit JSON messages that can be validated according to the JSON schema published in Attachment 1: Schema for Interoperable CCE Data Transmission. If there are discrepancies between this document and the JSON schema published in Attachment 1, the JSON schema shall take precedence.',
    guidance:
      'This is the core check — Ajv validates each body against the official schema for its declared schemaVersion. Open a failing transmission in the detail pane to see the exact JSON Pointer for each error.',
  },
  '3.3': {
    text: 'Although the JSON-Schema treats many data objects as optional — due largely to variation between monitoring systems — data supplier shall transmit all defined EMS data objects that they collect, including those that are marked as optional. Data supplier should also transmit all custom data objects that are collected, unless employer agrees to the exclusion of those data in part or whole.',
    guidance:
      'We cannot know what you collected, so we cannot prove completeness. We can inventory which objects are present — see the per-transmission object inventory.',
  },
  '3.4': {
    text: 'Data supplier shall transmit CCE data at the same time resolution the data was recorded on the logger. For example, if a logger records data on 15-minute intervals, then the transmitted CCE data shall preserve and reflect that same 15-minute time resolution. Data supplier may provide aggregated or summarised data in addition to the full-fidelity records.',
    guidance:
      'We apply an interval-regularity heuristic on ABST timestamps. This is an inference, not proof.',
  },
  '4.1': {
    text: 'Data supplier shall retry CCE data transmissions that do not receive an HTTP 2xx response from the employer system.',
    guidance:
      'Verifying retry behavior requires us to deliberately return errors and observe your response — an active test mode that is not yet available.',
  },
  '4.2': {
    text: 'Data supplier shall continue to retry failed transmissions at least 6 times over a 24-hour period before abandoning retransmission attempts. Failed transmissions shall NOT block the transmission of other pending or undelivered data (e.g., a single bad payload should not cause data delivery attempts for other payloads to be blocked for 24 hours).',
    guidance: 'Needs the active test harness to inject failures and count retries over time.',
  },
  '4.3': {
    text: 'Data supplier should immediately abandon transmissions that receive a response code from the employer system that is generally associated with a permanent failure condition, as indicated below: HTTP 501 – Not Implemented error; HTTP 505 – HTTP Version Not Supported error; all HTTP 4xx errors, except for HTTP 404, 408, 409, and 429.',
    guidance: 'Requires an active harness returning permanent-failure codes.',
  },
  '4.4': {
    text: 'When retrying failed transmissions, data supplier shall schedule retransmissions using either: exponential backoff with jitter or a uniform backoff interval that is sufficiently long (e.g., multiple minutes) to minimize load on the employer system. […] Data supplier shall describe their selected retry scheduling approach to the employer.',
    guidance:
      'The shape of your backoff needs an active harness to measure; the "describe to employer" half is self-attested.',
  },
  '4.5': {
    text: "In the special case where data supplier receives an HTTP 429 response that include a Retry-After value, data supplier shall schedule the next retry based on whichever interval is longer: the Retry-After value or the remote data system's own computed (or configured) backoff interval.",
    guidance: 'Requires an active harness to emit 429 with Retry-After and observe timing.',
  },
  '4.6': {
    text: 'Data supplier should log all failed transmission attempts, including the response code and error message, for analysis and troubleshooting.',
    guidance: 'Supplier-internal — not observable from the receiving side.',
  },
  '4.7': {
    text: "Data supplier shall provide the employer with an email address to communicate problems or request technical assistance. Data supplier may provide additional communication channels (e.g., phone number, WhatsApp contact, Slack or Discord channel, etc.) at the mutual agreement of data supplier and employer. The data supplier shall provide employer with a Service Level Agreement (SLA) to document data supplier's response-time obligations on provided channel(s).",
    guidance: 'Supplier-internal / contractual — not observable here.',
  },
  '4.8': {
    text: 'Data supplier shall monitor the status of CCE data transmission to employer system.',
    guidance: 'Supplier-internal — not observable here.',
  },
  '4.9': {
    text: "Data supplier's monitoring processes shall notify data supplier staff when CCE data transmission failures exceed a configurable threshold (e.g., failure rate exceeds 10% over a rolling 60-minute period). Data supplier shall notify affected employer(s) within 48 hours when data supplier detects an elevated rate of CCE data transmission failures.",
    guidance: 'Supplier-internal — not observable here.',
  },
  '5.1': {
    text: 'At the request of the employer, data supplier shall retransmit CCE data that was captured within the most recent six months of time. This is intended primarily as an emergency option for the employer (e.g., in cases where employer system is offline for an extended period; or for populating new systems with historical data).',
    guidance: 'Needs a guided retransmission scenario (active test mode).',
  },
  '5.2': {
    text: 'Data supplier shall be able to filter the retransmitted CCE data to include only a specific time range within the indicated six-month period. For example, employer shall be able to request retransmission of data for one or more CCE during a period of time specified by a beginning and an ending date or datetime.',
    guidance: 'Needs a guided retransmission scenario.',
  },
  '5.3': {
    text: 'Data supplier shall be able to filter the retransmitted data to include either: all CCE data, including CCE data that was previously sent successfully, or only CCE data that was never transmitted successfully.',
    guidance: 'Needs a guided retransmission scenario.',
  },
};

/** Look up the static reference for a bare requirement id, or `undefined`. */
export function getRequirementReference(id: string): RequirementReference | undefined {
  return REQUIREMENT_REFERENCE[id];
}
