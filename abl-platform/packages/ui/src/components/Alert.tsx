'use client';

import { clsx } from 'clsx';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';

type AlertVariant = 'info' | 'success' | 'warning' | 'error';

interface AlertProps {
  variant: AlertVariant;
  title?: string;
  children: React.ReactNode;
  className?: string;
}

const variantStyles: Record<AlertVariant, string> = {
  info: 'bg-info-subtle border-info text-info',
  success: 'bg-success-subtle border-success text-success',
  warning: 'bg-warning-subtle border-warning text-warning',
  error: 'bg-error-subtle border-error text-error',
};

const variantIcons: Record<AlertVariant, React.ReactNode> = {
  info: <Info className="w-4 h-4 shrink-0" />,
  success: <CheckCircle2 className="w-4 h-4 shrink-0" />,
  warning: <AlertTriangle className="w-4 h-4 shrink-0" />,
  error: <XCircle className="w-4 h-4 shrink-0" />,
};

export function Alert({ variant, title, children, className }: AlertProps) {
  const isAlertRole = variant === 'error' || variant === 'warning';

  return (
    <div
      role={isAlertRole ? 'alert' : 'status'}
      className={clsx(
        'flex gap-3 rounded-lg border p-3 text-sm',
        variantStyles[variant],
        className,
      )}
    >
      {variantIcons[variant]}
      <div>
        {title && <p className="font-medium">{title}</p>}
        <div className={clsx(title && 'mt-0.5', 'text-foreground-muted')}>{children}</div>
      </div>
    </div>
  );
}
