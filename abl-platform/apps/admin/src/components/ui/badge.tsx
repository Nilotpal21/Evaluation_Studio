type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info' | 'accent';

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-background-elevated text-muted',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  error: 'bg-error-subtle text-error',
  info: 'bg-info-subtle text-info',
  accent: 'bg-accent-subtle text-accent',
};

export function Badge({
  children,
  variant = 'default',
  'aria-label': ariaLabel,
}: {
  children: React.ReactNode;
  variant?: BadgeVariant;
  'aria-label'?: string;
}) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-[var(--radius-full)] text-xs font-medium ${variantClasses[variant]}`}
      aria-label={ariaLabel}
    >
      {children}
    </span>
  );
}
