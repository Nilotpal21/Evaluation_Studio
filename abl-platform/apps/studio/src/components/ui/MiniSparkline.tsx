import { clsx } from 'clsx';

interface MiniSparklineProps {
  /** Array of up to 7 values (last 7 days). Each value is a count (0+). */
  data: number[];
  /** Max bar height in pixels. Default 16. */
  maxHeight?: number;
  className?: string;
}

export function MiniSparkline({ data, maxHeight = 16, className }: MiniSparklineProps) {
  const max = Math.max(...data, 1);

  return (
    <div
      className={clsx('flex items-end gap-0.5', className)}
      role="img"
      aria-label={`Activity: ${data.join(', ')} sessions`}
    >
      {data.map((value, i) => {
        const height = Math.max(2, Math.round((value / max) * maxHeight));
        return (
          <div
            key={i}
            className={clsx(
              'w-1 rounded-full transition-all duration-300',
              value > 0 ? 'bg-accent/40' : 'bg-background-muted',
            )}
            style={{ height: `${height}px` }}
          />
        );
      })}
    </div>
  );
}
