/**
 * ValidationPanel — Overlay panel showing pipeline validation results.
 *
 * Slides in from the right and displays errors, warnings, and info
 * messages grouped by severity.
 */

'use client';

import { useTranslations } from 'next-intl';
import { X, CheckCircle, AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';

import { Badge } from '../../../ui/Badge';
import type { ValidationResult, ValidationError } from '../../../../api/pipelines';

export interface ValidationPanelProps {
  result: ValidationResult | null;
  errors: ValidationError[];
  onClose: () => void;
}

const SEVERITY_CONFIG = {
  error: {
    icon: AlertCircle,
    badgeVariant: 'error' as const,
    itemClass: 'text-error',
  },
  warning: {
    icon: AlertTriangle,
    badgeVariant: 'warning' as const,
    itemClass: 'text-warning',
  },
  info: {
    icon: Info,
    badgeVariant: 'info' as const,
    itemClass: 'text-info',
  },
} as const;

function groupBySeverity(errors: ValidationError[]) {
  const groups: Record<'error' | 'warning' | 'info', ValidationError[]> = {
    error: [],
    warning: [],
    info: [],
  };
  for (const err of errors) {
    groups[err.severity].push(err);
  }
  return groups;
}

export function ValidationPanel({ result, errors, onClose }: ValidationPanelProps) {
  const t = useTranslations('search_ai.pipeline');

  const groups = groupBySeverity(errors);
  const isValid = result?.valid === true && errors.length === 0;

  return (
    <AnimatePresence>
      {result !== null && (
        <motion.div
          className="absolute right-0 top-0 z-40 flex h-full w-[300px] flex-col border-l border-default bg-background-elevated shadow-xl"
          initial={{ x: 300, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 300, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-default px-4 py-3">
            <h3 className="text-sm font-semibold text-foreground">{t('v2_validation_title')}</h3>
            <button
              onClick={onClose}
              className="rounded-lg p-1 text-muted transition-default hover:bg-background-muted hover:text-foreground"
              aria-label={t('v2_validation_title')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-4">
            {/* Valid state */}
            {isValid && (
              <div className="flex items-center gap-2 rounded-lg bg-success-subtle/30 p-3">
                <CheckCircle className="h-4 w-4 text-success" />
                <span className="text-sm font-medium text-success">{t('v2_validation_valid')}</span>
              </div>
            )}

            {/* Summary badges */}
            {!isValid && result?.summary && (
              <div className="mb-4 flex flex-wrap gap-2">
                {result.summary.errorCount > 0 && (
                  <Badge variant="error">
                    {t('v2_validation_errors', { count: result.summary.errorCount })}
                  </Badge>
                )}
                {result.summary.warningCount > 0 && (
                  <Badge variant="warning">
                    {t('v2_validation_warnings', { count: result.summary.warningCount })}
                  </Badge>
                )}
                {result.summary.infoCount > 0 && (
                  <Badge variant="info">
                    {t('v2_validation_info', { count: result.summary.infoCount })}
                  </Badge>
                )}
              </div>
            )}

            {/* Grouped error list */}
            {(['error', 'warning', 'info'] as const).map((severity) => {
              const items = groups[severity];
              if (items.length === 0) return null;
              const config = SEVERITY_CONFIG[severity];
              const Icon = config.icon;

              return (
                <div key={severity} className="mb-4">
                  <ul className="space-y-2">
                    {items.map((item, idx) => (
                      <li
                        key={`${item.code}-${idx}`}
                        className={clsx(
                          'flex items-start gap-2 rounded-lg border border-default p-2 text-sm',
                          config.itemClass,
                        )}
                      >
                        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-foreground">{item.message}</p>
                          {item.path && <p className="mt-0.5 text-xs text-muted">{item.path}</p>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
