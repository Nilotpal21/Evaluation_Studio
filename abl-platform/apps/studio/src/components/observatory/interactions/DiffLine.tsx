/**
 * DiffLine — Single line in a git-style memory diff.
 *
 * Design spec Section 8.2.3:
 * | Type | Prefix | Left Border | Background | Text Color |
 * | Added   | +  | green 3px  | green 6%  | green |
 * | Changed | ~  | amber 3px  | amber 6%  | old: red strikethrough, new: amber |
 * | Removed | -  | red 3px    | red 6%    | red strikethrough |
 * | Unchanged | (none) | none | none | dimmed 15% |
 */

import clsx from 'clsx';

export type DiffType = 'added' | 'changed' | 'removed' | 'unchanged';

interface DiffLineProps {
  type: DiffType;
  keyName: string;
  value?: string;
  oldValue?: string;
  /** Tool that wrote this key (source attribution) */
  source?: string;
}

export function DiffLine({ type, keyName, value, oldValue, source }: DiffLineProps) {
  const config = DIFF_CONFIG[type];

  return (
    <div
      className={clsx(
        'flex items-baseline gap-2 px-2 py-0.5 text-[10px] font-mono rounded-sm',
        config.bg,
        config.borderLeft,
      )}
    >
      {/* Prefix */}
      <span className={clsx('w-3 shrink-0 text-center font-bold', config.prefixColor)}>
        {config.prefix}
      </span>

      {/* Key name */}
      <span
        className={clsx(
          'shrink-0',
          type === 'unchanged' ? 'text-foreground-subtle opacity-40' : 'text-foreground-muted',
        )}
      >
        {keyName}:
      </span>

      {/* Value */}
      <span className="flex-1 min-w-0 truncate">
        {type === 'changed' ? (
          <>
            <span className="text-error line-through mr-1">{formatValue(oldValue)}</span>
            <span className="text-warning">→</span>
            <span className="text-warning ml-1">{formatValue(value)}</span>
          </>
        ) : type === 'removed' ? (
          <span className="text-error line-through">{formatValue(oldValue ?? value)}</span>
        ) : type === 'unchanged' ? (
          <span className="text-foreground-subtle opacity-40">{formatValue(value)}</span>
        ) : (
          <span className="text-success">{formatValue(value)}</span>
        )}
      </span>

      {/* Source attribution */}
      {source && type !== 'unchanged' ? (
        <span className="text-foreground-subtle opacity-60 shrink-0">← {source}</span>
      ) : null}
    </div>
  );
}

const DIFF_CONFIG: Record<
  DiffType,
  { prefix: string; prefixColor: string; bg: string; borderLeft: string }
> = {
  added: {
    prefix: '+',
    prefixColor: 'text-success',
    bg: 'bg-success/[0.06]',
    borderLeft: 'border-l-[3px] border-success',
  },
  changed: {
    prefix: '~',
    prefixColor: 'text-warning',
    bg: 'bg-warning/[0.06]',
    borderLeft: 'border-l-[3px] border-warning',
  },
  removed: {
    prefix: '-',
    prefixColor: 'text-error',
    bg: 'bg-error/[0.06]',
    borderLeft: 'border-l-[3px] border-error',
  },
  unchanged: {
    prefix: '',
    prefixColor: '',
    bg: '',
    borderLeft: 'border-l-[3px] border-transparent',
  },
};

function formatValue(val: unknown): string {
  if (val === undefined || val === null) return 'null';
  if (typeof val === 'string') return `"${val}"`;
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}
