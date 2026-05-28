/**
 * InfoCard Component
 *
 * Colored info/warning/success/error cards for displaying contextual information.
 */

import { ReactNode } from 'react';
import { Info, AlertCircle, CheckCircle2, AlertTriangle, X } from 'lucide-react';

interface InfoCardProps {
  variant?: 'info' | 'warning' | 'success' | 'error';
  title?: string;
  message: string | ReactNode;
  onDismiss?: () => void;
  className?: string;
  size?: 'sm' | 'md';
}

const variantConfig = {
  info: {
    icon: Info,
    bgClass: 'bg-accent/10 border-accent/20',
    textClass: 'text-accent',
    iconClass: 'text-accent',
  },
  warning: {
    icon: AlertTriangle,
    bgClass: 'bg-warning/10 border-warning/20',
    textClass: 'text-warning',
    iconClass: 'text-warning',
  },
  success: {
    icon: CheckCircle2,
    bgClass: 'bg-success/10 border-success/20',
    textClass: 'text-success',
    iconClass: 'text-success',
  },
  error: {
    icon: AlertCircle,
    bgClass: 'bg-error/10 border-error/20',
    textClass: 'text-error',
    iconClass: 'text-error',
  },
};

export function InfoCard({
  variant = 'info',
  title,
  message,
  onDismiss,
  className = '',
  size = 'md',
}: InfoCardProps) {
  const config = variantConfig[variant];
  const Icon = config.icon;

  const sizeClasses = {
    sm: 'p-3 text-xs',
    md: 'p-4 text-sm',
  };

  const iconSizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-4 h-4',
  };

  return (
    <div
      className={`rounded-lg border ${config.bgClass} ${sizeClasses[size]} flex items-start gap-3 ${className}`}
    >
      <Icon className={`${iconSizeClasses[size]} ${config.iconClass} flex-shrink-0 mt-0.5`} />
      <div className="flex-1 min-w-0">
        {title && <h4 className={`font-semibold ${config.textClass} mb-1`}>{title}</h4>}
        <div className={`${config.textClass} leading-relaxed`}>
          {typeof message === 'string' ? <p>{message}</p> : message}
        </div>
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className={`flex-shrink-0 p-1 hover:bg-black/5 rounded transition-colors ${config.textClass}`}
          aria-label="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
