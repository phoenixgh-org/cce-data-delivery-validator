/**
 * Thin typed repository over the first-boot schema (db/initdb, DESIGN.md §8).
 *
 * Deliberately NO business logic — just typed CRUD wrappers around SQL, so the
 * later milestones (ingest persistence 3bn.7, sessions API 43b.1, retention
 * yhg.1) have a typed surface to call. The pipeline/grading lives in those
 * milestones, not here.
 */

import type { Pool, PoolClient } from 'pg';

import { getPool } from './pool.js';

/** Anything we can run a query against: the pool or a checked-out client. */
export type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

/** The §1.3 opt-in auth method (DESIGN.md §8). */
export type AuthMethod = 'header' | 'basic';

/** A `session` row (DESIGN.md §8). */
export interface SessionRow {
  uuid: string;
  created_at: Date;
  last_post_at: Date | null;
  auth_enabled: boolean;
  auth_method: AuthMethod | null;
  auth_header_name: string | null;
  auth_secret_hash: string | null;
}

/** Optional auth fields when minting a session (defaults: auth disabled). */
export interface CreateSessionInput {
  authEnabled?: boolean;
  authMethod?: AuthMethod | null;
  authHeaderName?: string | null;
  authSecretHash?: string | null;
}

/**
 * Fields recorded for one `POST /i/{uuid}` (DESIGN.md §8). The id and
 * received_at default in the DB; everything else is filled by the pipeline.
 */
export interface InsertTransmissionInput {
  sessionUuid: string;
  contentHash?: Buffer | null;
  wireBytes?: number | null;
  contentType?: string | null;
  contentEncoding?: string | null;
  httpStatus?: number | null;
  transferId?: string | null;
  transferSrc?: string | null;
  transferType?: string | null;
  schemaVersion?: string | null;
  /** Parsed payload; null when unparseable (column is jsonb). */
  body?: unknown;
  /** Size-bounded original bytes kept for drill-down. */
  rawBody?: string | null;
  parseOk?: boolean | null;
  schemaOk?: boolean | null;
}

/** The §7 row-level honesty class carried by a finding. */
export type Severity = 'pass' | 'fail' | 'info';

/** Fields recorded for one `finding` row (DESIGN.md §8, db/initdb/30-finding.sql). */
export interface InsertFindingInput {
  /** Requirement id this finding speaks to, e.g. '1.4'. */
  requirement: string;
  severity: Severity;
  /** Human-readable explanation for the dashboard. */
  detail?: string | null;
  /** JSON Pointer into the payload, or null when not path-tied. */
  pointer?: string | null;
}

/** A `finding` row (DESIGN.md §8). */
export interface FindingRow {
  id: string;
  transmission_id: string;
  requirement: string;
  severity: Severity;
  detail: string | null;
  pointer: string | null;
}

/** A `transmission` row (DESIGN.md §8). */
export interface TransmissionRow {
  id: string;
  session_uuid: string;
  received_at: Date;
  content_hash: Buffer | null;
  wire_bytes: string | null; // bigint comes back as a string from pg
  content_type: string | null;
  content_encoding: string | null;
  http_status: number | null;
  transfer_id: string | null;
  transfer_src: string | null;
  transfer_type: string | null;
  schema_version: string | null;
  body: unknown;
  raw_body: string | null;
  parse_ok: boolean | null;
  schema_ok: boolean | null;
}

/**
 * Mint a new session row. The UUID and created_at default in the DB; auth is
 * disabled by default (zero-friction onboarding, DESIGN.md §3). Returns the
 * full inserted row.
 */
export async function createSession(
  input: CreateSessionInput = {},
  db: Queryable = getPool(),
): Promise<SessionRow> {
  const { rows } = await db.query<SessionRow>(
    `INSERT INTO session (auth_enabled, auth_method, auth_header_name, auth_secret_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING uuid, created_at, last_post_at, auth_enabled,
               auth_method, auth_header_name, auth_secret_hash`,
    [
      input.authEnabled ?? false,
      input.authMethod ?? null,
      input.authHeaderName ?? null,
      input.authSecretHash ?? null,
    ],
  );
  // INSERT ... RETURNING always yields exactly one row.
  return rows[0]!;
}

