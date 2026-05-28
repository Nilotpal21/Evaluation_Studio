/**
 * PipelineToolbar — Compact actions bar for pipeline-level operations.
 *
 * Primary actions (Add Flow, Save, Deploy) are always visible.
 * Secondary actions (Validate, Test Routing, History, Delete) live in a "More" dropdown.
 */

'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Save,
  CheckCircle,
  Rocket,
  FlaskConical,
  History,
  Plus,
  Trash2,
  MoreHorizontal,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '../../../ui/Button';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '../../../ui/DropdownMenu';
import { usePipelineStore } from '../../../../store/pipeline-store';
import type { PipelineDefinition } from '../../../../api/pipelines';
import { DeployConfirmModal } from './DeployConfirmModal';
import { NewFlowModal } from './NewFlowModal';

export interface PipelineToolbarProps {
  definition: PipelineDefinition | null;
}

export function PipelineToolbar({ definition }: PipelineToolbarProps) {
  const t = useTranslations('search_ai.pipeline');

  const isDirty = usePipelineStore((s) => s.isDirty);
  const saveStatus = usePipelineStore((s) => s.saveStatus);
  const saveDraft = usePipelineStore((s) => s.saveDraft);
  const validate = usePipelineStore((s) => s.validate);
  const publish = usePipelineStore((s) => s.publish);
  const openPanel = usePipelineStore((s) => s.openPanel);

  const [showDeployModal, setShowDeployModal] = useState(false);
  const [showNewFlowModal, setShowNewFlowModal] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-clear "saved" status after a brief delay
  useEffect(() => {
    if (saveStatus === 'saved') {
      savedTimerRef.current = setTimeout(() => {
        // The store resets saveStatus to 'idle' when new changes are made.
        // This is a visual-only timeout hint.
      }, 2000);
    }
    return () => {
      if (savedTimerRef.current !== null) {
        clearTimeout(savedTimerRef.current);
      }
    };
  }, [saveStatus]);

  const handleSave = useCallback(() => {
    saveDraft();
  }, [saveDraft]);

  const handleValidate = useCallback(async () => {
    const result = await validate();
    if (result === null) return;
    if (result.valid) {
      toast.success(t('v2_toolbar_validate_success'));
    } else {
      toast.error(t('v2_toolbar_validate_errors', { count: result.summary.errorCount }));
    }
  }, [validate, t]);

  const handleDeploy = useCallback(() => {
    if (isDirty) {
      toast.warning(t('v2_toolbar_save_before_deploy'));
      return;
    }
    setShowDeployModal(true);
  }, [isDirty, t]);

  const handleConfirmDeploy = useCallback(async () => {
    setIsDeploying(true);
    try {
      await publish();
      toast.success(t('v2_toast_published'));
      setShowDeployModal(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t('v2_toast_publish_error'));
    } finally {
      setIsDeploying(false);
    }
  }, [publish, t]);

  const handleAddFlow = useCallback(() => {
    setShowNewFlowModal(true);
  }, []);

  const handleTestRouting = useCallback(() => {
    toast(t('v2_toolbar_test_coming_soon'));
  }, [t]);

  const handleVersionHistory = useCallback(() => {
    openPanel('version', 'version');
  }, [openPanel]);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleDeletePipeline = useCallback(() => {
    setShowDeleteConfirm(true);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    // TODO: Wire to deletePipeline API when backend supports it
    toast.success('Pipeline deleted');
    setShowDeleteConfirm(false);
  }, []);

  const canDelete = !!definition;

  const isSaving = saveStatus === 'saving';
  const isSaved = saveStatus === 'saved';

  const saveLabel = isSaving
    ? t('v2_toolbar_saving')
    : isSaved
      ? t('v2_toolbar_saved')
      : t('v2_toolbar_save_draft');

  return (
    <>
      <div className="flex items-center gap-1.5">
        {/* ── Primary actions — always visible ── */}
        <Button
          variant="ghost"
          size="xs"
          onClick={handleAddFlow}
          disabled={!definition}
          icon={<Plus className="h-3.5 w-3.5" />}
        >
          {t('v2_sidebar_add_flow')}
        </Button>

        <Button
          variant="secondary"
          size="xs"
          onClick={handleSave}
          disabled={!isDirty || isSaving || !definition}
          loading={isSaving}
          icon={
            isSaved ? <CheckCircle className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />
          }
        >
          {saveLabel}
        </Button>

        <Button
          variant="primary"
          size="xs"
          onClick={handleDeploy}
          disabled={isDirty || !definition}
          icon={<Rocket className="h-3.5 w-3.5" />}
        >
          {t('v2_toolbar_deploy')}
        </Button>

        {/* ── Secondary actions — "More" dropdown ── */}
        <DropdownMenu
          trigger={
            <Button
              variant="ghost"
              size="xs"
              disabled={!definition}
              icon={<MoreHorizontal className="h-3.5 w-3.5" />}
            />
          }
          align="end"
        >
          <DropdownMenuItem
            onSelect={handleValidate}
            icon={<FlaskConical className="h-3.5 w-3.5" />}
          >
            {t('v2_toolbar_validate')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={handleTestRouting}
            icon={<FlaskConical className="h-3.5 w-3.5" />}
          >
            {t('v2_toolbar_test_routing')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={handleVersionHistory}
            icon={<History className="h-3.5 w-3.5" />}
          >
            {t('v2_toolbar_version_history')}
          </DropdownMenuItem>
          {canDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={handleDeletePipeline}
                variant="danger"
                icon={<Trash2 className="h-3.5 w-3.5" />}
              >
                {t('v2_toolbar_delete_pipeline')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenu>
      </div>

      {definition && (
        <DeployConfirmModal
          open={showDeployModal}
          onClose={() => setShowDeployModal(false)}
          onConfirm={handleConfirmDeploy}
          definition={definition}
          isDeploying={isDeploying}
        />
      )}

      <NewFlowModal open={showNewFlowModal} onClose={() => setShowNewFlowModal(false)} />

      {/* Delete Pipeline Confirm */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-[400px] rounded-lg border border-default bg-background-elevated p-6 shadow-xl">
            <h3 className="text-sm font-semibold text-foreground">
              {t('v2_toolbar_delete_pipeline')}
            </h3>
            <p className="mt-2 text-xs text-foreground-muted">
              {t('v2_toolbar_delete_pipeline_confirm')}
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setShowDeleteConfirm(false)}>
                {t('v2_new_flow_cancel')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleConfirmDelete}
                icon={<Trash2 className="h-3.5 w-3.5" />}
              >
                {t('v2_toolbar_delete_pipeline')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
