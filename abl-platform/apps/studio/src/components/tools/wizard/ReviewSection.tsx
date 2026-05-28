/**
 * ReviewSection Component
 *
 * Grouped section card for wizard review steps.
 * Shows icon + title + optional badge, content rows, and edit shortcut.
 */

import { Pencil } from 'lucide-react';

export interface ReviewSectionProps {
  icon: React.ReactNode;
  title: string;
  badge?: string;
  editStep?: number;
  onEdit?: (step: number) => void;
  children: React.ReactNode;
}

export function ReviewSection({
  icon,
  title,
  badge,
  editStep,
  onEdit,
  children,
}: ReviewSectionProps) {
  return (
    <div className="rounded-lg border border-default bg-background-muted p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-muted">{icon}</span>
          <h4 className="text-sm font-semibold text-foreground">{title}</h4>
          {badge && (
            <span className="text-xs font-medium text-accent bg-accent-subtle px-2 py-0.5 rounded-full">
              {badge}
            </span>
          )}
        </div>
        {editStep !== undefined && onEdit && (
          <button
            type="button"
            onClick={() => onEdit(editStep)}
            className="flex items-center gap-1 text-xs text-info hover:text-info/80 transition-default"
          >
            <Pencil className="w-3 h-3" />
            Edit
          </button>
        )}
      </div>
      <div className="space-y-1.5 text-sm">{children}</div>
    </div>
  );
}

export function ReviewRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted text-xs w-28 shrink-0 pt-0.5">{label}</span>
      <span className={`text-foreground text-sm ${mono ? 'font-mono' : ''} break-all`}>
        {value}
      </span>
    </div>
  );
}
