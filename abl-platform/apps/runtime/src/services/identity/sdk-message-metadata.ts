import { Buffer } from 'node:buffer';
import {
  SDK_USER_CONTEXT_ARRAY_MAX_ITEMS,
  SDK_USER_CONTEXT_KEY_MAX_CHARS,
  SDK_USER_CONTEXT_MAX_ATTRIBUTES,
  SDK_USER_CONTEXT_MAX_BYTES,
  SDK_USER_CONTEXT_MAX_DEPTH,
  SDK_USER_CONTEXT_STRING_MAX_CHARS,
} from '@agent-platform/config';

export const SDK_MESSAGE_METADATA_LIMITS = {
  maxKeysPerObject: SDK_USER_CONTEXT_MAX_ATTRIBUTES,
  maxKeyLength: SDK_USER_CONTEXT_KEY_MAX_CHARS,
  maxArrayLength: SDK_USER_CONTEXT_ARRAY_MAX_ITEMS,
  maxStringLength: SDK_USER_CONTEXT_STRING_MAX_CHARS,
  maxObjectDepth: SDK_USER_CONTEXT_MAX_DEPTH,
  maxSerializedBytes: SDK_USER_CONTEXT_MAX_BYTES,
} as const;

export type SdkMessageMetadataScalar = string | number | boolean | null;
export type SdkMessageMetadataValue =
  | SdkMessageMetadataScalar
  | SdkMessageMetadataValue[]
  | { [key: string]: SdkMessageMetadataValue };
export type SdkMessageMetadata = Record<string, SdkMessageMetadataValue>;

export interface SdkMessageMetadataValidationError {
  code: 'INVALID_MESSAGE_METADATA';
  message: string;
  issues: string[];
}

export type NormalizedSdkMessageMetadataResult =
  | { success: true; data?: SdkMessageMetadata }
  | { success: false; error: SdkMessageMetadataValidationError };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function normalizeScalarValue(
  value: SdkMessageMetadataScalar,
  path: string,
  issues: string[],
): SdkMessageMetadataScalar | undefined {
  if (value === null || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      issues.push(`${path} must be a finite number`);
      return undefined;
    }
    return value;
  }

  if (value.length > SDK_MESSAGE_METADATA_LIMITS.maxStringLength) {
    issues.push(
      `${path} exceeds max string length (${SDK_MESSAGE_METADATA_LIMITS.maxStringLength})`,
    );
    return undefined;
  }

  return value;
}

function normalizeMetadataObject(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  issues: string[],
): SdkMessageMetadata | undefined {
  if (depth > SDK_MESSAGE_METADATA_LIMITS.maxObjectDepth) {
    issues.push(`${path} exceeds max depth (${SDK_MESSAGE_METADATA_LIMITS.maxObjectDepth})`);
    return undefined;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return {};
  }

  if (entries.length > SDK_MESSAGE_METADATA_LIMITS.maxKeysPerObject) {
    issues.push(`${path} exceeds max keys (${SDK_MESSAGE_METADATA_LIMITS.maxKeysPerObject})`);
    return undefined;
  }

  const normalized: SdkMessageMetadata = {};
  for (const [key, rawValue] of entries) {
    if (key.length === 0) {
      issues.push(`${path} contains an empty key`);
      return undefined;
    }

    if (key.length > SDK_MESSAGE_METADATA_LIMITS.maxKeyLength) {
      issues.push(
        `${path}.${key} exceeds max key length (${SDK_MESSAGE_METADATA_LIMITS.maxKeyLength})`,
      );
      return undefined;
    }

    const normalizedValue = normalizeMetadataValue(rawValue, `${path}.${key}`, depth, issues);
    if (normalizedValue === undefined) {
      return undefined;
    }

    normalized[key] = normalizedValue;
  }

  return normalized;
}

function normalizeMetadataValue(
  value: unknown,
  path: string,
  depth: number,
  issues: string[],
): SdkMessageMetadataValue | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return normalizeScalarValue(value, path, issues);
  }

  if (Array.isArray(value)) {
    if (value.length > SDK_MESSAGE_METADATA_LIMITS.maxArrayLength) {
      issues.push(
        `${path} exceeds max array length (${SDK_MESSAGE_METADATA_LIMITS.maxArrayLength})`,
      );
      return undefined;
    }

    const normalizedItems: SdkMessageMetadataValue[] = [];
    for (const [index, item] of value.entries()) {
      const normalizedItem = normalizeMetadataValue(item, `${path}[${index}]`, depth, issues);
      if (normalizedItem === undefined) {
        return undefined;
      }
      normalizedItems.push(normalizedItem);
    }
    return normalizedItems;
  }

  if (isPlainObject(value)) {
    return normalizeMetadataObject(value, path, depth + 1, issues);
  }

  issues.push(`${path} must be a JSON-compatible value`);
  return undefined;
}

export function cloneSdkMessageMetadata(
  metadata: SdkMessageMetadata | undefined,
): SdkMessageMetadata | undefined {
  return metadata ? structuredClone(metadata) : undefined;
}

export function normalizeSdkMessageMetadata(metadata: unknown): NormalizedSdkMessageMetadataResult {
  if (metadata === undefined) {
    return { success: true };
  }

  const issues: string[] = [];
  const normalized = isPlainObject(metadata)
    ? normalizeMetadataObject(metadata, 'metadata', 1, issues)
    : (() => {
        issues.push('metadata must be an object');
        return undefined;
      })();

  if (issues.length > 0) {
    return {
      success: false,
      error: {
        code: 'INVALID_MESSAGE_METADATA',
        message: 'Invalid SDK message metadata',
        issues,
      },
    };
  }

  const serialized = normalized ? JSON.stringify(normalized) : undefined;
  if (
    serialized &&
    Buffer.byteLength(serialized, 'utf8') > SDK_MESSAGE_METADATA_LIMITS.maxSerializedBytes
  ) {
    return {
      success: false,
      error: {
        code: 'INVALID_MESSAGE_METADATA',
        message: 'Invalid SDK message metadata',
        issues: [
          `metadata exceeds max serialized size (${SDK_MESSAGE_METADATA_LIMITS.maxSerializedBytes} bytes)`,
        ],
      },
    };
  }

  return {
    success: true,
    data: normalized && Object.keys(normalized).length > 0 ? normalized : undefined,
  };
}
