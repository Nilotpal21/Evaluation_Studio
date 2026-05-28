import { AppError } from '@agent-platform/shared-kernel';
import { z } from 'zod';

/** Maximum serialized size for per-request sessionMetadata (64KB). */
const MAX_REQUEST_METADATA_BYTES = 65_536;

/** Maximum serialized size for post-merge _metadata (256KB). */
const MAX_POST_MERGE_METADATA_BYTES = 262_144;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DURABLE_SESSION_METADATA_SCALAR_KEYS = ['language', 'locale', 'timezone'] as const;
const DURABLE_SESSION_METADATA_NESTED_KEYS = ['clientInfo', 'interactionContext'] as const;

type DurableSessionMetadataScalarKey = (typeof DURABLE_SESSION_METADATA_SCALAR_KEYS)[number];
type DurableSessionMetadataNestedKey = (typeof DURABLE_SESSION_METADATA_NESTED_KEYS)[number];

function cloneRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return value ? { ...value } : undefined;
}

function pickDurableScalarFields(
  value: Record<string, unknown>,
): Partial<Record<DurableSessionMetadataScalarKey, string>> | undefined {
  const durable: Partial<Record<DurableSessionMetadataScalarKey, string>> = {};

  for (const key of DURABLE_SESSION_METADATA_SCALAR_KEYS) {
    const rawValue = value[key];
    if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
      durable[key] = rawValue;
    }
  }

  return Object.keys(durable).length > 0 ? durable : undefined;
}

function mergeSessionMetadataObjects(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!incoming || Object.keys(incoming).length === 0) {
    return cloneRecord(existing);
  }

  if (!existing || Object.keys(existing).length === 0) {
    return cloneRecord(incoming);
  }

  const merged: Record<string, unknown> = { ...existing, ...incoming };

  for (const key of DURABLE_SESSION_METADATA_NESTED_KEYS) {
    const existingNested = existing[key];
    const incomingNested = incoming[key];

    if (isRecord(existingNested) && isRecord(incomingNested)) {
      merged[key] = { ...existingNested, ...incomingNested };
    } else if (isRecord(existingNested) && incomingNested === undefined) {
      merged[key] = { ...existingNested };
    } else if (existingNested === undefined && isRecord(incomingNested)) {
      merged[key] = { ...incomingNested };
    }
  }

  return merged;
}

/**
 * Shallow-merge incoming sessionMetadata into existing _metadata.
 * Returns undefined if both inputs are undefined/empty.
 */
export function mergeSessionMetadata(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!incoming || Object.keys(incoming).length === 0) return existing;
  if (!existing || Object.keys(existing).length === 0) return { ...incoming };
  return { ...existing, ...incoming };
}

/**
 * Create a validation error with statusCode for structured error responses.
 */
function createValidationError(message: string): AppError {
  return new AppError(message, {
    code: 'PAYLOAD_TOO_LARGE',
    statusCode: 413,
  });
}

export function isSessionMetadataValidationError(error: unknown): error is AppError {
  return (
    error instanceof AppError && error.code === 'PAYLOAD_TOO_LARGE' && error.statusCode === 413
  );
}

/**
 * Validate per-request sessionMetadata size (max 64KB serialized).
 * Throws on violation with statusCode 413.
 */
export function validateSessionMetadataSize(metadata: Record<string, unknown>): void {
  const size = JSON.stringify(metadata).length;
  if (size > MAX_REQUEST_METADATA_BYTES) {
    throw createValidationError(
      `sessionMetadata exceeds maximum size of ${MAX_REQUEST_METADATA_BYTES} bytes (got ${size})`,
    );
  }
}

/**
 * Parse sessionMetadata from an object or JSON string.
 * Returns undefined when the input is absent or not an object.
 */
export function coerceSessionMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return undefined;
    }

    return coerceSessionMetadata(parsed);
  }

  if (!isRecord(value)) {
    return undefined;
  }

  validateSessionMetadataSize(value);
  return { ...value };
}

/**
 * Validate post-merge _metadata size (max 256KB serialized).
 * Throws on violation with statusCode 413.
 */
export function validatePostMergeSize(merged: Record<string, unknown>): void {
  const size = JSON.stringify(merged).length;
  if (size > MAX_POST_MERGE_METADATA_BYTES) {
    throw createValidationError(
      `Post-merge _metadata exceeds maximum size of ${MAX_POST_MERGE_METADATA_BYTES} bytes (got ${size})`,
    );
  }
}

/**
 * Merge session metadata and validate the post-merge size ceiling.
 * Returns undefined when both inputs are empty.
 */
