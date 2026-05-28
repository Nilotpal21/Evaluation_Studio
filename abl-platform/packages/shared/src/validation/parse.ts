/**
 * Generic Zod Validation Helper
 *
 * Provides a single `parseInput` function that wraps `schema.safeParse()` with
 * a clean discriminated union result. Used by all route handlers to validate
 * request bodies before touching service logic.
 *
 * Usage:
 *   const parsed = parseInput(MySchema, body);
 *   if (!parsed.success) return errorJson(parsed.error, 400, 'VALIDATION_ERROR');
 *   const data = parsed.data; // fully typed, defaults applied
 */

import { z } from 'zod';

export interface ParseSuccess<T> {
  success: true;
  data: T;
}

export interface ParseFailure {
  success: false;
  /** First issue message — suitable for API error response */
  error: string;
  /** All issues — for debugging/logging */
  issues: z.ZodIssue[];
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

/** Parse unknown input against a Zod schema. Returns typed result, never throws. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): ParseResult<T> {
  const result = schema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    error: result.error.issues[0]?.message || 'Invalid request',
    issues: result.error.issues,
  };
}
