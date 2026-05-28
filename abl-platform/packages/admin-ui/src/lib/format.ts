/**
 * Format a number for display.
 * - Returns "Unlimited" for -1
 * - Uses K/M suffixes for large numbers
 * - Adds locale-aware thousand separators for numbers < 10000
 */
export function formatNumber(value: number): string {
  if (value === -1) return 'Unlimited';

  const ONE_MILLION = 1_000_000;
  const ONE_THOUSAND = 1_000;

  if (Math.abs(value) >= ONE_MILLION) {
    const millions = value / ONE_MILLION;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }

  if (Math.abs(value) >= ONE_THOUSAND) {
    const thousands = value / ONE_THOUSAND;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
  }

  return value.toLocaleString();
}

/**
 * Format bytes into a human-readable string (B, KB, MB, GB, TB).
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes < 0) return 'N/A';
  if (bytes === 0) return '0 B';

  const KILO = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.floor(Math.log(bytes) / Math.log(KILO));
  const clampedIndex = Math.min(unitIndex, units.length - 1);
  const scaled = bytes / Math.pow(KILO, clampedIndex);

  return `${scaled.toFixed(clampedIndex === 0 ? 0 : decimals)} ${units[clampedIndex]}`;
}

/**
 * Format milliseconds into a human-readable duration string.
 */
export function formatMs(ms: number): string {
  if (ms < 1) return '<1ms';

  const ONE_SECOND = 1000;
  const ONE_MINUTE = 60 * ONE_SECOND;
  const ONE_HOUR = 60 * ONE_MINUTE;

  if (ms < ONE_SECOND) return `${Math.round(ms)}ms`;
  if (ms < ONE_MINUTE) return `${(ms / ONE_SECOND).toFixed(1)}s`;
  if (ms < ONE_HOUR) {
    const minutes = Math.floor(ms / ONE_MINUTE);
    const seconds = Math.round((ms % ONE_MINUTE) / ONE_SECOND);
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(ms / ONE_HOUR);
  const minutes = Math.round((ms % ONE_HOUR) / ONE_MINUTE);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Format a date string or Date object as a locale date (e.g., "Mar 3, 2026").
 */
export function formatDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Format a date string or Date object as a locale date-time
 * (e.g., "Mar 3, 2026, 2:30 PM").
 */
export function formatDateTime(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Return a human-friendly relative time string (e.g., "2 hours ago", "in 3 days").
 */
export function relativeTime(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = Date.now();
  const diffMs = now - d.getTime();
  const absDiff = Math.abs(diffMs);
  const isFuture = diffMs < 0;

  const ONE_SECOND = 1000;
  const ONE_MINUTE = 60 * ONE_SECOND;
  const ONE_HOUR = 60 * ONE_MINUTE;
  const ONE_DAY = 24 * ONE_HOUR;
  const ONE_WEEK = 7 * ONE_DAY;
  const ONE_MONTH = 30 * ONE_DAY;
  const ONE_YEAR = 365 * ONE_DAY;

  const format = (value: number, unit: string): string => {
    const rounded = Math.floor(value);
    const label = rounded === 1 ? unit : `${unit}s`;
    return isFuture ? `in ${rounded} ${label}` : `${rounded} ${label} ago`;
  };

  if (absDiff < ONE_MINUTE) return 'just now';
  if (absDiff < ONE_HOUR) return format(absDiff / ONE_MINUTE, 'minute');
  if (absDiff < ONE_DAY) return format(absDiff / ONE_HOUR, 'hour');
  if (absDiff < ONE_WEEK) return format(absDiff / ONE_DAY, 'day');
  if (absDiff < ONE_MONTH) return format(absDiff / ONE_WEEK, 'week');
  if (absDiff < ONE_YEAR) return format(absDiff / ONE_MONTH, 'month');
  return format(absDiff / ONE_YEAR, 'year');
}
