/**
 * Centralized API Response Framework
 *
 * Generic response builders for all entities.
 * Every route should use these helpers to ensure consistent response envelopes.
 *
 * Error format follows agenticai convention:
 *   { success: false, errors: [{ msg: "...", code: "..." }] }
 *
 * Entity-specific response helpers live in their own files:
 *   - Tool: @/lib/tool-response.ts
 */

import { NextResponse } from 'next/server';

// ─── Standard Error Codes ──────────────────────────────────────────────────

export const ErrorCode = {
  // Auth & Access
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  SCOPE_VIOLATION: 'SCOPE_VIOLATION',

  // Validation
  VALIDATION_ERROR: 'VALIDATION_ERROR',

  // Resource
  NOT_FOUND: 'NOT_FOUND',
  NAME_CONFLICT: 'NAME_CONFLICT',

  // Rate Limiting
  RATE_LIMITED: 'RATE_LIMITED',

  // Module
  MODULE_HAS_CONSUMERS: 'MODULE_HAS_CONSUMERS',
  POINTER_CONFLICT: 'POINTER_CONFLICT',
  BUILD_ERROR: 'BUILD_ERROR',

  // Feature Gate
  FEATURE_DISABLED: 'FEATURE_DISABLED',

  // Server
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ─── Error Entry ──────────────────────────────────────────────────────────

export interface ApiErrorEntry {
  msg: string;
  code: ErrorCode | string;
}

// ─── Generic Response Builders ─────────────────────────────────────────────

/** Single resource: { success: true, [key]: data } */
export function successJson(key: string, data: unknown, status = 200): NextResponse {
  return NextResponse.json({ success: true, [key]: data }, { status });
}

/** List with pagination: { success: true, data: [...], pagination: {...} } */
export function listJson(data: unknown[], pagination: object, status = 200): NextResponse {
  return NextResponse.json({ success: true, data, pagination }, { status });
}

/** Action result: { success: true, ...extra } */
export function actionJson(extra: Record<string, unknown> = {}, status = 200): NextResponse {
  return NextResponse.json({ success: true, ...extra }, { status });
}

/**
 * Error response: { success: false, errors: [{ msg, code }] }
 *
 * Accepts a single message or an array of messages.
 * Each entry includes the error code for machine-readable parsing.
 */
export function errorJson(
  message: string | string[],
  status: number,
  code: ErrorCode | string = ErrorCode.INTERNAL_ERROR,
): NextResponse {
  const msgs = Array.isArray(message) ? message : [message];
  return NextResponse.json(
    {
      success: false,
      errors: msgs.map((msg) => ({ msg, code })),
    },
    { status },
  );
}

// ─── Error Classification ─────────────────────────────────────────────────

export function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const err = error as Record<string, unknown>;
  if (err.code === 11000) {
    return true;
  }

  return error instanceof Error && /E11000|duplicate key/i.test(error.message);
}

const DUPLICATE_KEY_SCOPE_FIELDS = new Set(['tenantId', 'projectId', 'userId', 'ownerId']);
const DUPLICATE_KEY_FIELD_DISPLAY_ALIASES: Record<string, string> = {
  slug: 'name',
};

function formatDuplicateKeyMessage(context: string, fields: string[]): string {
  if (context.startsWith('Projects.') && fields.includes('slug')) {
    return 'Project with the same name already exists';
  }

  const duplicateField = fields.find((field) => !DUPLICATE_KEY_SCOPE_FIELDS.has(field));
  const displayField = duplicateField
    ? (DUPLICATE_KEY_FIELD_DISPLAY_ALIASES[duplicateField] ?? duplicateField)
    : undefined;

  return displayField
    ? `A resource with this ${displayField} already exists`
    : 'A resource with this name already exists';
}

/**
 * Classify a caught error into a structured API response.
 *
 * Parses common error types to extract actionable messages:
 *  - MongoDB 11000 (duplicate key) → 409 NAME_CONFLICT
 *  - Mongoose ValidationError → 400 VALIDATION_ERROR (with field-level messages)
 *  - Mongoose CastError (invalid ObjectId etc.) → 400 VALIDATION_ERROR
 *  - Zod ZodError → 400 VALIDATION_ERROR (per-issue messages)
 *  - Errors with `.status` or `.statusCode` (e.g. from upstream services) → forwarded
 *  - Standard Error → 500 with message logged, generic message to client
 *  - Unknown → 500 generic
 *
 * Used by `withRouteHandler` and directly in manual catch blocks.
 */
export function handleApiError(error: unknown, context: string): NextResponse {
  // Not an object — truly unknown
  if (typeof error !== 'object' || error === null) {
    console.error(`[${context}] non-object error:`, error);
    return errorJson('Internal server error', 500, ErrorCode.INTERNAL_ERROR);
  }

  const err = error as Record<string, unknown>;

  // MongoDB duplicate key (code 11000)
  if (isDuplicateKeyError(error)) {
    const keyPattern = err.keyPattern as Record<string, unknown> | undefined;
    const fields = keyPattern ? Object.keys(keyPattern) : [];
    const message = formatDuplicateKeyMessage(context, fields);
    return errorJson(message, 409, ErrorCode.NAME_CONFLICT);
  }

  // Mongoose ValidationError — contains per-field errors
  if (error instanceof Error && error.name === 'ValidationError' && 'errors' in err) {
    const fieldErrors = err.errors as Record<string, { message: string }> | undefined;
    const messages = fieldErrors
      ? Object.values(fieldErrors).map((e) => e.message)
      : [error.message];
    return errorJson(messages, 400, ErrorCode.VALIDATION_ERROR);
  }

  // Mongoose CastError (e.g. invalid ObjectId)
  if (error instanceof Error && error.name === 'CastError') {
    const path = (err.path as string) || 'field';
    const value = err.value;
    return errorJson(
      `Invalid value for ${path}: ${String(value)}`,
      400,
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Zod ZodError (in case safeParse wasn't used)
  if (error instanceof Error && error.name === 'ZodError' && Array.isArray(err.issues)) {
    const issues = err.issues as Array<{ message: string; path: Array<string | number> }>;
    const messages = issues.map((i) => {
      const prefix = i.path.length ? `${i.path.join('.')}: ` : '';
      return `${prefix}${i.message}`;
    });
    return errorJson(messages, 400, ErrorCode.VALIDATION_ERROR);
  }

  // Errors with explicit status (from upstream services, custom app errors)
  if (error instanceof Error) {
    const status = (err.status as number) || (err.statusCode as number);
    if (typeof status === 'number' && status >= 400 && status < 600) {
      return errorJson(
        error.message,
        status,
        status < 500 ? ErrorCode.VALIDATION_ERROR : ErrorCode.INTERNAL_ERROR,
      );
    }
  }

  // Standard Error — log full error server-side, return generic message to client
  if (error instanceof Error) {
    console.error(`[${context}] ${error.name}: ${error.message}`, error.stack);
    return errorJson('Internal server error', 500, ErrorCode.INTERNAL_ERROR);
  }

  // Fallback for non-Error objects
  console.error(`[${context}] unknown error:`, error);
  return errorJson('Internal server error', 500, ErrorCode.INTERNAL_ERROR);
}
