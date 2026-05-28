const REASONING_MODEL_PREFIXES = ['gpt-5', 'o1', 'o3', 'o4'];

function normalizeModelName(modelId: string | null | undefined): string {
  return (modelId ?? '').trim().toLowerCase();
}

export function supportsTemperature(modelId: string | null | undefined): boolean {
  const normalized = normalizeModelName(modelId);
  if (!normalized) return true;

  const lastSegment = normalized.split('/').at(-1) ?? normalized;
  return !REASONING_MODEL_PREFIXES.some((prefix) => lastSegment.startsWith(prefix));
}

export function buildTemperatureOption(
  modelId: string | null | undefined,
  temperature: number,
): { temperature?: number } {
  return supportsTemperature(modelId) ? { temperature } : {};
}
