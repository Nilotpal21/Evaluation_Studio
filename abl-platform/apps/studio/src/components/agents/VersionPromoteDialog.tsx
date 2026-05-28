/**
 * VersionPromoteDialog Component
 *
 * Confirmation dialog for promoting an agent version to a new status.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { Badge } from '../ui/Badge';
import { ArrowRight } from 'lucide-react';

interface VersionPromoteDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (targetStatus: string) => void;
  version: string;
  currentStatus: string;
  loading?: boolean;
}

const STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['testing', 'staged'],
  testing: ['staged', 'draft'],
  staged: ['active', 'draft'],
  active: ['deprecated'],
};

const STATUS_VARIANT: Record<string, 'default' | 'info' | 'warning' | 'success' | 'error'> = {
  draft: 'default',
  testing: 'info',
  staged: 'warning',
  active: 'success',
  deprecated: 'error',
};

export function VersionPromoteDialog({
  open,
  onClose,
  onConfirm,
  version,
  currentStatus,
  loading,
}: VersionPromoteDialogProps) {
  const t = useTranslations('agents.version_promote');
  const targets = STATUS_TRANSITIONS[currentStatus] || [];
  const [target, setTarget] = useState(targets[0] || '');

  const handleConfirm = () => {
    if (target) onConfirm(target);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm">
      <div className="space-y-5">
        <div>
          <h3 className="text-lg font-semibold text-foreground">{t('title')}</h3>
          <p className="text-sm text-muted mt-1">{t('description', { version })}</p>
        </div>

        {/* Current → Target */}
        <div className="flex items-center gap-3 p-3 rounded-lg bg-background-muted border border-default">
          <Badge variant={STATUS_VARIANT[currentStatus] || 'default'}>{currentStatus}</Badge>
          <ArrowRight className="w-4 h-4 text-muted" />
          {targets.length > 0 ? (
            <Select
              value={target}
              onChange={setTarget}
              options={targets.map((s) => ({
                value: s,
                label: s.charAt(0).toUpperCase() + s.slice(1),
              }))}
            />
          ) : (
            <span className="text-sm text-muted">{t('no_transitions')}</span>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            loading={loading}
            disabled={!target || targets.length === 0}
            className="flex-1"
          >
            {t('promote_to', { target: target || '…' })}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
