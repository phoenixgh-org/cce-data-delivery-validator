/**
 * CCE data delivery validator — entry point placeholder.
 *
 * The Fastify app factory, schema registry, and Postgres wiring land in
 * later slices (dpp.2 / dpp.4 / dpp.5). This file exists so the build
 * compiles and the tooling foundation has a stable entry point.
 */

export function version(): string {
  return '0.0.0';
}

export function main(): void {
  // Intentionally empty for the M1 tooling skeleton.
}
