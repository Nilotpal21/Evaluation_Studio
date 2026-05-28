/**
 * DeleteProfileConfirm
 *
 * "Are you sure" confirmation for deleting a revoked auth profile.
 * Mirrors RevokeProfileConfirm's layout — no preview / consumer querying.
 */

'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { deleteAuthProfile, deleteWorkspaceAuthProfile } from '../../api/auth-profiles';
import { sanitizeError } from '../../lib/sanitize-error';

interface DeleteProfileConfirmProps {
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
  /** Pass a real projectId for project scope, or null for workspace scope. */
  projectId: string | null;
  profileId: string;
  profileName: string;
}

export function DeleteProfileConfirm({
  open,
  onClose,
  onDeleted,
  projectId,
  profileId,
  profileName,
}: DeleteProfileConfirmProps) {
  const t = useTranslations('auth_profiles');
  const [deleting, setDeleting] = useState(false);

  const handleConfirm = useCallback(async () => {
    setDeleting(true);
    try {
      if (projectId) {
        await deleteAuthProfile(projectId, profileId);
      } else {
        await deleteWorkspaceAuthProfile(profileId);
      }
      toast.success(t('deleted_success', { name: profileName }));
      onDeleted();
    } catch (err) {
      toast.error(sanitizeError(err, t('delete_failed')));
    } finally {
      setDeleting(false);
    }
  }, [projectId, profileId, profileName, onDeleted, t]);

  return (
    <Dialog open={open} onClose={onClose} title={t('delete_modal_title')}>
      <div className="space-y-5">
        <div className="space-y-2">
          <p className="text-sm text-foreground leading-relaxed">
            {t('delete_modal_confirm_prompt', { name: profileName })}
          </p>
          <div className="flex items-center gap-1.5 text-xs text-error">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{t('delete_modal_cannot_be_undone')}</span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={deleting}>
            {t('cancel')}
          </Button>
          <Button variant="danger" size="sm" onClick={handleConfirm} loading={deleting}>
            {t('delete_modal_confirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
