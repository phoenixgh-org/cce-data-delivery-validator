/**
 * CCE data delivery validator — listen/bootstrap entrypoint.
 *
 * The configurable, port-free app lives in `app.ts` (`buildApp`). This module
 * binds it to a port. Postgres wiring lands in a later slice (dpp.4).
 */

import { buildApp } from './app.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

export async function main(): Promise<void> {
  const app = buildApp();
  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Run only when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
