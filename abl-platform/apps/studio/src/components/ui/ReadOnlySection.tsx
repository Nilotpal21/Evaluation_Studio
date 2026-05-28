'use client';

interface ReadOnlySectionProps {
  title: string;
  children: React.ReactNode;
}

export function ReadOnlySection({ title, children }: ReadOnlySectionProps) {
  return (
    <div className="rounded-xl border border-default bg-background-elevated shadow-sm">
      <div className="px-4 py-3 border-b border-default/50">
        <span className="text-sm font-semibold text-foreground">{title}</span>
      </div>
      <div className="px-4 py-4">{children}</div>
    </div>
  );
}
