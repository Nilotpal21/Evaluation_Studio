/**
 * Generic Normalized<T> mapped type.
 *
 * Converts a Mongoose document interface to its normalized (repo-layer) form:
 * - Replaces `_id: string` with `id: string`
 * - Converts `createdAt: Date` and `updatedAt: Date` to ISO 8601 strings
 * - Passes all other fields through unchanged
 *
 * Usage:
 *   type NormalizedTool = Normalized<ITool>;
 *   // Fields defined once in ITool, auto-derived here.
 */
export type Normalized<T extends { _id: string; createdAt: Date; updatedAt: Date }> = Omit<
  T,
  '_id' | 'createdAt' | 'updatedAt'
> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};
