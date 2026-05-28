/**
 * DeployConfirmModal — Confirmation dialog shown before deploying a pipeline.
 *
 * Displays version info, flow/stage counts, and a reindex warning when
 * the embedding configuration has changed from the published version.
 */

'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';

import { Dialog } from '../../../ui/Dialog';
import { Button } from '../../../ui/Button';
import type { PipelineDefinition } from '../../../../api/pipelines';

export interface DeployConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  definition: PipelineDefinition;
  isDeploying: boolean;
}

export function DeployConfirmModal({
  open,
  onClose,
  onConfirm,
  definition,
  isDeploying,
}: DeployConfirmModalProps) {
  const t = useTranslations('search_ai.pipeline');

  const flowCount = definition.flows.length;
  const stageCount = definition.flows.reduce((acc, flow) => acc + flow.stages.length, 0);
  const hasEmbeddingChange = definition.activeEmbeddingConfig !== undefined;

  return (
    <Dialog open={open} onClose={onClose} title={t('v2_deploy_title')}>
      <div className="space-y-4">
        {/* Change summary */}
        <div className="space-y-1 text-sm text-foreground">
          <p>{t('v2_deploy_version', { version: definition.version })}</p>
          <p>{t('v2_deploy_flows', { count: flowCount })}</p>
          <p>{t('v2_deploy_stages', { count: stageCount })}</p>
        </div>

        {/* Deploy warning */}
        <div className="rounded-lg border border-warning-subtle bg-warning-subtle/30 p-3">
          <p className="text-sm text-warning">{t('v2_deploy_warning')}</p>
        </div>

        {/* Reindex warning when embedding config changed */}
        {hasEmbeddingChange && (
          <div className="flex items-start gap-2 rounded-lg border border-error-subtle bg-error-subtle/30 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-error" />
            <p className="text-sm text-error">{t('v2_deploy_reindex_warning')}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isDeploying}>
            {t('v2_deploy_cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onConfirm}
            loading={isDeploying}
            disabled={isDeploying}
          >
            {isDeploying ? t('v2_deploy_deploying') : t('v2_deploy_confirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