export function mergeAndValidateSessionMetadata(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const merged = mergeSessionMetadata(existing, incoming);
  if (!merged) {
    return undefined;
  }

  validatePostMergeSize(merged);
  return merged;
}

/**
 * Zod schema for sessionMetadata field in API requests.
 * Validates as a record of unknown values, with a 64KB size limit.
 */
export const sessionMetadataSchema = z
  .record(z.unknown())
  .refine((val) => JSON.stringify(val).length <= MAX_REQUEST_METADATA_BYTES, {
    message: `sessionMetadata exceeds maximum size of ${MAX_REQUEST_METADATA_BYTES} bytes`,
  })
  .optional();

/**
 * Return the safe subset of sessionMetadata that may be persisted durably.
 *
 * This subset intentionally excludes arbitrary integration secrets/tokens.
 * Fresh ingress metadata can still be admitted to the live runtime session,
 * but only this allowlisted subset survives channel-session persistence.
 */
export function extractDurableSessionMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata || Object.keys(metadata).length === 0) {
    return undefined;
  }

  const durable: Record<string, unknown> = {};
  const directScalars = pickDurableScalarFields(metadata);
  if (directScalars) {
    Object.assign(durable, directScalars);
  }

  for (const key of DURABLE_SESSION_METADATA_NESTED_KEYS) {
    const rawValue = metadata[key];
    if (!isRecord(rawValue)) {
      continue;
    }

    const durableNested = pickDurableScalarFields(rawValue);
    if (durableNested) {
      durable[key] = durableNested;
    }
  }

  return Object.keys(durable).length > 0 ? durable : undefined;
}

/**
 * Merge two durable session-metadata subsets, preserving nested continuity
 * fields like clientInfo/interactionContext field-by-field.
 */
export function mergeDurableSessionMetadata(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const merged = mergeSessionMetadataObjects(
    extractDurableSessionMetadata(existing),
    extractDurableSessionMetadata(incoming),
  );

  if (!merged) {
    return undefined;
  }

  validatePostMergeSize(merged);
  return merged;
}

/**
 * Rebuild live runtime session metadata from a durable safe base plus fresh
 * ingress metadata. Fresh ingress wins, but nested continuity fields preserve
 * any missing durable values.
 */
export function mergeReloadedSessionMetadata(
  durableBase: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (incoming && Object.keys(incoming).length > 0) {
    validateSessionMetadataSize(incoming);
  }

  const merged = mergeSessionMetadataObjects(extractDurableSessionMetadata(durableBase), incoming);
  if (!merged) {
    return undefined;
  }

  validatePostMergeSize(merged);
  return merged;
}

/**
 * Persist channel-session metadata using a hybrid model:
 * - all non-sessionMetadata channel metadata is preserved
 * - only the durable allowlisted sessionMetadata subset is stored
 */
export function buildChannelSessionMetadataForPersistence(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata) {
    return {};
  }

  const { sessionMetadata: rawSessionMetadata, ...channelMetadata } = metadata;
  const durableSessionMetadata = extractDurableSessionMetadata(
    coerceSessionMetadata(rawSessionMetadata),
  );

  return durableSessionMetadata
    ? { ...channelMetadata, sessionMetadata: durableSessionMetadata }
    : channelMetadata;
}

/**
 * Read the durable allowlisted sessionMetadata subset back from a channel-session row.
 */
export function readDurableSessionMetadataFromChannelSessionMetadata(
  metadata: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }

  return extractDurableSessionMetadata(coerceSessionMetadata(metadata.sessionMetadata));
}

function readExistingSessionMetadata(sessionData: {
  values: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const current = sessionData.values._metadata;
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    return undefined;
  }
  return current as Record<string, unknown>;
}

/**
 * Initialize _metadata on a new session's data store.
 * No-op if metadata is undefined or empty object.
 */
export function initializeSessionMetadata(
  sessionData: { values: Record<string, unknown> },
  metadata: Record<string, unknown> | undefined,
): void {
  if (metadata && Object.keys(metadata).length > 0) {
    validateSessionMetadataSize(metadata);
    sessionData.values._metadata = { ...metadata };
  }
}

/**
 * Merge follow-up session metadata into the existing _metadata namespace.
 * Validates both the incoming request size and the merged payload size.
 */
export function updateSessionMetadata(
  sessionData: { values: Record<string, unknown> },
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (!metadata || Object.keys(metadata).length === 0) {
    return false;
  }

  validateSessionMetadataSize(metadata);

  const merged = mergeAndValidateSessionMetadata(
    readExistingSessionMetadata(sessionData),
    metadata,
  );
  if (!merged) {
    return false;
  }
  sessionData.values._metadata = merged;
  return true;
}
