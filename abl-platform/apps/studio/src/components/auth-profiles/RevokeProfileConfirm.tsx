/**
 * RevokeProfileConfirm
 *
 * Lightweight "are you sure" confirmation for revoking an auth profile.
 * No preview / consumer querying — just a warning + confirm/cancel.
 */

'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { revokeAuthProfile, revokeWorkspaceAuthProfile } from '../../api/auth-profiles';
import { sanitizeError } from '../../lib/sanitize-error';

interface RevokeProfileConfirmProps {
  open: boolean;
  onClose: () => void;
  onRevoked: () => void;
  /** Pass a real projectId for project scope, or null for workspace scope. */
  projectId: string | null;
  profileId: string;
  profileName: string;
}

export function RevokeProfileConfirm({
  open,
  onClose,
  onRevoked,
  projectId,
  profileId,
  profileName,
}: RevokeProfileConfirmProps) {
  const t = useTranslations('auth_profiles.revoke');
  const [revoking, setRevoking] = useState(false);

  const handleConfirm = useCallback(async () => {
    setRevoking(true);
    try {
      if (projectId) {
        await revokeAuthProfile(projectId, profileId);
      } else {
        await revokeWorkspaceAuthProfile(profileId);
      }
      toast.success(t('revoke_success'));
      onRevoked();
    } catch (err) {
      toast.error(sanitizeError(err, t('revoke_failed')));
    } finally {
      setRevoking(false);
    }
  }, [projectId, profileId, onRevoked, t]);

  return (
    <Dialog open={open} onClose={onClose} title={t('revoke_profile_title')}>
      <div className="space-y-5">
        <div className="space-y-2">
          <p className="text-sm text-foreground leading-relaxed">
            {t('confirm_prompt', { name: profileName })}
          </p>
          <div className="flex items-center gap-1.5 text-xs text-error">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{t('cannot_be_undone')}</span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={revoking}>
            {t('cancel')}
          </Button>
          <Button variant="danger" size="sm" onClick={handleConfirm} loading={revoking}>
            {t('confirm_revoke_profile')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
