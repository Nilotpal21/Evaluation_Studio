import { createHash, randomUUID } from 'node:crypto';
import {
  SDK_USER_CONTEXT_ARRAY_MAX_ITEMS,
  SDK_USER_CONTEXT_KEY_MAX_CHARS,
  SDK_USER_CONTEXT_MAX_ATTRIBUTES,
  SDK_USER_CONTEXT_MAX_BYTES,
  SDK_USER_CONTEXT_MAX_DEPTH,
  SDK_USER_CONTEXT_STRING_MAX_CHARS,
  SDK_USER_CONTEXT_USER_ID_MAX_CHARS,
} from '@agent-platform/config';
import type {
  SDKAuthScope,
  SDKSessionTokenPayload,
  IdentityTier,
  VerificationMethod,
} from '@agent-platform/shared-auth';

const LEGACY_SESSION_PRINCIPAL_LENGTH = 32;

export const SDK_USER_CONTEXT_LIMITS = {
  maxUserIdLength: SDK_USER_CONTEXT_USER_ID_MAX_CHARS,
  maxCustomAttributes: SDK_USER_CONTEXT_MAX_ATTRIBUTES,
  maxCustomAttributeKeyLength: SDK_USER_CONTEXT_KEY_MAX_CHARS,
  maxArrayLength: SDK_USER_CONTEXT_ARRAY_MAX_ITEMS,
  maxStringLength: SDK_USER_CONTEXT_STRING_MAX_CHARS,
  maxDepth: SDK_USER_CONTEXT_MAX_DEPTH,
  maxSerializedBytes: SDK_USER_CONTEXT_MAX_BYTES,
} as const;

type SDKUserContext = NonNullable<SDKSessionTokenPayload['userContext']>;

type SDKUserContextScalar = string | number | boolean | null;
type SDKUserContextValue = SDKUserContextScalar | SDKUserContextScalar[];

export interface SdkUserContextValidationError {
  code: 'INVALID_USER_CONTEXT';
  message: string;
  issues: string[];
}

export type NormalizedSdkUserContextResult =
  | { success: true; data?: SDKUserContext }
  | { success: false; error: SdkUserContextValidationError };

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function normalizeScalarValue(
  value: string | number | boolean | null,
  path: string,
  issues: string[],
): SDKUserContextScalar | undefined {
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

  if (value.length > SDK_USER_CONTEXT_LIMITS.maxStringLength) {
    issues.push(`${path} exceeds max string length (${SDK_USER_CONTEXT_LIMITS.maxStringLength})`);
    return undefined;
  }

  return value;
}

function normalizeCustomAttributeValue(
  value: unknown,
  path: string,
  issues: string[],
): SDKUserContextValue | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return normalizeScalarValue(value, path, issues);
  }

  if (Array.isArray(value)) {
    if (value.length > SDK_USER_CONTEXT_LIMITS.maxArrayLength) {
      issues.push(`${path} exceeds max array length (${SDK_USER_CONTEXT_LIMITS.maxArrayLength})`);
      return undefined;
    }

    const normalizedItems: SDKUserContextScalar[] = [];
    for (const [index, item] of value.entries()) {
      if (Array.isArray(item) || (item !== null && typeof item === 'object')) {
        issues.push(`${path}[${index}] must be a primitive value`);
        return undefined;
      }

      const normalizedItem = normalizeScalarValue(
        item as SDKUserContextScalar,
        `${path}[${index}]`,
        issues,
      );
      if (normalizedItem === undefined) {
        return undefined;
      }
      normalizedItems.push(normalizedItem);
    }
    return normalizedItems;
  }

  issues.push(`${path} must be a primitive value or an array of primitive values`);
  return undefined;
}

function normalizeCustomAttributes(
  rawAttributes: Record<string, unknown> | undefined,
  issues: string[],
): Record<string, SDKUserContextValue> | undefined {
  if (!rawAttributes) {
    return undefined;
  }

  const entries = Object.entries(rawAttributes);
  if (entries.length === 0) {
    return undefined;
  }

  if (entries.length > SDK_USER_CONTEXT_LIMITS.maxCustomAttributes) {
    issues.push(
      `customAttributes exceeds max keys (${SDK_USER_CONTEXT_LIMITS.maxCustomAttributes})`,
    );
    return undefined;
  }

  const normalized: Record<string, SDKUserContextValue> = {};
  for (const [key, value] of entries) {
    if (key.length === 0) {
      issues.push('customAttributes contains an empty key');
      return undefined;
    }

    if (key.length > SDK_USER_CONTEXT_LIMITS.maxCustomAttributeKeyLength) {
      issues.push(
        `customAttributes.${key} exceeds max key length (${SDK_USER_CONTEXT_LIMITS.maxCustomAttributeKeyLength})`,
      );
      return undefined;
    }

    const normalizedValue = normalizeCustomAttributeValue(value, `customAttributes.${key}`, issues);
    if (normalizedValue === undefined) {
      return undefined;
    }

    normalized[key] = normalizedValue;
  }

  return normalized;
}

