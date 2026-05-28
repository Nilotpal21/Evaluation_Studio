export function SkeletonLine({ className = '' }: { className?: string }) {
  return <div className={`skeleton h-4 ${className}`} />;
}

export function SkeletonCard() {
  return (
    <div className="bg-background-muted border border-default rounded-[var(--radius-xl)] p-6 space-y-3">
      <div className="skeleton h-5 w-1/3" />
      <div className="skeleton h-4 w-2/3" />
      <div className="skeleton h-8 w-1/4 mt-2" />
    </div>
  );
}

export function SkeletonTable({ rows = 5 }: { rows?: number }) {
  return (
    <div className="bg-background-muted border border-default rounded-[var(--radius-xl)] overflow-hidden">
      <div className="bg-background-subtle px-4 py-3">
        <div className="skeleton h-4 w-1/2" />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="px-4 py-3 border-t border-border-muted">
          <div className="flex gap-4">
            <div className="skeleton h-4 w-1/4" />
            <div className="skeleton h-4 w-1/3" />
            <div className="skeleton h-4 w-1/6" />
            <div className="skeleton h-4 w-1/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
