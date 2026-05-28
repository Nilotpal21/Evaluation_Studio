/**
 * CopyVariablesDialog Component
 *
 * Dialog for copying environment variables from one environment to another.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog } from '../ui/Dialog';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { Toggle } from '../ui/Toggle';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import { copyEnvironmentVariables } from '../../api/environment-variables';

const ENVIRONMENTS = ['dev', 'staging', 'production'];

interface CopyVariablesDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  targetEnvironment: string | null;
  onCopied: () => void;
}

export function CopyVariablesDialog({
  open,
  onClose,
  projectId,
  targetEnvironment,
  onCopied,
}: CopyVariablesDialogProps) {
  const t = useTranslations('deployments.copy_variables_dialog');
  const [sourceEnvironment, setSourceEnvironment] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [copying, setCopying] = useState(false);

  const availableSources = ENVIRONMENTS.filter((e) => e !== targetEnvironment);

  const handleCopy = async () => {
    if (!sourceEnvironment || !targetEnvironment) return;
    setCopying(true);
    try {
      const result = await copyEnvironmentVariables(projectId, {
        sourceEnvironment,
        targetEnvironment,
        overwrite,
      });
      const skippedPart = result.skipped > 0 ? t('skipped_suffix', { count: result.skipped }) : '';
      toast.success(t('success', { copied: result.copied, skipped: skippedPart }));
      onCopied();
      onClose();
    } catch (err) {
      toast.error(sanitizeError(err, t('error')));
    } finally {
      setCopying(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('title')}>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Copy all variables from another environment into{' '}
          <strong>{targetEnvironment ?? 'base'}</strong>.
        </p>

        <Select
          label={t('source_label')}
          value={sourceEnvironment}
          onChange={setSourceEnvironment}
          options={[
            { value: '', label: t('source_placeholder') },
            ...availableSources.map((e) => ({
              value: e,
              label: e.charAt(0).toUpperCase() + e.slice(1),
            })),
          ]}
        />

        <Toggle checked={overwrite} onChange={setOverwrite} label={t('overwrite_label')} />

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} className="flex-1">
            {t('cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            variant="primary"
            onClick={handleCopy}
            loading={copying}
            disabled={!sourceEnvironment}
            className="flex-1"
          >
            {t('copy_button')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
