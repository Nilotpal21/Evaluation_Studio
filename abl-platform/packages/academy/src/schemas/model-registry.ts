/**
 * Learning Academy — Model Registry
 *
 * Idempotent model registration that handles HMR double-registration
 * and repeat imports in Next.js / bundled environments.
 */

import type { Connection, Model, Schema } from 'mongoose';

export function getOrCreateModel<T>(
  connection: Connection,
  name: string,
  schema: Schema<T>,
): Model<T> {
  if (connection.models[name]) {
    return connection.models[name] as Model<T>;
  }
  return connection.model<T>(name, schema);
}