function serializeSdkUserContext(userContext: SDKUserContext | undefined): string | undefined {
  if (!userContext) {
    return undefined;
  }

  return JSON.stringify(userContext);
}

function deriveSdkAuthScope(params: {
  verifiedUserId?: string;
  authScope?: SDKAuthScope;
}): SDKAuthScope {
  if (params.authScope === 'session' || params.authScope === 'user') {
    return params.authScope;
  }

  return params.verifiedUserId ? 'user' : 'session';
}

export function normalizeSdkUserContext(
  userContext: SDKSessionTokenPayload['userContext'] | undefined,
): NormalizedSdkUserContextResult {
  if (!userContext) {
    return { success: true };
  }

  const issues: string[] = [];
  const normalizedUserId = normalizeOptionalString(userContext.userId);
  if (normalizedUserId && normalizedUserId.length > SDK_USER_CONTEXT_LIMITS.maxUserIdLength) {
    issues.push(
      `userContext.userId exceeds max length (${SDK_USER_CONTEXT_LIMITS.maxUserIdLength})`,
    );
  }

  const normalizedCustomAttributes =
    userContext.customAttributes && isPlainObject(userContext.customAttributes)
      ? normalizeCustomAttributes(userContext.customAttributes, issues)
      : userContext.customAttributes === undefined
        ? undefined
        : (() => {
            issues.push('userContext.customAttributes must be an object');
            return undefined;
          })();

  if (issues.length > 0) {
    return {
      success: false,
      error: {
        code: 'INVALID_USER_CONTEXT',
        message: 'Invalid SDK userContext',
        issues,
      },
    };
  }

  const normalizedContext: SDKUserContext | undefined =
    normalizedUserId || normalizedCustomAttributes
      ? {
          ...(normalizedUserId ? { userId: normalizedUserId } : {}),
          ...(normalizedCustomAttributes ? { customAttributes: normalizedCustomAttributes } : {}),
        }
      : undefined;

  const serialized = serializeSdkUserContext(normalizedContext);
  if (
    serialized &&
    Buffer.byteLength(serialized, 'utf8') > SDK_USER_CONTEXT_LIMITS.maxSerializedBytes
  ) {
    return {
      success: false,
      error: {
        code: 'INVALID_USER_CONTEXT',
        message: 'Invalid SDK userContext',
        issues: [
          `userContext exceeds max serialized size (${SDK_USER_CONTEXT_LIMITS.maxSerializedBytes} bytes)`,
        ],
      },
    };
  }

  return { success: true, data: normalizedContext };
}

export function issueSdkSessionPrincipalId(): string {
  return `sdk_${randomUUID()}`;
}

export function deriveLegacySdkSessionPrincipalId(token: string): string {
  const digest = createHash('sha256').update(token).digest('hex');
  return `sdk_${digest.slice(0, LEGACY_SESSION_PRINCIPAL_LENGTH)}`;
}

export function deriveLegacyAnonymousSdkUserId(token: string): string {
  return deriveLegacySdkSessionPrincipalId(token);
}

export function normalizeLegacySdkSessionPayload(
  payload: SDKSessionTokenPayload,
  token: string,
): SDKSessionTokenPayload {
  const normalizedUserContextResult = normalizeSdkUserContext(payload.userContext);
  const normalizedUserContext = normalizedUserContextResult.success
    ? normalizedUserContextResult.data
    : undefined;
  const verifiedUserId = normalizeOptionalString(payload.verifiedUserId);
  const authScope = deriveSdkAuthScope({
    verifiedUserId,
    authScope: payload.authScope,
  });
  const normalizedSessionId = normalizeOptionalString(payload.sessionId);
  const normalizedSessionPrincipal =
    normalizeOptionalString(payload.sessionPrincipal) ??
    normalizedSessionId ??
    deriveLegacySdkSessionPrincipalId(token);
  const canonicalSessionId = normalizedSessionId ?? normalizedSessionPrincipal;

  const normalizedIdentityTier: IdentityTier = verifiedUserId
    ? 2
    : ((payload.identityTier ?? 0) as IdentityTier);
  const normalizedVerificationMethod: VerificationMethod = payload.verificationMethod ?? 'none';

  return {
    ...payload,
    sessionId: canonicalSessionId,
    sessionPrincipal: normalizedSessionPrincipal,
    verifiedUserId,
    authScope,
    userContext: normalizedUserContext,
    identityTier: normalizedIdentityTier,
    verificationMethod: normalizedVerificationMethod,
  };
}
