export const OPENAI_REALTIME_TEMPERATURE_MIN = 0.6;
export const OPENAI_REALTIME_TEMPERATURE_MAX = 1.2;
export const OPENAI_REALTIME_TEMPERATURE_DEFAULT = 0.8;

export function normalizeOpenAIRealtimeTemperature(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return OPENAI_REALTIME_TEMPERATURE_DEFAULT;
  }

  return Math.min(
    OPENAI_REALTIME_TEMPERATURE_MAX,
    Math.max(OPENAI_REALTIME_TEMPERATURE_MIN, value),
  );
}
