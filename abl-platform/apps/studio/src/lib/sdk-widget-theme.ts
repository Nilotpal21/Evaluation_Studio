const DEFAULT_THEME_FALLBACK: Record<string, string> = {};

export function normalizeSdkWidgetTheme(
  theme: unknown,
  fallback: Record<string, string> = DEFAULT_THEME_FALLBACK,
): Record<string, string> {
  if (typeof theme === 'string') {
    const trimmedTheme = theme.trim();
    if (trimmedTheme.length === 0) {
      return { ...fallback };
    }

    try {
      return normalizeSdkWidgetTheme(JSON.parse(trimmedTheme), fallback);
    } catch {
      return { ...fallback };
    }
  }

  if (typeof theme !== 'object' || theme === null || Array.isArray(theme)) {
    return { ...fallback };
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme)) {
    if (typeof value === 'string') {
      normalized[key] = value;
    }
  }

  if (Object.keys(normalized).length === 0) {
    return { ...fallback };
  }

  return normalized;
}
