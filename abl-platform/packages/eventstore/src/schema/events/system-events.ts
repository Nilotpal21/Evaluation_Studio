/**
 * System event schemas.
 *
 * Events related to system-level errors and diagnostics.
 */

import { z } from 'zod';
import { eventRegistry } from '../event-registry.js';
import { EVENT_CATEGORIES } from '../event-categories.js';

// ─── system.error ─────────────────────────────────────────────────────────

export const SystemErrorDataSchema = z
  .object({
    errorType: z.string().optional(),
    errorMessage: z.string().optional(),
    stack: z.string().optional(),
    agentName: z.string().optional(),
  })
  .passthrough();

export type SystemErrorData = z.infer<typeof SystemErrorDataSchema>;

eventRegistry.register('system.error', SystemErrorDataSchema, {
  version: '1.0.0',
  category: EVENT_CATEGORIES.SYSTEM,
  containsPII: true,
  description: 'System error occurred',
});
