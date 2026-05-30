/**
 * Database layer barrel: the pool lifecycle plus the typed repository.
 * Later milestones import from `./db/index.js`.
 */

export { getPool, closePool } from './pool.js';
export {
  createSession,
  getSession,
  insertTransmission,
  listTransmissions,
  listFindingsForSession,
  type AuthMethod,
  type SessionRow,
  type CreateSessionInput,
  type TransmissionRow,
  type InsertTransmissionInput,
  type FindingRow,
  type Severity,
} from './repository.js';
