/**
 * Static frontend reference for the §7 requirements (108.5). The API's
 * `ComplianceRow` carries only a short `summary` — the full spec language and
 * the "how we check it" guidance live nowhere in the response. This map ports
 * that prose from the redesign prototype (`redesign/data.js` REQUIREMENTS) so
 * the ComplianceCard drill-down can render it.
 *
 * IMPORTANT — this is a STATIC reference, not data:
 *  - `text` is the spec language, true regardless of traffic, ported as-is.
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
    text: 'Data MUST be delivered to the receiving system by HTTP POST over TLS (HTTPS). The request body MUST be a valid UTF-8 JSON document.',
    guidance:
      'HTTPS is terminated at our edge, so non-TLS traffic never reaches the validator — this half is enforced, not a test of your choice. We verify the POST method and that the body parses as UTF-8 JSON from your actual traffic.',
  },
  '1.2': {
    text: 'Each request MUST carry a Content-Type header of exactly "application/json; charset=utf-8".',
    guidance:
      'We inspect the Content-Type header on every POST. A missing charset, a different media type, or "text/json" all fail.',
  },
  '1.3': {
    text: 'When the receiving system requires authentication, the supplier MUST present a bearer token (in an agreed header) or HTTP Basic credentials on every request.',
    guidance:
      'Auth is opt-in: enable it from the endpoint panel and we generate a credential for you. Once enabled, we enforce it and grade §1.3 from real traffic.',
  },
  '1.4': {
    text: 'The request body MUST NOT exceed 1 MB measured on the wire — i.e. after any Content-Encoding is applied.',
    guidance:
      'We measure the raw request body length (post-compression). Bodies over the cap are rejected with 413. Split large payloads across multiple transmissions or enable gzip.',
  },
  '1.5': {
    text: 'The supplier MUST treat standard HTTP status families as defined: 2xx success, 4xx client error, 5xx server error.',
    guidance:
      'We return correct status codes, but whether your client interprets them correctly is internal to your system and not observable from the receiving side.',
  },
  '1.6': {
    text: 'Compression, if used, MUST be declared with Content-Encoding: gzip. Bodies MUST NOT be double-encoded (e.g. base64 wrapped around gzip).',
    guidance: 'We decompress declared gzip bodies and detect illegal double-encoding.',
  },
  '1.7': {
    text: 'Suppliers MAY include additional custom headers. The receiving system MUST tolerate them.',
    guidance:
      'Permissive — there is nothing to grade here. Send whatever extra headers your stack needs.',
  },
  '1.8': {
    text: 'A supplier MUST NOT deliver duplicate transmissions except under explicitly allowed conditions (e.g. retry after an ambiguous failure).',
    guidance:
      'We observe repeated transferId values but cannot judge whether a repeat was a justified retry.',
  },
  '2.1': {
    text: 'By default, transmissions SHOULD be delivered serially — one in flight at a time per endpoint — unless the receiver negotiates concurrency.',
    guidance:
      'We track concurrent in-flight requests per endpoint to see whether delivery is serial.',
  },
  '2.2': {
    text: 'Data SHOULD be transmitted within minutes of being received from the logger.',
    guidance:
      'The time you received data from the logger is unknown to us, so we cannot measure end-to-end latency from the receiving side.',
  },
  '2.3': {
    text: 'Alarm conditions MUST be transmitted within 15 minutes, including any data accumulated since the last successful transmission.',
    guidance: 'Alarm origin time is internal to the logger/supplier and not observable here.',
  },
  '3.1': {
    text: 'Transmissions MUST adopt the PQS DS01 data objects and include the required transmission metadata fields (meta.*).',
    guidance: 'The schema enforces the meta block and DS01 object shapes.',
  },
  '3.2': {
    text: 'Every transmission MUST validate against the published Interoperable CCE Data Delivery JSON Schema for its declared schemaVersion.',
    guidance:
      'This is the core check — Ajv validates each body against the official schema for its meta.schemaVersion. Open a failing transmission in the detail pane to see the exact JSON Pointer for each error.',
  },
  '3.3': {
    text: 'Suppliers MUST transmit all data objects they collect, not a filtered subset.',
    guidance:
      'We cannot know what you collected, so we cannot prove completeness. We can inventory which objects are present — see the per-transmission object inventory.',
  },
  '3.4': {
    text: 'Transmitted data MUST preserve the time resolution of the original logger readings (no downsampling).',
    guidance:
      'We apply an interval-regularity heuristic on ABST timestamps. This is an inference, not proof.',
  },
  '4.1': {
    text: 'On any non-2xx response, the supplier MUST retry delivery.',
    guidance:
      'Verifying retry behavior requires us to deliberately return errors and observe your response — an active test mode that is not yet available.',
  },
  '4.2': {
    text: 'The supplier MUST attempt at least 6 retries within 24 hours without blocking other transmissions.',
    guidance: 'Needs the active test harness to inject failures and count retries over time.',
  },
  '4.3': {
    text: 'On permanent failures (e.g. 501, 505, most 4xx) the supplier MUST stop retrying.',
    guidance: 'Requires an active harness returning permanent-failure codes.',
  },
  '4.4': {
    text: 'Retries MUST use a backoff strategy, and the supplier MUST describe that strategy to the employer/country.',
    guidance:
      'The shape of your backoff needs an active harness to measure; the "describe to employer" half is self-attested.',
  },
  '4.5': {
    text: 'On a 429 response, the supplier MUST honor Retry-After, waiting the longer of its own backoff and the header value.',
    guidance: 'Requires an active harness to emit 429 with Retry-After and observe timing.',
  },
  '4.6': {
    text: 'Suppliers MUST log failed delivery attempts.',
    guidance: 'Supplier-internal — not observable from the receiving side.',
  },
  '4.7': {
    text: 'Suppliers MUST provide a support contact email and a stated service-level agreement.',
    guidance: 'Supplier-internal / contractual — not observable here.',
  },
  '4.8': {
    text: 'Suppliers MUST monitor the status of their transmissions.',
    guidance: 'Supplier-internal — not observable here.',
  },
  '4.9': {
    text: 'On elevated failure rates the supplier MUST notify their staff and the employer/country.',
    guidance: 'Supplier-internal — not observable here.',
  },
  '5.1': {
    text: 'On request, the supplier MUST be able to retransmit the last 6 months of data.',
    guidance: 'Needs a guided retransmission scenario (active test mode).',
  },
  '5.2': {
    text: 'Retransmission MUST be filterable by an arbitrary time range.',
    guidance: 'Needs a guided retransmission scenario.',
  },
  '5.3': {
    text: 'Retransmission MUST distinguish "all data" from "data never successfully sent".',
    guidance: 'Needs a guided retransmission scenario.',
  },
};

/** Look up the static reference for a bare requirement id, or `undefined`. */
export function getRequirementReference(id: string): RequirementReference | undefined {
  return REQUIREMENT_REFERENCE[id];
}
