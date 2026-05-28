/**
 * IntelligenceCard
 *
 * Shared card component with 4-state visual rendering for the Intelligence Hub.
 */

import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '../../ui/Button';

export type IntelligenceCardState =
  | 'not-configured'
  | 'not-deployed'
  | 'healthy'
  | 'needs-attention'
  | 'error';

interface IntelligenceCardProps {
  title: string;
  icon: LucideIcon;
  state: IntelligenceCardState;
  stats: { label: string; value: string | number }[];
  description: string;
  actionLabel: string;
  onAction: () => void;
  attentionMessage?: string;
  errorMessage?: string;
  isLoading?: boolean;
  isError?: boolean;
}

const STATE_STYLES: Record<
  IntelligenceCardState,
  { border: string; dot: string; messageBg: string; messageText: string }
> = {
  'not-configured': {
    border: 'border-default',
    dot: 'bg-muted',
    messageBg: '',
    messageText: '',
  },
  'not-deployed': {
    border: 'border-default',
    dot: 'bg-muted opacity-50',
    messageBg: '',
    messageText: '',
  },
  healthy: {
    border: 'border-default',
    dot: 'bg-success',
    messageBg: '',
    messageText: '',
  },
  'needs-attention': {
    border: 'border-warning/30',
    dot: 'bg-warning',
    messageBg: 'bg-warning/10',
    messageText: 'text-warning',
  },
  error: {
    border: 'border-error/30',
    dot: 'bg-error',
    messageBg: 'bg-error/10',
    messageText: 'text-error',
  },
};

export function IntelligenceCard({
  title,
  icon: Icon,
  state,
  stats,
  description,
  actionLabel,
  onAction,
  attentionMessage,
  errorMessage,
  isLoading,
  isError,
}: IntelligenceCardProps) {
  const t = useTranslations('search_ai.intelligence');
  const styles = STATE_STYLES[state];

  return (
    <div
      className={clsx(
        'flex flex-col rounded-lg border bg-background p-4 transition-default hover:shadow-sm',
        styles.border,
      )}
    >
      {/* Header: icon + title + state dot */}
      <div className="flex items-center gap-2.5 mb-3">
        <div className="flex items-center justify-center w-8 h-8 rounded-md bg-background-muted">
          <Icon className="w-4 h-4 text-muted" />
        </div>
        <span className="text-sm font-medium text-foreground flex-1">{title}</span>
        <span
          role="status"
          aria-label={state}
          className={clsx('w-2 h-2 rounded-full shrink-0', styles.dot)}
        />
      </div>

      {isLoading ? (
        <div className="animate-pulse space-y-3 flex-1">
          <div className="h-3 w-20 bg-background-muted rounded" />
          <div className="h-3 w-32 bg-background-muted rounded" />
        </div>
      ) : (
        <>
          {/* Stats */}
          {stats.length > 0 && state !== 'not-configured' && state !== 'not-deployed' && (
            <div className="flex gap-4 mb-3">
              {stats.map((stat) => (
                <div key={stat.label} className="flex flex-col">
                  <span className="text-lg font-semibold text-foreground leading-tight">
                    {stat.value}
                  </span>
                  <span className="text-xs text-muted">{stat.label}</span>
                </div>
              ))}
            </div>
          )}

          {/* Fetch error message */}
          {isError && (
            <div className="rounded-md px-2.5 py-1.5 text-xs mb-3 bg-error/10 text-error">
              {t('load_status_error')}
            </div>
          )}

          {/* Attention / Error messages */}
          {state === 'needs-attention' && attentionMessage && (
            <div
              className={clsx(
                'rounded-md px-2.5 py-1.5 text-xs mb-3',
                styles.messageBg,
                styles.messageText,
              )}
            >
              {attentionMessage}
            </div>
          )}
          {state === 'error' && errorMessage && (
            <div
              className={clsx(
                'rounded-md px-2.5 py-1.5 text-xs mb-3',
                styles.messageBg,
                styles.messageText,
              )}
            >
              {errorMessage}
            </div>
          )}

          {/* Description */}
          <p className="text-xs text-muted mb-4 flex-1">{description}</p>
        </>
      )}

      {/* Action */}
      <Button
        variant={state === 'not-configured' || state === 'not-deployed' ? 'primary' : 'secondary'}
        className="w-full"
        onClick={onAction}
      >
        {actionLabel}
      </Button>
    </div>
  );
}
