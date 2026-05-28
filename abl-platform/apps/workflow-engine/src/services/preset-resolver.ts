/**
 * Preset Resolver
 *
 * Pure function module that converts user-friendly schedule presets
 * (daily, weekly, monthly, once, cron) to BullMQ-compatible schedule options.
 */

import { CronExpressionParser } from 'cron-parser';

export interface PresetConfig {
  preset: 'daily' | 'weekly' | 'monthly' | 'once' | 'cron';
  timezone: string; // IANA timezone
  time?: string; // HH:MM (daily/weekly/monthly)
  dayOfWeek?: number; // 0-6 (weekly)
  dayOfMonth?: number; // 1-28 (monthly)
  datetime?: string; // ISO 8601 (once)
  cronExpression?: string; // raw cron (for 'cron' preset)
}

export interface ResolvedSchedule {
  cronExpression?: string; // undefined for 'once' preset
  delay?: number; // ms from now (for 'once' preset)
  tz?: string; // IANA timezone for BullMQ
}

const HAS_OFFSET_SUFFIX_RE = /(Z|[+-]\d{2}:?\d{2})$/;

function parseWallClockDatetime(input: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(input.trim()) ?? null;
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m;
  return {
    year: Number(Y),
    month: Number(Mo),
    day: Number(D),
    hour: Number(H),
    minute: Number(Mi),
    second: S ? Number(S) : 0,
  };
}

function offsetAtUtcInstant(instantUtcMs: number, tz: string): number {
  // Determine the UTC offset for `tz` at this instant by formatting the instant
  // into `tz` components and interpreting those components as if they were UTC.
  //
  // The delta between that "as-UTC" timestamp and the real instant is the offset.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = fmt.formatToParts(new Date(instantUtcMs));
  const get = (type: string): number => {
    const val = parts.find((p) => p.type === type)?.value;
    return val ? Number(val) : NaN;
  };
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');

  const asUtc = Date.UTC(
    year,
    month - 1,
    day,
    // Some runtimes emit hour "24" for midnight; normalize.
    hour % 24,
    minute,
    second,
  );
  return asUtc - instantUtcMs;
}

function parseDatetimeInZone(input: string, tz: string): number {
  const trimmed = input.trim();
  // Absolute datetime: preserve existing behavior for ISO with Z/offset.
  if (HAS_OFFSET_SUFFIX_RE.test(trimmed)) return Date.parse(trimmed);

  // Wall-clock datetime: interpret as local time in `tz` (datetime-local input).
  const wall = parseWallClockDatetime(trimmed);
  if (!wall) return NaN;

  // Convert the wall-clock into a UTC timestamp by solving for the timezone
  // offset at that moment. Two-pass handles DST boundaries.
  const wallUtcMs = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  try {
    const guess = wallUtcMs - offsetAtUtcInstant(wallUtcMs, tz);
    return wallUtcMs - offsetAtUtcInstant(guess, tz);
  } catch {
    return NaN;
  }
}

/**
 * Resolve a preset config to a BullMQ schedule.
 */
export function resolvePreset(config: PresetConfig): ResolvedSchedule {
  const tz = config.timezone;

  switch (config.preset) {
    case 'daily': {
      const [hr, min] = parseTime(config.time ?? '09:00');
      return { cronExpression: `${min} ${hr} * * *`, tz };
    }
    case 'weekly': {
      const [hr, min] = parseTime(config.time ?? '09:00');
      const dow = config.dayOfWeek ?? 1; // default Monday
      return { cronExpression: `${min} ${hr} * * ${dow}`, tz };
    }
    case 'monthly': {
      const [hr, min] = parseTime(config.time ?? '09:00');
      const dom = config.dayOfMonth ?? 1;
      return { cronExpression: `${min} ${hr} ${dom} * *`, tz };
    }
    case 'once': {
      if (!config.datetime) {
        throw new Error('datetime is required for once preset');
      }
      const targetMs = parseDatetimeInZone(config.datetime, tz);
      if (!Number.isFinite(targetMs)) {
        throw new Error('datetime must be a valid ISO 8601 date-time string');
      }
      const nowMs = Date.now();
      const delay = Math.max(0, targetMs - nowMs);
      return { delay, tz };
    }
    case 'cron': {
      if (!config.cronExpression) {
        throw new Error('cronExpression is required for cron preset');
      }
      validateCronExpression(config.cronExpression);
      return { cronExpression: config.cronExpression, tz };
    }
    default:
      throw new Error(`Unknown preset: ${(config as { preset: string }).preset}`);
  }
}

/** Parse "HH:MM" into [hour, minute] numbers */
function parseTime(time: string): [number, number] {
  const parts = time.split(':');
  const hr = parseInt(parts[0], 10);
  const min = parseInt(parts[1], 10);
  if (isNaN(hr) || isNaN(min) || hr < 0 || hr > 23 || min < 0 || min > 59) {
    throw new Error(`Invalid time format: ${time}. Expected HH:MM`);
  }
  return [hr, min];
}

/**
 * Validate a timezone string against IANA timezone database.
 */
export function validateTimezone(tz: string): boolean {
  try {
    const timezones = Intl.supportedValuesOf('timeZone');
    return timezones.includes(tz);
  } catch {
    // Fallback for environments without Intl.supportedValuesOf
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Validate a cron expression using cron-parser.
 * Throws on invalid expression.
 */
export function validateCronExpression(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch (err) {
    throw new Error(
      `Invalid cron expression: ${expr}. ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
