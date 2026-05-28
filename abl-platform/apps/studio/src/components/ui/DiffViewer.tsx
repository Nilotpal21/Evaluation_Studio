/**
 * DiffViewer Component
 *
 * Side-by-side text diff viewer for DSL version comparison.
 * Uses a simple line-based diff approach.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { clsx } from 'clsx';

interface DiffViewerProps {
  left: string;
  right: string;
  leftLabel?: string;
  rightLabel?: string;
  className?: string;
}

interface DiffLine {
  type: 'same' | 'added' | 'removed';
  content: string;
  leftNum: number | null;
  rightNum: number | null;
}

function computeDiff(left: string, right: string): DiffLine[] {
  const leftLines = left.split('\n');
  const rightLines = right.split('\n');
  const result: DiffLine[] = [];

  // Simple LCS-based diff
  const m = leftLines.length;
  const n = rightLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (leftLines[i - 1] === rightLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  let i = m,
    j = n;
  const reversed: DiffLine[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && leftLines[i - 1] === rightLines[j - 1]) {
      reversed.push({ type: 'same', content: leftLines[i - 1], leftNum: i, rightNum: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      reversed.push({ type: 'added', content: rightLines[j - 1], leftNum: null, rightNum: j });
      j--;
    } else {
      reversed.push({ type: 'removed', content: leftLines[i - 1], leftNum: i, rightNum: null });
      i--;
    }
  }

  return reversed.reverse();
}

const lineColors = {
  same: '',
  added: 'bg-success-subtle',
  removed: 'bg-error-subtle',
};

const lineTextColors = {
  same: 'text-foreground',
  added: 'text-success',
  removed: 'text-error',
};

export function DiffViewer({ left, right, leftLabel, rightLabel, className }: DiffViewerProps) {
  const t = useTranslations('common');
  const diff = useMemo(() => computeDiff(left, right), [left, right]);
  const hasChanges = diff.some((l) => l.type !== 'same');

  return (
    <div className={clsx('border border-default rounded-lg overflow-hidden', className)}>
      {/* Header */}
      <div className="flex border-b border-default bg-background-muted text-xs font-medium text-muted">
        <div className="flex-1 px-3 py-2 border-r border-default">{leftLabel || t('previous')}</div>
        <div className="flex-1 px-3 py-2">{rightLabel || t('current')}</div>
      </div>

      {/* Diff content */}
      {!hasChanges ? (
        <div className="text-center py-8 text-sm text-muted">{t('no_differences')}</div>
      ) : (
        <div className="overflow-auto max-h-[500px]" style={{ fontFamily: 'var(--font-mono)' }}>
          {diff.map((line, idx) => (
            <div key={idx} className={clsx('flex text-xs leading-5', lineColors[line.type])}>
              {/* Line numbers */}
              <span className="w-10 text-right pr-2 text-subtle select-none shrink-0 border-r border-default">
                {line.leftNum ?? ''}
              </span>
              <span className="w-10 text-right pr-2 text-subtle select-none shrink-0 border-r border-default">
                {line.rightNum ?? ''}
              </span>
              {/* Prefix */}
              <span className={clsx('w-5 text-center shrink-0', lineTextColors[line.type])}>
                {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
              </span>
              {/* Content */}
              <span className={clsx('flex-1 px-2 whitespace-pre', lineTextColors[line.type])}>
                {line.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
