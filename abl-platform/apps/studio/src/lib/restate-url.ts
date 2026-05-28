/**
 * Centralized Restate ingress URL resolution.
 *
 * Reads `RESTATE_INGRESS_URL` at call time (not import time) so env
 * changes are picked up without a restart. Falls back to localhost
 * for local development only.
 */
const DEFAULT_RESTATE_URL = 'http://localhost:8091';

export function getRestateIngressUrl(): string {
  return process.env.RESTATE_INGRESS_URL || DEFAULT_RESTATE_URL;
}
