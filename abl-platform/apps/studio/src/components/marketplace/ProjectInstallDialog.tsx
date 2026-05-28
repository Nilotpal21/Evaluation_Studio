'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { PostInstallChecklist } from './PostInstallChecklist';
import {
  useMarketplaceStore,
  selectInstallLoading,
  selectInstallError,
  selectInstallResult,
} from '@/store/marketplace-store';
import type { MarketplaceTemplate, MarketplaceTemplateVersion } from '@/store/marketplace-store';

interface ProjectInstallDialogProps {
  open: boolean;
  onClose: () => void;
  template: MarketplaceTemplate;
  version: MarketplaceTemplateVersion;
  onInstallComplete: (projectId: string) => void;
}

type DialogState = 'idle' | 'loading' | 'success' | 'error';

export function ProjectInstallDialog({
  open,
  onClose,
  template,
  version,
  onInstallComplete,
}: ProjectInstallDialogProps) {
  const t = useTranslations('marketplace');

  const installLoading = useMarketplaceStore(selectInstallLoading);
  const installError = useMarketplaceStore(selectInstallError);
  const installResult = useMarketplaceStore(selectInstallResult);
  const installProjectTemplate = useMarketplaceStore((s) => s.installProjectTemplate);
  const resetInstallState = useMarketplaceStore((s) => s.resetInstallState);

  const [projectName, setProjectName] = useState(template.name);
  const [nameError, setNameError] = useState<string | null>(null);

  const dialogState: DialogState = installLoading
    ? 'loading'
    : installResult?.project
      ? 'success'
      : installError
        ? 'error'
        : 'idle';

  const handleSubmit = useCallback(async () => {
    const trimmed = projectName.trim();
    if (!trimmed) {
      setNameError(t('install.projectName'));
      return;
    }
    setNameError(null);
    await installProjectTemplate({
      templateSlug: template.slug,
      version: version.version,
      projectName: trimmed,
    });
  }, [projectName, template.slug, version.version, installProjectTemplate, t]);

  const handleClose = useCallback(() => {
    resetInstallState();
    setProjectName(template.name);
    setNameError(null);
    onClose();
  }, [resetInstallState, template.name, onClose]);

  const handleGoToProject = useCallback(() => {
    if (installResult?.project) {
      onInstallComplete(installResult.project.id);
    }
  }, [installResult, onInstallComplete]);

  return (
    <Dialog open={open} onClose={handleClose} title={t('install.createProject')} maxWidth="md">
      {dialogState === 'idle' && (
        <div className="space-y-4">
          <Input
            label={t('install.projectName')}
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder={t('install.projectNamePlaceholder')}
            error={nameError ?? undefined}
            required
          />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" size="sm" onClick={handleClose}>
              {t('install.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSubmit}
              disabled={!projectName.trim()}
            >
              {t('install.createAndInstall')}
            </Button>
          </div>
        </div>
      )}

      {dialogState === 'loading' && (
        <div className="flex flex-col items-center justify-center py-8 gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-accent border-t-transparent animate-spin" />
          <p className="text-sm text-muted">{t('install.installing')}</p>
        </div>
      )}

      {dialogState === 'success' && installResult && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-success">
            <CheckCircle2 className="w-5 h-5" />
            <p className="text-sm font-medium">{t('install.installComplete')}</p>
          </div>

          {installResult.project && (
            <p className="text-sm text-muted">
              {t('install.projectCreated', { name: installResult.project.name })}
            </p>
          )}

          <PostInstallChecklist
            provisioningRequired={installResult.provisioningRequired}
            applied={installResult.applied}
            entryAgentName={installResult.entryAgentName}
          />

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" size="sm" onClick={handleClose}>
              {t('install.done')}
            </Button>
            <Button variant="primary" size="sm" onClick={handleGoToProject}>
              {t('install.goToProject')}
            </Button>
          </div>
        </div>
      )}

      {dialogState === 'error' && (
        <div className="space-y-4">
          <div className="flex items-start gap-2 text-error">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium">{t('install.installFailed')}</p>
              <p className="text-xs text-muted mt-1">
                {installError ?? t('install.installFailedDescription')}
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" size="sm" onClick={handleClose}>
              {t('install.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                resetInstallState();
              }}
            >
              {t('install.retry')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
