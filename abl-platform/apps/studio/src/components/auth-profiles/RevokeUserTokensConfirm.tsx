/**
 * RevokeUserTokensConfirm (FR-23, FR-24)
 *
 * Modal that calls GET /revoke-preview?type=tokens[&userId=...],
 * displays blast-radius counts, optional per-user toggle,
 * then calls POST /revoke-user-tokens[?userId=...].
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Toggle } from '../ui/Toggle';
import { getRevokePreview, revokeUserTokens } from '../../api/auth-profiles';
import type { BlastRadiusPayload } from '../../api/auth-profiles';
import { sanitizeError } from '../../lib/sanitize-error';

// =============================================================================
// PROPS
// =============================================================================

interface RevokeUserTokensConfirmProps {
  open: boolean;
  onClose: () => void;
  onRevoked: () => void;
  projectId: string;
  profileId: string;
  profileName: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function RevokeUserTokensConfirm({
  open,
  onClose,
  onRevoked,
  projectId,
  profileId,
  profileName,
}: RevokeUserTokensConfirmProps) {
  const t = useTranslations('auth_profiles.revoke');
  const [preview, setPreview] = useState<BlastRadiusPayload | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [perUserMode, setPerUserMode] = useState(false);
  const [userId, setUserId] = useState('');

  // Load preview on open or per-user mode change
  useEffect(() => {
    if (!open) {
      setPreview(null);
      setPreviewError(null);
      setPerUserMode(false);
      setUserId('');
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    const targetUserId = perUserMode && userId.trim() ? userId.trim() : undefined;
    getRevokePreview(projectId, profileId, 'tokens', targetUserId)
      .then((res) => setPreview(res.data))
      .catch((err) => setPreviewError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPreviewLoading(false));
  }, [open, projectId, profileId, perUserMode, userId]);

  const handleConfirm = useCallback(async () => {
    setRevoking(true);
    try {
      const targetUserId = perUserMode && userId.trim() ? userId.trim() : undefined;
      await revokeUserTokens(projectId, profileId, targetUserId);
      toast.success(t('revoke_success'));
      onRevoked();
    } catch (err) {
      toast.error(sanitizeError(err, t('revoke_failed')));
    } finally {
      setRevoking(false);
    }
  }, [projectId, profileId, perUserMode, userId, onRevoked, t]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('revoke_tokens_title')}
      description={t('revoke_tokens_description')}
    >
      <div className="space-y-4">
        {/* Per-user toggle */}
        <Toggle label={t('per_user_toggle')} checked={perUserMode} onChange={setPerUserMode} />

        {perUserMode && (
          <Input
            label={t('user_id_label')}
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder={t('user_id_placeholder')}
          />
        )}

        {/* Loading */}
        {previewLoading && (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted" />
            <span className="ml-2 text-sm text-muted">{t('loading_preview')}</span>
          </div>
        )}

        {/* Error */}
        {previewError && (
          <div className="flex items-center gap-2 rounded-lg bg-error-subtle p-3 text-sm text-error">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {t('preview_failed')}
          </div>
        )}

        {/* Preview */}
        {preview && !previewLoading && (
          <div className="space-y-3 rounded-lg border border-default p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-foreground">{t('affected_users')}</span>
              <span className="font-mono text-muted">{preview.affectedUsers}</span>
            </div>

            <div className="flex items-center justify-between text-sm">
              <span className="text-foreground">{t('active_sessions')}</span>
              <span className="font-mono text-muted">{preview.activeSessions}</span>
            </div>

            {preview.cascadeDeletesTokens !== undefined && preview.cascadeDeletesTokens > 0 && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-foreground">{t('cascade_deletes_tokens')}</span>
                <span className="font-mono text-muted">{preview.cascadeDeletesTokens}</span>
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={revoking}>
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={handleConfirm}
            loading={revoking}
            disabled={previewLoading || Boolean(previewError) || (perUserMode && !userId.trim())}
          >
            {t('confirm_revoke_tokens')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
