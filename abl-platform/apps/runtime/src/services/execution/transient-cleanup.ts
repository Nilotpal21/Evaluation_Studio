/**
 * Transient PII Cleanup
 *
 * Removes fields marked transient: true from session data after gather
 * completes. Handles ephemeral PII like CVV, OTP, and one-time tokens.
 */

import { createLogger } from '@abl/compiler/platform';
import type { GatherField } from '@abl/compiler';

const log = createLogger('transient-cleanup');

/**
 * Remove transient fields from the data record.
 * Returns the list of field names that were removed.
 */
export function cleanupTransientFields(
  data: Record<string, unknown>,
  fields: GatherField[],
): string[] {
  const removed: string[] = [];

  for (const field of fields) {
    if (field.transient && field.name in data) {
      delete data[field.name];
      removed.push(field.name);
    }
  }

  if (removed.length > 0) {
    log.info('transient-fields-cleaned', { fields: removed });
  }

  return removed;
}
