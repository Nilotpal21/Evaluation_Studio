const REDACT_FIELD_NAMES = [
  'apiKey',
  'token',
  'password',
  'secret',
  'authorization',
  'credentials',
  'accessToken',
  'refreshToken',
  'x-api-key',
  'x-auth-token',
];

export const REDACT_FIELDS = new Set(REDACT_FIELD_NAMES.map((field) => field.toLowerCase()));

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }

  if (value && typeof value === 'object') {
    return redact(value as Record<string, unknown>);
  }

  return value;
}

export function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (REDACT_FIELDS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactValue(value);
    }
  }
  return result;
}
