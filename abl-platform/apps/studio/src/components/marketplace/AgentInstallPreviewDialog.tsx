'use client';

import { useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, AlertCircle, AlertTriangle, Plus, Pencil } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { PostInstallChecklist } from './PostInstallChecklist';
import {
  useMarketplaceStore,
  selectInstallLoading,
  selectInstallError,
  selectInstallResult,
  selectAgentPreview,
  selectAgentPreviewLoading,
  selectAgentPreviewError,
} from '@/store/marketplace-store';
import type { MarketplaceTemplate, MarketplaceTemplateVersion } from '@/store/marketplace-store';

interface AgentInstallPreviewDialogProps {
  open: boolean;
  onClose: () => void;
  template: MarketplaceTemplate;
  version: MarketplaceTemplateVersion;
  projectId: string;
  projectName: string;
  onInstallComplete: () => void;
}

type DialogPhase = 'loading-preview' | 'preview-ready' | 'applying' | 'success' | 'error';

export function AgentInstallPreviewDialog({
  open,
  onClose,
  template,
  version,
  projectId,
  projectName,
  onInstallComplete,
}: AgentInstallPreviewDialogProps) {
  const t = useTranslations('marketplace');

  const agentPreview = useMarketplaceStore(selectAgentPreview);
  const agentPreviewLoading = useMarketplaceStore(selectAgentPreviewLoading);
  const agentPreviewError = useMarketplaceStore(selectAgentPreviewError);
  const installLoading = useMarketplaceStore(selectInstallLoading);
  const installError = useMarketplaceStore(selectInstallError);
  const installResult = useMarketplaceStore(selectInstallResult);
  const previewAgentInstall = useMarketplaceStore((s) => s.previewAgentInstall);
  const applyAgentInstall = useMarketplaceStore((s) => s.applyAgentInstall);
  const resetInstallState = useMarketplaceStore((s) => s.resetInstallState);

  useEffect(() => {
    if (open) {
      resetInstallState();
      previewAgentInstall(projectId, template.slug, version.version);
    }
  }, [open, projectId, template.slug, version.version, previewAgentInstall, resetInstallState]);

  const phase: DialogPhase = agentPreviewLoading
    ? 'loading-preview'
    : installLoading
      ? 'applying'
      : installResult
        ? 'success'
        : (agentPreviewError ?? installError)
          ? 'error'
          : 'preview-ready';

  const handleConfirm = useCallback(async () => {
    await applyAgentInstall(projectId, template.slug, version.version, agentPreview?.previewDigest);
  }, [projectId, template.slug, version.version, agentPreview, applyAgentInstall]);

  const handleClose = useCallback(() => {
    resetInstallState();
    onClose();
  }, [resetInstallState, onClose]);

  const handleRetry = useCallback(() => {
    resetInstallState();
    previewAgentInstall(projectId, template.slug, version.version);
  }, [resetInstallState, previewAgentInstall, projectId, template.slug, version.version]);

  const preview = agentPreview?.preview;
  const hasBlockingIssues = preview?.hasBlockingIssues ?? false;
  const addedAgents = preview?.agentChanges?.added ?? [];
  const modifiedAgents = preview?.agentChanges?.modified ?? [];
  const addedTools = preview?.toolChanges?.added ?? [];
  const modifiedTools = preview?.toolChanges?.modified ?? [];
  const issues = preview?.issues ?? [];

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={t('install.previewTitle')}
      description={t('install.previewDescription')}
      maxWidth="lg"
    >
      {/* Loading preview */}
      {phase === 'loading-preview' && (
        <div className="flex flex-col items-center justify-center py-8 gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-accent border-t-transparent animate-spin" />
          <p className="text-sm text-muted">{t('install.generatingPreview')}</p>
        </div>
      )}

      {/* Preview ready */}
      {phase === 'preview-ready' && preview && (
        <div className="space-y-4">
          {/* Target project info */}
          <div className="rounded-lg border border-default bg-background-subtle px-3 py-2">
            <p className="text-xs text-muted">
              {t('install.selectProject')}:{' '}
              <span className="font-medium text-foreground">{projectName}</span>
            </p>
          </div>

          {/* Changes summary */}
          <div className="space-y-3">
            {/* Agents to add */}
            {addedAgents.length > 0 && (
              <div className="flex items-start gap-2">
                <Plus className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-foreground">
                    {t('install.agentsToAdd', { count: addedAgents.length })}
                  </p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {addedAgents.map((name) => (
                      <span
                        key={name}
                        className="inline-flex items-center px-2 py-0.5 rounded-md text-xs bg-success/10 text-success border border-success/20"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Agents to modify */}
            {modifiedAgents.length > 0 && (
              <div className="flex items-start gap-2">
                <Pencil className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-foreground">
                    {t('install.agentsToModify', { count: modifiedAgents.length })}
                  </p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {modifiedAgents.map((agent) => (
                      <span
                        key={agent.name}
                        className="inline-flex items-center px-2 py-0.5 rounded-md text-xs bg-warning/10 text-warning border border-warning/20"
                      >
                        {agent.name}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Tools to add */}
            {addedTools.length > 0 && (
              <div className="flex items-start gap-2">
                <Plus className="w-4 h-4 text-success flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-foreground">
                    {t('install.toolsToAdd', { count: addedTools.length })}
                  </p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {addedTools.map((name) => (
                      <span
                        key={name}
                        className="inline-flex items-center px-2 py-0.5 rounded-md text-xs bg-success/10 text-success border border-success/20"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Tools to modify */}
            {modifiedTools.length > 0 && (
              <div className="flex items-start gap-2">
                <Pencil className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-foreground">
                    {t('install.toolsToModify', { count: modifiedTools.length })}
                  </p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {modifiedTools.map((name) => (
                      <span
                        key={name}
                        className="inline-flex items-center px-2 py-0.5 rounded-md text-xs bg-warning/10 text-warning border border-warning/20"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* No changes */}
            {addedAgents.length === 0 &&
              modifiedAgents.length === 0 &&
              addedTools.length === 0 &&
              modifiedTools.length === 0 && (
                <p className="text-sm text-muted">{t('install.noChanges')}</p>
              )}
          </div>

          {/* Issues / warnings */}
          {issues.length > 0 && (
            <div className="space-y-2">
              {issues.map((issue) => (
                <div
                  key={issue.id}
                  className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2"
                >
                  <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-foreground">{issue.message}</p>
                </div>
              ))}
            </div>
          )}

          {/* Blocking issues notice */}
          {hasBlockingIssues && (
            <div className="flex items-center gap-2 rounded-lg border border-error/30 bg-error/5 px-3 py-2">
              <AlertCircle className="w-4 h-4 text-error flex-shrink-0" />
              <p className="text-xs text-error font-medium">{t('install.blockingIssues')}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" size="sm" onClick={handleClose}>
              {t('install.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleConfirm}
              disabled={hasBlockingIssues}
            >
              {t('install.confirm')}
            </Button>
          </div>
        </div>
      )}

      {/* Applying */}
      {phase === 'applying' && (
        <div className="flex flex-col items-center justify-center py-8 gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-accent border-t-transparent animate-spin" />
          <p className="text-sm text-muted">{t('install.applying')}</p>
        </div>
      )}

      {/* Success */}
      {phase === 'success' && installResult && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-success">
            <CheckCircle2 className="w-5 h-5" />
            <p className="text-sm font-medium">{t('install.installComplete')}</p>
          </div>

          <PostInstallChecklist
            provisioningRequired={installResult.provisioningRequired}
            applied={installResult.applied}
            entryAgentName={installResult.entryAgentName}
          />

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                handleClose();
                onInstallComplete();
              }}
            >
              {t('install.done')}
            </Button>
          </div>
        </div>
      )}

      {/* Error */}
      {phase === 'error' && (
        <div className="space-y-4">
          <div className="flex items-start gap-2 text-error">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium">{t('install.installFailed')}</p>
              <p className="text-xs text-muted mt-1">
                {agentPreviewError ?? installError ?? t('install.installFailedDescription')}
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" size="sm" onClick={handleClose}>
              {t('install.cancel')}
            </Button>
            <Button variant="primary" size="sm" onClick={handleRetry}>
              {t('install.retry')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
