import type { SDKUserContext, SDKUserContextPrimitive } from './types.js';

export const SDK_USER_CONTEXT_USER_ID_MAX_CHARS = 200;
export const SDK_USER_CONTEXT_MAX_BYTES = 4096;
export const SDK_USER_CONTEXT_MAX_ATTRIBUTES = 32;
export const SDK_USER_CONTEXT_KEY_MAX_CHARS = 128;
export const SDK_USER_CONTEXT_STRING_MAX_CHARS = 512;
export const SDK_USER_CONTEXT_ARRAY_MAX_ITEMS = 16;

function isPrimitiveValue(value: unknown): value is SDKUserContextPrimitive {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function validatePrimitiveValue(value: SDKUserContextPrimitive, path: string): void {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`Invalid ${path}: numbers must be finite.`);
  }

  if (typeof value === 'string' && value.length > SDK_USER_CONTEXT_STRING_MAX_CHARS) {
    throw new TypeError(
      `Invalid ${path}: strings must be ${String(SDK_USER_CONTEXT_STRING_MAX_CHARS)} characters or fewer.`,
    );
  }
}

function normalizeOptionalUserId(userId: string | undefined): string | undefined {
  const normalized = userId?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function serializeSdkUserContextForSizeCheck(userContext: SDKUserContext): string {
  const normalizedUserId = normalizeOptionalUserId(userContext.userId);
  const normalizedContext = {
    ...(normalizedUserId ? { userId: normalizedUserId } : {}),
    ...(userContext.customAttributes ? { customAttributes: userContext.customAttributes } : {}),
  };
  return JSON.stringify(normalizedContext);
}

export function validateSdkUserContext(userContext: SDKUserContext | undefined): void {
  if (!userContext) {
    return;
  }

  const normalizedUserId = normalizeOptionalUserId(userContext.userId);
  if (normalizedUserId && normalizedUserId.length > SDK_USER_CONTEXT_USER_ID_MAX_CHARS) {
    throw new TypeError(
      `Invalid userContext.userId: must be ${String(SDK_USER_CONTEXT_USER_ID_MAX_CHARS)} characters or fewer.`,
    );
  }

  const customAttributes = userContext.customAttributes;
  if (!customAttributes) {
    return;
  }

  const entries = Object.entries(customAttributes);
  if (entries.length > SDK_USER_CONTEXT_MAX_ATTRIBUTES) {
    throw new TypeError(
      `Invalid userContext.customAttributes: at most ${String(SDK_USER_CONTEXT_MAX_ATTRIBUTES)} entries are allowed.`,
    );
  }

  for (const [key, value] of entries) {
    if (key.length === 0) {
      throw new TypeError('Invalid userContext.customAttributes: keys must not be empty.');
    }

    if (key.length > SDK_USER_CONTEXT_KEY_MAX_CHARS) {
      throw new TypeError(
        `Invalid userContext.customAttributes.${key}: keys must be ${String(SDK_USER_CONTEXT_KEY_MAX_CHARS)} characters or fewer.`,
      );
    }

    if (Array.isArray(value)) {
      if (value.length > SDK_USER_CONTEXT_ARRAY_MAX_ITEMS) {
        throw new TypeError(
          `Invalid userContext.customAttributes.${key}: arrays must contain at most ${String(SDK_USER_CONTEXT_ARRAY_MAX_ITEMS)} items.`,
        );
      }

      for (const item of value) {
        if (!isPrimitiveValue(item)) {
          throw new TypeError(
            `Invalid userContext.customAttributes.${key}: arrays must contain only primitive values.`,
          );
        }
        validatePrimitiveValue(item, `userContext.customAttributes.${key}`);
      }
      continue;
    }

    if (!isPrimitiveValue(value)) {
      throw new TypeError(
        `Invalid userContext.customAttributes.${key}: expected a primitive value or primitive array.`,
      );
    }

    validatePrimitiveValue(value, `userContext.customAttributes.${key}`);
  }

  const serializedLength = new TextEncoder().encode(
    serializeSdkUserContextForSizeCheck(userContext),
  ).length;
  if (serializedLength > SDK_USER_CONTEXT_MAX_BYTES) {
    throw new TypeError(
      `Invalid userContext: serialized payload must be ${String(SDK_USER_CONTEXT_MAX_BYTES)} bytes or fewer.`,
    );
  }
}
