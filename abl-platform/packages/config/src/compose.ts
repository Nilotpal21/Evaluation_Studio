/**
 * Schema Composition
 *
 * Allows apps to extend the base config schema with app-specific sections.
 */

import { z, type ZodRawShape } from 'zod';
import { BaseAppConfigSchema } from './schemas/base-app.schema.js';

/**
 * Compose a config schema by extending BaseAppConfigSchema with additional fields.
 *
 * Usage:
 *   const RuntimeConfigSchema = composeConfigSchema({
 *     voice: VoiceConfigSchema.default({}),
 *     websocket: WebSocketConfigSchema.default({}),
 *   });
 */
export function composeConfigSchema<T extends ZodRawShape>(
  extensions: T,
): ReturnType<typeof BaseAppConfigSchema.extend<T>> {
  return BaseAppConfigSchema.extend(extensions);
}
