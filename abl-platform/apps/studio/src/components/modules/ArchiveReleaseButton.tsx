/**
 * ArchiveReleaseButton Component
 *
 * Button with confirmation dialog for archiving a module release.
 * Handles 409 (release in use) gracefully with a user-friendly message.
 */

'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Archive, AlertTriangle } from 'lucide-react';

import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { archiveRelease } from '../../api/modules';
import { sanitizeError } from '../../lib/sanitize-error';

// =============================================================================
// TYPES
// =============================================================================

interface ArchiveReleaseButtonProps {
  projectId: string;
  releaseId: string;
  version: string;
  disabled?: boolean;
  onArchived?: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ArchiveReleaseButton({
  projectId,
  releaseId,
  version,
  disabled,
  onArchived,
}: ArchiveReleaseButtonProps) {
  const t = useTranslations('modules.archive');

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const handleArchive = useCallback(async () => {
    setArchiving(true);
    try {
      await archiveRelease(projectId, releaseId);
      toast.success(t('success', { version }));
      setConfirmOpen(false);
      onArchived?.();
    } catch (err) {
      // Check for 409 (release in use)
      const statusCode =
        err instanceof Error && 'statusCode' in err
          ? (err as unknown as { statusCode?: number }).statusCode
          : undefined;

      if (statusCode === 409) {
        toast.error(t('inUse'));
      } else {
        toast.error(sanitizeError(err, t('error')));
      }
    } finally {
      setArchiving(false);
    }
  }, [projectId, releaseId, version, t, onArchived]);

  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        icon={<Archive className="w-3 h-3" />}
        onClick={() => setConfirmOpen(true)}
        disabled={disabled}
        aria-label={t('button')}
      >
        {t('button')}
      </Button>

      <Dialog
        open={confirmOpen}
        onClose={() => !archiving && setConfirmOpen(false)}
        title={t('title')}
        maxWidth="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-foreground">{t('confirm', { version })}</p>

          <div className="rounded-lg border border-warning/30 bg-warning-subtle/30 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
              <p className="text-xs text-warning">{t('warning')}</p>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-1">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={archiving}>
              {t('cancel')}
            </Button>
            <Button
              variant="danger"
              icon={<Archive className="w-4 h-4" />}
              loading={archiving}
              onClick={handleArchive}
            >
              {t('button')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
