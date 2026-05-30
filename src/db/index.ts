/**
 * Database layer barrel: the pool lifecycle plus the typed repository.
 * Later milestones import from `./db/index.js`.
 */

export { getPool, closePool } from './pool.js';
export {
  createSession,
  getSession,
  insertTransmission,
  type AuthMethod,
  type SessionRow,
  type CreateSessionInput,
  type TransmissionRow,
  type InsertTransmissionInput,
} from './repository.js';
