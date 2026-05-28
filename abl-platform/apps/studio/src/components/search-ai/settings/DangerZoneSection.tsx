/**
 * DangerZoneSection Component
 *
 * Destructive actions: rebuild index and delete knowledge base.
 * Uses ConfirmDialog for confirmation.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { sanitizeError } from '@/lib/sanitize-error';
import { useNavigationStore } from '../../../store/navigation-store';
import {
  deleteKnowledgeBase,
  rebuildKnowledgeBase,
  type KnowledgeBaseDetail,
} from '../../../api/search-ai';

interface DangerZoneSectionProps {
  knowledgeBase: KnowledgeBaseDetail;
  onDeleted: () => void;
  onUpdated?: () => void;
}

export function DangerZoneSection({ knowledgeBase, onDeleted, onUpdated }: DangerZoneSectionProps) {
  const t = useTranslations('search_ai.settings_danger');
  const { projectId, navigate } = useNavigationStore();
  const [rebuilding, setRebuilding] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'rebuild' | 'delete' | null>(null);

  async function handleRebuild() {
    setRebuilding(true);
    try {
      await rebuildKnowledgeBase(knowledgeBase._id);
      onUpdated?.();
      toast.success(t('toast_rebuild_started'));
      setConfirmAction(null);
    } catch (err) {
      toast.error(sanitizeError(err, t('error_operation_failed')));
    } finally {
      setRebuilding(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteKnowledgeBase(knowledgeBase._id);
      toast.success(t('toast_deleted'));
      setConfirmAction(null);
      onDeleted();
      if (projectId) {
        navigate(`/projects/${projectId}/search-ai`);
      }
    } catch (err) {
      toast.error(sanitizeError(err, t('error_operation_failed')));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-error">{t('title')}</h3>

      <div className="rounded-lg border border-error/30 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">{t('rebuild_title')}</p>
            <p className="text-xs text-muted">{t('rebuild_desc')}</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            loading={rebuilding}
            disabled={deleting}
            onClick={() => setConfirmAction('rebuild')}
          >
            {t('rebuild_button')}
          </Button>
        </div>

        <div className="border-t border-error/20" />

        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">{t('delete_title')}</p>
            <p className="text-xs text-muted">{t('delete_desc')}</p>
          </div>
          <Button
            variant="danger"
            size="sm"
            loading={deleting}
            icon={<Trash2 className="w-3.5 h-3.5" />}
            onClick={() => setConfirmAction('delete')}
          >
            {t('delete_button')}
          </Button>
        </div>
      </div>

      {/* Rebuild Confirmation */}
      <ConfirmDialog
        open={confirmAction === 'rebuild'}
        onClose={() => setConfirmAction(null)}
        onConfirm={handleRebuild}
        title={t('rebuild_confirm_title')}
        description={t('rebuild_confirm_desc')}
        confirmLabel={t('rebuild_confirm_label')}
        variant="danger"
        loading={rebuilding}
      />

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={confirmAction === 'delete'}
        onClose={() => setConfirmAction(null)}
        onConfirm={handleDelete}
        title={t('delete_confirm_title')}
        description={t('delete_confirm_desc', { name: knowledgeBase.name })}
        confirmLabel={t('delete_confirm_label')}
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
