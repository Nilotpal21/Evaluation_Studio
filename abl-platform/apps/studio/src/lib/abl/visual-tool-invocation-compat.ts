const SUPPORTED_VISUAL_INVOCATION_KEYS = new Set(['tool', 'with', 'as']);

function isVisualInvocationScalar(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

export function collectUnsupportedVisualToolInvocationPaths(
  callSpec: unknown,
  pathPrefix = 'call_spec',
): string[] {
  if (!callSpec || typeof callSpec !== 'object' || Array.isArray(callSpec)) {
    return [pathPrefix];
  }

  const issues: string[] = [];
  const record = callSpec as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (SUPPORTED_VISUAL_INVOCATION_KEYS.has(key)) {
      continue;
    }
    issues.push(`${pathPrefix}.${key}`);
  }

  if (typeof record.tool !== 'string' || record.tool.trim().length === 0) {
    issues.push(`${pathPrefix}.tool`);
  }

  if (record.as !== undefined && (typeof record.as !== 'string' || record.as.trim().length === 0)) {
    issues.push(`${pathPrefix}.as`);
  }

  if (record.with !== undefined) {
    if (!record.with || typeof record.with !== 'object' || Array.isArray(record.with)) {
      issues.push(`${pathPrefix}.with`);
    } else {
      for (const [key, value] of Object.entries(record.with as Record<string, unknown>)) {
        if (value === undefined) {
          continue;
        }
        if (!isVisualInvocationScalar(value)) {
          issues.push(`${pathPrefix}.with.${key}`);
        }
      }
    }
  }

  return issues;
}
