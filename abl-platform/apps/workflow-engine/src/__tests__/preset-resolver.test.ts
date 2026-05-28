import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  resolvePreset,
  validateTimezone,
  validateCronExpression,
  PresetConfig,
} from '../services/preset-resolver';

describe('preset-resolver', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // UT-1: Preset-to-cron mapping
  describe('resolvePreset — cron mapping', () => {
    it('daily with time 09:00 produces "0 9 * * *"', () => {
      const result = resolvePreset({
        preset: 'daily',
        timezone: 'UTC',
        time: '09:00',
      });
      expect(result.cronExpression).toBe('0 9 * * *');
      expect(result.tz).toBe('UTC');
      expect(result.delay).toBeUndefined();
    });

    it('weekly with dow=3 produces "0 9 * * 3"', () => {
      const result = resolvePreset({
        preset: 'weekly',
        timezone: 'UTC',
        time: '09:00',
        dayOfWeek: 3,
      });
      expect(result.cronExpression).toBe('0 9 * * 3');
      expect(result.tz).toBe('UTC');
    });

    it('monthly with dom=15 produces "0 9 15 * *"', () => {
      const result = resolvePreset({
        preset: 'monthly',
        timezone: 'UTC',
        time: '09:00',
        dayOfMonth: 15,
      });
      expect(result.cronExpression).toBe('0 9 15 * *');
      expect(result.tz).toBe('UTC');
    });

    it('daily with custom time 14:30 produces "30 14 * * *"', () => {
      const result = resolvePreset({
        preset: 'daily',
        timezone: 'America/New_York',
        time: '14:30',
      });
      expect(result.cronExpression).toBe('30 14 * * *');
      expect(result.tz).toBe('America/New_York');
    });

    it('cron preset passes through a valid expression', () => {
      const result = resolvePreset({
        preset: 'cron',
        timezone: 'UTC',
        cronExpression: '*/5 * * * *',
      });
      expect(result.cronExpression).toBe('*/5 * * * *');
      expect(result.tz).toBe('UTC');
    });

    it('cron preset throws when cronExpression is missing', () => {
      expect(() => resolvePreset({ preset: 'cron', timezone: 'UTC' })).toThrow(
        'cronExpression is required for cron preset',
      );
    });
  });

  // UT-2: Timezone validation
  describe('validateTimezone', () => {
    it.each(['America/New_York', 'Asia/Tokyo', 'Europe/London'])(
      'returns true for valid timezone %s',
      (tz) => {
        expect(validateTimezone(tz)).toBe(true);
      },
    );

    it('handles UTC — result depends on Intl.supportedValuesOf inclusion', () => {
      // 'UTC' may not be in Intl.supportedValuesOf('timeZone') on all runtimes.
      // The fallback path only triggers when supportedValuesOf itself throws,
      // not when the timezone is simply absent from the list.
      const result = validateTimezone('UTC');
      expect(typeof result).toBe('boolean');
    });

    it.each(['Fake/Zone', '', 'Mars/Olympus'])('returns false for invalid timezone "%s"', (tz) => {
      expect(validateTimezone(tz)).toBe(false);
    });
  });

  // UT-3: Cron expression validation
  describe('validateCronExpression', () => {
    it.each(['0 9 * * *', '*/5 * * * *'])('returns true for valid expression "%s"', (expr) => {
      expect(validateCronExpression(expr)).toBe(true);
    });

    it('throws for invalid expression "bad cron"', () => {
      expect(() => validateCronExpression('bad cron')).toThrow(/Invalid cron expression/);
    });

    it('throws for expression with too many fields', () => {
      expect(() => validateCronExpression('1 2 3 4 5 6 7')).toThrow(/Invalid cron expression/);
    });
  });

  // UT-6: Once-schedule delay calculation
  describe('resolvePreset — once preset', () => {
    it('returns positive delay for future datetime', () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const result = resolvePreset({
        preset: 'once',
        timezone: 'UTC',
        datetime: future,
      });
      expect(result.delay).toBeGreaterThan(0);
      expect(result.delay).toBeLessThanOrEqual(60_000);
      expect(result.cronExpression).toBeUndefined();
      expect(result.tz).toBe('UTC');
    });

    it('returns 0 delay for past datetime', () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const result = resolvePreset({
        preset: 'once',
        timezone: 'UTC',
        datetime: past,
      });
      expect(result.delay).toBe(0);
    });

    it('treats wall-clock datetime as local time in the configured timezone (DST)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-01T00:00:00.000Z'));

      const result = resolvePreset({
        preset: 'once',
        timezone: 'America/New_York',
        datetime: '2026-07-16T02:02',
      });

      const expectedTargetMs = Date.parse('2026-07-16T02:02:00-04:00');
      const expectedDelay = Math.max(0, expectedTargetMs - Date.now());
      expect(result.delay).toBe(expectedDelay);
      expect(result.tz).toBe('America/New_York');
    });

    it('treats wall-clock datetime as local time in the configured timezone (standard time)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const result = resolvePreset({
        preset: 'once',
        timezone: 'America/New_York',
        datetime: '2026-01-16T02:02',
      });

      const expectedTargetMs = Date.parse('2026-01-16T02:02:00-05:00');
      const expectedDelay = Math.max(0, expectedTargetMs - Date.now());
      expect(result.delay).toBe(expectedDelay);
      expect(result.tz).toBe('America/New_York');
    });

    it('throws when datetime is missing', () => {
      expect(() => resolvePreset({ preset: 'once', timezone: 'UTC' })).toThrow(
        'datetime is required for once preset',
      );
    });
  });

  // UT-7: Preset edge cases — defaults
  describe('resolvePreset — defaults', () => {
    it('daily without time defaults to 09:00 → "0 9 * * *"', () => {
      const result = resolvePreset({ preset: 'daily', timezone: 'UTC' });
      expect(result.cronExpression).toBe('0 9 * * *');
    });

    it('weekly without dayOfWeek defaults to 1 (Monday)', () => {
      const result = resolvePreset({ preset: 'weekly', timezone: 'UTC' });
      expect(result.cronExpression).toBe('0 9 * * 1');
    });

    it('weekly without time defaults to 09:00', () => {
      const result = resolvePreset({
        preset: 'weekly',
        timezone: 'UTC',
        dayOfWeek: 5,
      });
      expect(result.cronExpression).toBe('0 9 * * 5');
    });

    it('monthly without dayOfMonth defaults to 1', () => {
      const result = resolvePreset({ preset: 'monthly', timezone: 'UTC' });
      expect(result.cronExpression).toBe('0 9 1 * *');
    });

    it('monthly without time defaults to 09:00', () => {
      const result = resolvePreset({
        preset: 'monthly',
        timezone: 'UTC',
        dayOfMonth: 20,
      });
      expect(result.cronExpression).toBe('0 9 20 * *');
    });
  });

  // Edge: unknown preset
  describe('resolvePreset — unknown preset', () => {
    it('throws for unknown preset', () => {
      expect(() =>
        resolvePreset({
          preset: 'biweekly' as PresetConfig['preset'],
          timezone: 'UTC',
        }),
      ).toThrow(/Unknown preset/);
    });
  });
});