/** Fetch a session by UUID, or null if it does not exist. */
export async function getSession(
  uuid: string,
  db: Queryable = getPool(),
): Promise<SessionRow | null> {
  const { rows } = await db.query<SessionRow>(
    `SELECT uuid, created_at, last_post_at, auth_enabled,
            auth_method, auth_header_name, auth_secret_hash
     FROM session
     WHERE uuid = $1`,
    [uuid],
  );
  return rows[0] ?? null;
}

/**
 * Insert a transmission for a session and return the full inserted row.
 *
 * `content_hash` is intentionally NON-UNIQUE (DESIGN.md §8): every POST is
 * recorded so §1.8 duplicate detection has the data to grade. There is no
 * ON CONFLICT here — that would defeat the signal.
 */
export async function insertTransmission(
  input: InsertTransmissionInput,
  db: Queryable = getPool(),
): Promise<TransmissionRow> {
  const { rows } = await db.query<TransmissionRow>(
    `INSERT INTO transmission (
       session_uuid, content_hash, wire_bytes, content_type, content_encoding,
       http_status, transfer_id, transfer_src, transfer_type, schema_version,
       body, raw_body, parse_ok, schema_ok
     )
     VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10,
       $11, $12, $13, $14
     )
     RETURNING id, session_uuid, received_at, content_hash, wire_bytes,
               content_type, content_encoding, http_status, transfer_id,
               transfer_src, transfer_type, schema_version, body, raw_body,
               parse_ok, schema_ok`,
    [
      input.sessionUuid,
      input.contentHash ?? null,
      input.wireBytes ?? null,
      input.contentType ?? null,
      input.contentEncoding ?? null,
      input.httpStatus ?? null,
      input.transferId ?? null,
      input.transferSrc ?? null,
      input.transferType ?? null,
      input.schemaVersion ?? null,
      // jsonb param: pg serializes objects; pass the value through as-is.
      input.body === undefined ? null : JSON.stringify(input.body),
      input.rawBody ?? null,
      input.parseOk ?? null,
      input.schemaOk ?? null,
    ],
  );
  return rows[0]!;
}

/**
 * Stamp `session.last_post_at = now()` for a successful ingest (DESIGN.md §11:
 * the 30-day inactivity sweep keys off the most recent POST). Returns the new
 * timestamp, or null if the uuid does not exist.
 */
export async function bumpLastPostAt(
  uuid: string,
  db: Queryable = getPool(),
): Promise<Date | null> {
  const { rows } = await db.query<{ last_post_at: Date }>(
    `UPDATE session SET last_post_at = now() WHERE uuid = $1 RETURNING last_post_at`,
    [uuid],
  );
  return rows[0]?.last_post_at ?? null;
}

/** Insert one finding against a transmission and return the inserted row. */
export async function insertFinding(
  transmissionId: string,
  input: InsertFindingInput,
  db: Queryable = getPool(),
): Promise<FindingRow> {
  const { rows } = await db.query<FindingRow>(
    `INSERT INTO finding (transmission_id, requirement, severity, detail, pointer)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, transmission_id, requirement, severity, detail, pointer`,
    [
      transmissionId,
      input.requirement,
      input.severity,
      input.detail ?? null,
      input.pointer ?? null,
    ],
  );
  return rows[0]!;
}

/**
 * Insert many findings for one transmission in a single multi-row INSERT.
 * Returns the inserted rows (empty array when `findings` is empty — no SQL run).
 */
export async function insertFindings(
  transmissionId: string,
  findings: readonly InsertFindingInput[],
  db: Queryable = getPool(),
): Promise<FindingRow[]> {
  if (findings.length === 0) return [];

  const values: unknown[] = [];
  const tuples = findings.map((f, i) => {
    const base = i * 4;
    values.push(f.requirement, f.severity, f.detail ?? null, f.pointer ?? null);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
  });
  // transmission_id is bound once as the trailing param and reused per row.
  const txParam = `$${findings.length * 4 + 1}`;
  values.push(transmissionId);

  const { rows } = await db.query<FindingRow>(
    `INSERT INTO finding (requirement, severity, detail, pointer, transmission_id)
     SELECT v.requirement, v.severity, v.detail, v.pointer, ${txParam}
     FROM (VALUES ${tuples.join(', ')})
       AS v(requirement, severity, detail, pointer)
     RETURNING id, transmission_id, requirement, severity, detail, pointer`,
    values,
  );
  return rows;
}
