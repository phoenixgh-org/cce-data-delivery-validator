/**
 * Static frontend reference for the 27 DS01.3 clauses the grading lens renders
 * (tfnv.9). The DS01.3 sibling of `requirementReference.ts`: same shape, same
 * two rules, different document. `getRequirementReference` falls through to this
 * table when the 2025 table has no entry for an id, which is safe because the
 * two key spaces are disjoint — a DS01.3 key is always `5.x.y`, a 2025 key never
 * is.
 *
 * SOURCE OF TRUTH for `text`: the DS01.3 review draft, revision 29-Jul-2026,
 * read with its tracked changes ACCEPTED — the same reading `docs/clause-
 * mapping.md` quotes from. Every entry was transcribed from that file, not
 * retyped from memory or paraphrased.
 *
 * PROVENANCE — THIS IS A PREVIEW DRAFT. WHO/PQS/E006/DS01.3 is unpublished. The
 * text below is quoted from a draft under review and is NOT the published
 * standard; it may change, including in ways that change what conformance means.
 * {@link DS013_REFERENCE_SOURCE} carries the revision and that caveat so the
 * drill-down can say so on screen rather than leaving a reader to assume the
 * words are final. The draft itself is never fetched at runtime and is not
 * vendored here; it lives outside the repo.
 *
 * ON THE RE-PIN CHECKLIST. The Annex 4 delivery schema
 * (`src/schemas/pqs-e006-ds01-annex4-1.json`) is the one file in this repo that
 * MAY be replaced in place when the proposal is revised. When that happens the
 * clause text usually moved too: re-transcribe this module from the new draft,
 * verify §5.1 numbering against the accepted-changes rendering of that revision,
 * update {@link DS013_REFERENCE_SOURCE}'s revision, and re-run the tests. See
 * `CLAUDE.md` ("One exception, for drafts only") and `DESIGN.md` §9.5.
 *
 * QUOTING RULES, inherited from the 2025 table:
 *  - `text` is the clause's own words, including its "shall" / "should" / "may".
 *    Do NOT restate a clause in RFC 2119 keywords — the draft's own obligation
 *    levels carry its meaning. Sub-bullets are quoted inline, separated the way
 *    the 2025 table separates them, because the drill-down renders one
 *    paragraph. The metadata table under 5.3.3 is described in `guidance`
 *    rather than reproduced.
 *  - `guidance` is the GENERAL how-we-check-it explanation and holds for any
 *    session. It never carries session statistics ("4 of your transmissions
 *    …"), which would be a lie against real traffic.
 *  - A tightened clause says what tightened, from `docs/clause-mapping.md`'s
 *    tightened table. A clause with no 2025 equivalent says so, and says what
 *    the receiving side can and cannot establish about it — DESIGN §7's honesty
 *    rule: no confident verdict where nothing was observed.
 *
 * NUMBERING. Keys are the clause ids `DS013_TITLE` and `docs/clause-mapping.md`
 * carry, which is what `DS013_MATRIX` keys its rows by; the join is asserted in
 * `ds013Reference.test.ts`. They are the ACCEPTED-CHANGES numbering of the
 * 29-Jul-2026 review draft, the same reading the quoted text comes from: the
 * draft deletes the "Content type and character encoding" heading and folds its
 * one sentence into 5.1.3, and a deleted heading is not counted, so §5.1 runs
 * 5.1.1 through 5.1.11 with no gap. An All Markup view of the same draft still
 * numbers that heading, and every §5.1 clause from 5.1.4 "Authentication" onward
 * reads one higher there; a reader comparing this table against the redline will
 * find that off-by-one and nothing else. Decided 2026-09-18 (tfnv.20), and
 * `docs/clause-mapping.md` carries the full provenance note.
 */
import { CONTRACT_PROFILE } from '../api';
import { PROFILE_NAME } from '../profiles';
import type { RequirementReference } from './requirementReference';

/** The contract lineage's reader-facing name, never spelled out at a call site. */
const CONTRACT_NAME = PROFILE_NAME[CONTRACT_PROFILE];

