'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Timer } from 'lucide-react';
import { Badge } from '../../../ui/Badge';
import type { ErrorComponentProps } from './error-types';

export function ThrottledError({ error }: ErrorComponentProps) {
  const t = useTranslations('search_ai.sharepoint.errors');
  const [countdown, setCountdown] = useState(error.retryAfterSeconds ?? 0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setCountdown(error.retryAfterSeconds ?? 0);

    intervalRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [error.retryAfterSeconds]);

  return (
    <div className="p-4 rounded-lg border border-warning/20 bg-warning-subtle/30 space-y-3">
      <div className="flex items-center gap-2">
        <Timer className="w-4 h-4 text-warning" />
        <h4 className="text-sm font-semibold text-foreground">{t('throttled_title')}</h4>
      </div>

      <p className="text-sm text-foreground">{t('throttled_description')}</p>

      <div className="flex items-center gap-4 text-xs text-muted">
        {countdown > 0 && <Badge variant="warning">Retry in {countdown}s</Badge>}
        {error.requestsMade !== undefined && <span>{error.requestsMade} requests made</span>}
        {error.throttleScope && <span>Scope: {error.throttleScope}</span>}
        {error.syncProgressPercent !== undefined && (
          <span>Progress: {error.syncProgressPercent}%</span>
        )}
      </div>

      <p className="text-xs text-muted">{t('throttled_reassurance')}</p>
    </div>
  );
}
