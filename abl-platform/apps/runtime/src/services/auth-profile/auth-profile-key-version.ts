function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

export function getCurrentAuthProfileKeyVersion(): number {
  const explicitCurrent = parsePositiveInteger(process.env.ENCRYPTION_CURRENT_MASTER_KEY_VERSION);
  if (explicitCurrent) {
    return explicitCurrent;
  }

  const rawPreviousKeys = process.env.ENCRYPTION_PREVIOUS_MASTER_KEYS;
  if (!rawPreviousKeys) {
    return 1;
  }

  const previousVersions = rawPreviousKeys
    .split(',')
    .map((entry) => parsePositiveInteger(entry.trim().split(':').pop()))
    .filter((value): value is number => value !== null);

  if (previousVersions.length === 0) {
    return 1;
  }

  return Math.max(...previousVersions) + 1;
}
