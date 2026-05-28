const SENSITIVE_KEYS =
  /^(api[_-]?key|secret|password|token|authorization|credential|private[_-]?key|access[_-]?key)$/i;

export function sanitizeResponse(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(sanitizeResponse);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.test(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeResponse(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