/** Where the quoted clause text came from, for the drill-down's provenance line. */
export const DS013_REFERENCE_SOURCE = {
  /** The draft revision transcribed, as the document names itself. */
  revision: '29-Jul-2026',
  /** The caveat that goes with every quotation below. */
  note: 'Quoted from an unpublished preview draft of WHO/PQS/E006/DS01.3; not the published text.',
} as const;

/** DS01.3 clause id → draft clause text + general guidance. */
export const DS013_REFERENCE: Record<string, RequirementReference> = {
  '5.1.1': {
    text: 'The employer shall have exclusive rights in determining who may access all data hosted by the supplier. The supplier shall make all recorded data available to third parties at the request of the employer.',
    guidance: `New in DS01.3, with no counterpart in ${CONTRACT_NAME}. Who may access the data you host is settled between employer and supplier in contract, and a receiving endpoint sees nothing of it. We record the clause and take it as attested.`,
  },
  '5.1.2': {
    text: 'When requested by the employer, the supplier providing remote communication services shall regularly send cold chain data via a HTTPS POST request to a universal resource locator (URL) endpoint, using access credentials and URL endpoint defined by the employer. This URL endpoint may be used by third-party management information systems (e.g. LMIS) to consolidate multiple streams of monitoring system data (e.g. separate remote monitoring providers). Alternate industry-standard data transmission methods, such as MQTT, AMQP, Web Sockets, etc., may be utilized instead of HTTPS if there is agreement from both the employer and the supplier, but HTTPS must remain an available option.',
    guidance: `New in DS01.3, with no counterpart in ${CONTRACT_NAME}. The half we can see is enforced rather than graded: this endpoint accepts HTTPS POST only, so a transmission that reaches us arrived over the transport the clause requires. Whether an alternate transport was agreed with the employer, and whether HTTPS stayed available alongside it, happens outside the traffic we receive.`,
  },
  '5.1.3': {
    text: 'Supplier shall transmit data to the employer system as UTF-8-encoded JSON via HTTPS POST, specifying the content type and character encoding in the Content-Type HTTP header (e.g., Content-Type: application/json; charset=utf-8).',
    guidance:
      "HTTPS is terminated at our edge, so non-TLS traffic never reaches the validator — that half is enforced, not a test of your choice. From your actual traffic we verify the POST method, that the body parses as UTF-8 JSON, and the Content-Type header against the clause's example value. A missing charset, a different media type, or “text/json” all fail. DS01.3 states the format and the header duty in one clause, so we grade them as one row.",
  },
  '5.1.4': {
    text: 'Supplier shall, at employer’s discretion, authenticate against employer system by one of the following methods. The employer shall specify the desired method and supply the credentials: Bearer token. Supplier sends an employer-issued token in the standard Authorization header using the Bearer scheme (RFC 6750): Authorization: Bearer <token>; HTTP Basic Authentication. Supplier sends an encoded credential in the standard Authorization header using the Basic scheme (RFC 7617): Authorization: Basic <base64(username:password)>; API token in a configurable header. Supplier sends an employer-issued token in an HTTP header whose name is configurable on a per-employer basis (e.g., x-api-key: <token>).',
    guidance:
      'Auth is opt-in: enable it from the endpoint panel, pick a method there, and we generate the credential for you. All three methods this clause names are offered — Bearer (RFC 6750), HTTP Basic (RFC 7617), and an access token in a header whose name you choose. Once enabled we enforce the chosen method and grade it from real traffic; a credential presented under the wrong scheme fails like a wrong secret.',
  },
  '5.1.5': {
    text: 'Supplier shall limit the size of HTTP request bodies to 1 megabyte as measured after any applicable content encoding (e.g., compression) is applied.',
    guidance:
      'We measure the raw request body length, after any content encoding. Bodies over the 1 MB cap are rejected with 413. Split large payloads across multiple transmissions or enable gzip.',
  },
  '5.1.6': {
    text: 'The employer system is expected to respond using standard HTTP status codes in accordance with their conventional meanings. Supplier shall interpret responses as follows: 2xx (Success). Any 2xx response indicates the employer system has accepted responsibility for the transmitted data; supplier shall treat the transmission as delivered successfully. 3xx (Redirection). Supplier shall not automatically follow 3xx redirects for POST requests. An unexpected redirect shall be treated as a configuration issue to be logged and resolved with the employer. 4xx and 5xx (Client and server errors). Supplier shall apply the retry and abandonment rules defined in Clause 5.4.1. The employer system may provide a response body providing additional detail. Supplier shall not depend on the presence or structure of the response body to determine delivery success or failure; the HTTP status code is authoritative for that purpose.',
    guidance:
      'We return correct status codes, but how your client reads them is internal to your system and not observable from the receiving side: treating any 2xx as delivered, declining to follow a 3xx redirect on a POST, and trusting the status code over the response body are all decisions taken inside your platform.',
  },
  '5.1.7': {
    text: 'If employer system supports it, supplier may transmit binary Gzip-compressed request bodies with a corresponding HTTP Content-Encoding header (i.e., Content-Encoding: gzip). When transmitting compressed request bodies, supplier shall not further encode (e.g., Base64) the binary request body.',
    guidance: 'We decompress declared gzip bodies and detect illegal double-encoding.',
  },
  '5.1.8': {
    text: 'Supplier may include custom HTTP headers in their requests. The naming of custom headers can be any reasonable value that doesn’t conflict with the names of well-defined HTTP headers. Custom headers shall not carry information that is required by employers to correctly process the payload.',
    guidance:
      'Permissive — there is nothing to grade here. We tolerate any extra headers your stack sends and do not judge their names. Whether a custom header carries something the employer needs in order to process the payload is a property of your integration with that employer, not of a request we can inspect.',
  },
  '5.1.9': {
    text: 'Supplier shall not send duplicate data to employer system except under the following conditions: Data is retransmitted at the explicit request of the employer. Data is retransmitted following a delivery failure or an ambiguous delivery status. A system malfunction, outage, or recovery process necessitates re-sending data to ensure data integrity.',
    guidance: `We observe repeated transferId values but cannot judge whether a repeat was a justified retry. Tightened from ${CONTRACT_NAME}: not sending duplicates moves from “should” to “shall”. The three exception conditions are unchanged, and so is the limit on what a receiver can establish about a repeat.`,
  },
  '5.1.10': {
    text: 'Data should be sent to the employer within 24 hours of receiving it (or at an alternative minimum frequency otherwise specified by the employer). Note that delays in or disruptions to communications networks may result in variable latency, so the minimum specified frequency should be considered a “best effort” specification.',
    guidance: `New in DS01.3, with no counterpart in ${CONTRACT_NAME}. The clause sets an outer bound of 24 hours from the moment your platform receives the data, and that moment is unknown here, so the interval cannot be measured from the receiving side. We take it as attested. It does not displace clause 5.2.2's “within a few minutes”, which the draft keeps.`,
  },
  '5.1.11': {
    text: 'The supplier may define an application programming interface (API) where the employer or their designees can pull data, but this alone does not satisfy the requirement for remote communication service providers to send data to the URL provided by the employer or their designee. If the supplier implements a pull-based API, that API shall provide a method for employers to fetch data in a JSON format that is compliant with the JSON schema in Annex 4: Schema for Interoperable CCE Data Transmission.',
    guidance: `New in DS01.3, with no counterpart in ${CONTRACT_NAME}, and not graded. A pull API is optional, it does not discharge the duty to push, and an API served elsewhere in your platform leaves no trace in the traffic that arrives here. Everything this service grades is what you delivered to the endpoint.`,
  },
  '5.2.1': {
    text: 'To prevent excessive load on the employer system, the supplier shall, by default, deliver data serially (i.e., no more than one in-flight request at a time). Supplier may increase concurrency if employer and supplier mutually agree on a rate-limiting strategy and if supplier strictly adheres to the agreed limit.',
    guidance:
      'We track concurrent in-flight requests per endpoint to see whether delivery is serial. An agreed rate-limiting strategy is a private arrangement between you and the employer, so a higher concurrency is graded against the default rather than against an agreement we cannot see.',
  },
  '5.2.2': {
    text: 'Supplier may transmit data in batches on standard intervals. Ideally, supplier should transmit data (batched or not) to the employer within a few minutes after it is received by the supplier’s platform.',
    guidance:
      'The time your platform received the data is unknown to us, so we cannot measure that latency from the receiving side.',
  },
  '5.2.3': {
    text: 'Supplier shall send alarm notifications to employer no more than 15 minutes after the notification is received by supplier’s platform. When transmitting alarm notifications, supplier shall include all data that was collected since the last attempted transmission of data for the affected CCE.',
    guidance:
      'The time the alarm notification reached your platform is internal to your system and not observable here.',
  },
  '5.3.1': {
    text: 'Each HTTPS POST shall contain a JSON payload that contains all monitored data objects, alarms, and error codes.',
    guidance: `New in DS01.3, with no counterpart in ${CONTRACT_NAME}. The structural half — that the payload carries the objects, alarms and error codes the schema defines — is graded under clause 5.3.2 against the schema for the declared schemaVersion, and we do not grade it twice. What this clause adds beyond that is completeness, which depends on what your devices recorded and is not knowable from a payload, so we take it as attested.`,
  },
  '5.3.2': {
    text: 'Supplier shall transmit JSON messages that can be validated according to the JSON schema in Annex 4: Schema for Interoperable CCE Data Transmission. If there are discrepancies between this document and the JSON schema published in Annex 4, the supplier shall notify the employer of any discrepancies.',
    guidance: `This is the core check — each body is validated against the schema for its declared schemaVersion. Open a failing transmission in the detail pane to see the exact JSON Pointer for each error. Tightened from ${CONTRACT_NAME}: the rule that the schema takes precedence over the prose is replaced by a duty to notify the employer of any discrepancy, and no successor tiebreaker is supplied. This service keeps grading against the schema; a discrepancy you believe exists belongs in that notification and in PQS channels, not in the grading here.`,
  },
  '5.3.3': {
    text: 'When sending data to external systems, supplier shall adopt the data objects naming conventions and definitions in Annex 1: Cold Chain Data Objects. Supplier shall also provide the following transmission metadata fields, which reside in the transmission envelope (meta).',
    guidance: `The transmission envelope and the DS01 object shapes are graded under clause 5.3.2, against the schema for the declared schemaVersion, so they are not graded again here. What lands on this row is the rest of the clause: the transmission-metadata duties the schema check does not settle, and object names that depart from the DS01 naming convention, which we note informationally rather than as a failure. The duty to describe manufacturer-specific data objects with a schema in meta.customDataSchema is graded under clause 5.3.5, which DS01.3 separates out from this clause, so a payload carrying custom objects without that declaration fails there and not here. Tightened from ${CONTRACT_NAME}: meta.customDataSchema is added, transferredAt is narrowed to UTC RFC 3339 carrying the “Z” specifier, the ems/rtm choice in transferType moves from “should” to “shall”, and the metadata fields are fixed in the meta envelope. The clause continues with a table defining transferId, transferSrc, transferType, schemaVersion, transferredAt and customDataSchema.`,
  },
  '5.3.4': {
    text: 'Although the JSON-Schema treats many data objects as optional – due largely to variation between monitoring systems – supplier shall transmit all defined EMS data objects that they recorded, including those that are marked as optional. Supplier should also transmit all custom data objects that are collected unless employer agrees to the exclusion of this data in part or whole.',
    guidance:
      'We cannot know what your devices recorded, so we cannot prove completeness. We can inventory which objects are present — see the per-transmission object inventory.',
  },
  '5.3.5': {
    text: 'If a payload contains manufacturer-specific data objects, supplier shall provide a JSON schema describing these objects in the meta.customDataSchema property (see Clause 5.3.3).',
    guidance: `New in DS01.3, with no counterpart in ${CONTRACT_NAME}, and the one new clause the receiving side can verify: it is the duty already checked under clause 5.3.3, where a payload carrying manufacturer-specific object names without meta.customDataSchema fails and a payload carrying none passes as not applicable. The declaration is recorded, never dereferenced, and your custom objects are never validated against it.`,
  },
  '5.3.6': {
    text: 'Supplier shall transmit data at the same time resolution the data was recorded on the monitoring device. For example, if an EMS logger records data on 15-minute intervals, then the transmitted data shall preserve and reflect that same 15-minute time resolution. Supplier may provide aggregated or summarised data in addition to the full-fidelity records.',
    guidance:
      'We apply an interval-regularity heuristic on ABST timestamps. This is an inference, not proof.',
  },
  '5.4.1': {
    text: 'Supplier shall retry data transmissions that receive an HTTP 4xx or 5xx response from the employer system, or that receive no response (e.g., connection failure or timeout), except for the permanent failure codes below, which supplier shall not retry. HTTP 501 – Not Implemented error; HTTP 505 – HTTP Version Not Supported error; All HTTP 4xx errors, except for 404, 408, 409, 429. Supplier shall retry a failed transmission at least 6 times over a 24-hour period before abandoning it. A failed transmission shall not block the transmission of other pending or undelivered data (e.g., a single bad payload should not cause data delivery attempts for other payloads to be blocked for 24 hours).',
    guidance: `Verifying retry behavior requires us to deliberately return errors and observe what you do next — an active test mode that is not yet available. DS01.3 states retrying, the retry count and abandonment in one clause, and none of the three is observable passively: a transmission we never received leaves no record here. Tightened from ${CONTRACT_NAME}: abandoning a permanent-failure response moves from “should” to “shall not retry”. The response-code list is unchanged.`,
  },
  '5.4.2': {
    text: 'When retrying failed transmissions, supplier shall schedule retransmissions using either: exponential backoff with jitter or a uniform backoff interval that is sufficiently long (e.g., multiple minutes) to minimize load on downstream systems. In the special case where supplier receives an HTTP 429 response that include a Retry-After value, supplier shall schedule the next retry based on whichever interval is longer: the Retry-After value or the system’s own computed (or configured) backoff interval. For the avoidance of doubt, “exponential backoff with jitter” indicates a scheduling approach where the interval between transmission attempts increases according to an exponential function and random jitter is added to each delay to avoid synchronized retries from multiple clients. In contrast, a “uniform backoff interval” uses a static interval to schedule all retry attempts. Data supplier shall describe their selected retry scheduling approach to the employer.',
    guidance:
      'The shape of your backoff, and the Retry-After rule for an HTTP 429 folded into this clause, both need an active harness to measure; the duty to describe your chosen approach to the employer is self-attested.',
  },
  '5.4.3': {
    text: 'Supplier should log all failed transmission attempts, including the response code and error message, for analysis and troubleshooting.',
    guidance: 'Supplier-internal — not observable from the receiving side.',
  },
  '5.4.4': {
    text: 'At the request of the employer, supplier shall retransmit data that was captured within the most recent six months of time. This is intended primarily as an emergency option for the employer (e.g., in cases where Employer System is offline for an extended period; or for populating new systems with historical data). At minimum, supplier shall be able to manually retransmit all employer data captured between specified begin/end times for one or more CCE, including an option to limit retransmissions either to data that was previously sent successfully or to data that was never sent successfully.',
    guidance:
      'Needs a guided retransmission scenario, which is an active test mode and not yet available. DS01.3 merges the six-month window and both filters into one clause and states that manual retransmission satisfies it, so there is no interface here to exercise even once that mode exists.',
  },
  '5.4.5': {
    text: 'Supplier shall provide the employer with an email address to communicate problems or request technical assistance. Supplier may provide additional communication channels (e.g., phone number, WhatsApp contact, Slack or Discord channel, etc.) at the mutual agreement of supplier and employer. The supplier shall provide employer with a Service Level Agreement to document supplier’s response-time obligations on provided channel(s).',
    guidance: 'Supplier-internal and contractual — not observable here.',
  },
  '5.4.6': {
    text: 'Supplier shall monitor the status of data transmission to employer system.',
    guidance: 'Supplier-internal — not observable here.',
  },
  '5.4.7': {
    text: 'Supplier’s monitoring process shall notify supplier staff when data transmission failures exceed a configurable threshold (e.g., failure rate exceeds 10% over a rolling 60-minute period). Supplier shall notify affected employers within 48 hours when supplier detects an elevated rate of data transmission failures.',
    guidance: 'Supplier-internal — not observable here.',
  },
};
