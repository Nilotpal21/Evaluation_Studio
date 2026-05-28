'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Dialog } from '../ui/Dialog';
import { Textarea } from '../ui/Textarea';
import type { AuditEvent, RuleSeverity } from '../../lib/governance-contracts';

interface OverrideModalProps {
  event: AuditEvent | null;
  onClose: () => void;
  onSubmit: (
    eventRef: string,
    justification: string,
    originalSeverity: RuleSeverity,
  ) => Promise<void>;
}

function severityVariant(severity: RuleSeverity) {
  switch (severity) {
    case 'critical':
      return 'error' as const;
    case 'warning':
      return 'warning' as const;
    default:
      return 'info' as const;
  }
}

export function OverrideModal({ event, onClose, onSubmit }: OverrideModalProps) {
  const t = useTranslations('governance');
  const [justification, setJustification] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!event || !justification.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit(event.eventRef, justification.trim(), event.severity);
      toast.success(t('override.success'));
      setJustification('');
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('override.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={!!event}
      onClose={onClose}
      title={t('override.title')}
      description={t('override.description')}
      maxWidth="md"
    >
      {event && (
        <div className="mb-4 rounded-lg border border-default bg-background-muted p-3 space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <Badge variant={severityVariant(event.severity)}>{event.severity}</Badge>
            <span className="font-medium">{event.metric.replace(/_/g, ' ')}</span>
          </div>
          <div className="text-xs text-muted">
            {t('override.agent')}: {event.agentName} · {t('override.actual')}: {event.actualValue} ·{' '}
            {t('override.threshold')}: {event.thresholdAtTime}
          </div>
        </div>
      )}

      <Textarea
        className="mb-4"
        label={t('override.justification_label')}
        rows={4}
        value={justification}
        onChange={(e) => setJustification(e.target.value)}
        placeholder={t('override.justification_placeholder')}
      />

      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
          {t('action.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleSubmit}
          loading={submitting}
          disabled={!justification.trim()}
        >
          {t('override.submit')}
        </Button>
      </div>
    </Dialog>
  );
}
