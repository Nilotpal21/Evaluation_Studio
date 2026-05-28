import { createHash } from 'node:crypto';
import type { Migration } from './types.js';

/**
 * Stable checksum for the current migration implementation.
 *
 * This lets us detect when a previously applied migration file has been edited
 * after the fact, which is especially important for auditability.
 */
export function getMigrationChecksum(migration: Migration): string {
  const parts = [
    migration.version,
    migration.description,
    migration.up.toString(),
    migration.down.toString(),
    migration.validate?.toString() ?? '',
  ];

  return createHash('sha256').update(parts.join('\n---\n')).digest('hex');
}
