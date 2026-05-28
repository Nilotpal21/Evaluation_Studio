/**
 * Document Normalization Utilities
 *
 * Converts MongoDB documents to API-friendly format:
 * - Adds `id` from `_id`
 * - Converts Date timestamps to ISO 8601 strings (when present)
 */

/**
 * Convert MongoDB document to API-friendly format.
 *
 * Adds `id` from `_id`. Converts `createdAt`/`updatedAt` Date objects
 * to ISO strings when present. Tolerates documents without timestamps
 * (e.g. aggregation results or lean queries on schemas without timestamps).
 *
 * @param doc - MongoDB document with at least `_id`
 * @returns Normalized document with `id` field added, or null
 */
export function normalizeDocument<T extends { _id: string }>(
  doc: T | null,
): (T & { id: string }) | null {
  if (!doc) return null;

  const out: any = { ...doc, id: doc._id };

  if (out.createdAt instanceof Date) out.createdAt = out.createdAt.toISOString();
  if (out.updatedAt instanceof Date) out.updatedAt = out.updatedAt.toISOString();

  return out;
}
