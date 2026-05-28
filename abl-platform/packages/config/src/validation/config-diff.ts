/**
 * Configuration Diff
 *
 * Compare two config objects and highlight differences.
 */

export interface DiffEntry {
  path: string;
  status: 'added' | 'removed' | 'changed' | 'same';
  leftValue?: unknown;
  rightValue?: unknown;
  isSensitive: boolean;
}

export interface ConfigDiff {
  entries: DiffEntry[];
  hasCriticalDiffs: boolean;
  summary: {
    added: number;
    removed: number;
    changed: number;
    same: number;
  };
}

import { SENSITIVE_PATHS } from '../constants/sensitive-paths.js';

/**
 * Diff two config objects.
 */
export function diffConfigs(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  _leftLabel?: string,
  _rightLabel?: string,
): ConfigDiff {
  const entries: DiffEntry[] = [];

  function walk(l: Record<string, unknown>, r: Record<string, unknown>, prefix: string): void {
    const allKeys = new Set([...Object.keys(l), ...Object.keys(r)]);

    for (const key of allKeys) {
      const path = prefix ? `${prefix}.${key}` : key;
      const isSensitive = SENSITIVE_PATHS.includes(path);
      const lVal = l[key];
      const rVal = r[key];

      if (!(key in l)) {
        entries.push({
          path,
          status: 'added',
          rightValue: isSensitive ? '***' : rVal,
          isSensitive,
        });
      } else if (!(key in r)) {
        entries.push({
          path,
          status: 'removed',
          leftValue: isSensitive ? '***' : lVal,
          isSensitive,
        });
      } else if (Array.isArray(lVal) && Array.isArray(rVal)) {
        // Array comparison: use JSON.stringify for config value equality
        const lJson = JSON.stringify(lVal);
        const rJson = JSON.stringify(rVal);
        entries.push({
          path,
          status: lJson === rJson ? 'same' : 'changed',
          leftValue: isSensitive ? '***' : lVal,
          rightValue: isSensitive ? '***' : rVal,
          isSensitive,
        });
      } else if (
        typeof lVal === 'object' &&
        lVal !== null &&
        typeof rVal === 'object' &&
        rVal !== null &&
        !Array.isArray(lVal) &&
        !Array.isArray(rVal)
      ) {
        walk(lVal as Record<string, unknown>, rVal as Record<string, unknown>, path);
      } else if (JSON.stringify(lVal) !== JSON.stringify(rVal)) {
        entries.push({
          path,
          status: 'changed',
          leftValue: isSensitive ? '***' : lVal,
          rightValue: isSensitive ? '***' : rVal,
          isSensitive,
        });
      } else {
        entries.push({
          path,
          status: 'same',
          leftValue: isSensitive ? '***' : lVal,
          rightValue: isSensitive ? '***' : rVal,
          isSensitive,
        });
      }
    }
  }

  walk(left, right, '');

  const summary = {
    added: entries.filter((e) => e.status === 'added').length,
    removed: entries.filter((e) => e.status === 'removed').length,
    changed: entries.filter((e) => e.status === 'changed').length,
    same: entries.filter((e) => e.status === 'same').length,
  };

  const hasCriticalDiffs = entries.some((e) => e.isSensitive && e.status === 'changed');

  return { entries, hasCriticalDiffs, summary };
}
