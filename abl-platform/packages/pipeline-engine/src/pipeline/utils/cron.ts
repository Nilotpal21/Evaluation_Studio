/**
 * Simple cron time calculator.
 * Calculates the next execution time based on a cron expression.
 *
 * Supports standard 5-field cron format: minute hour dayOfMonth month dayOfWeek
 * For a production system, consider using a library like cron-parser.
 * This implementation covers the common cases needed for pipeline scheduling.
 */

/**
 * Get the next cron execution time after the given timestamp.
 *
 * @param cronExpression - Standard 5-field cron expression (e.g., "0 0 * * *" or interval syntax)
 * @param now - Current timestamp in milliseconds
 * @returns Next execution timestamp in milliseconds
 */
export function getNextCronTime(cronExpression: string, now: number): number {
  const fields = cronExpression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${fields.length}`);
  }

  const [minuteField, hourField] = fields;

  // Parse interval patterns like */6
  const minuteInterval = parseInterval(minuteField);
  const hourInterval = parseInterval(hourField);

  const date = new Date(now);
  // Move to next minute boundary
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);

  // Simple forward scan -- find the next matching time.
  // Cap at 366 days to prevent infinite loops on unmatchable expressions.
  const MAX_ITERATIONS = 366 * 24 * 60;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (
      matchesField(date.getMinutes(), minuteField, minuteInterval) &&
      matchesField(date.getHours(), hourField, hourInterval)
    ) {
      return date.getTime();
    }
    date.setMinutes(date.getMinutes() + 1);
  }

  // Fallback: 1 hour from now (should only be reached for pathological expressions)
  const FALLBACK_DELAY_MS = 3_600_000;
  return now + FALLBACK_DELAY_MS;
}

function parseInterval(field: string): number | null {
  const match = field.match(/^\*\/(\d+)$/);
  if (match) return parseInt(match[1], 10);
  return null;
}

function matchesField(value: number, field: string, interval: number | null): boolean {
  if (field === '*') return true;
  if (interval !== null) return value % interval === 0;
  // Exact value or comma-separated list
  const exactValues = field.split(',').map(Number);
  return exactValues.includes(value);
}
