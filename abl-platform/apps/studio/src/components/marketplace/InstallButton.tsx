'use client';

import { useTranslations } from 'next-intl';
import { FolderPlus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { MarketplaceTemplate, MarketplaceTemplateVersion } from '@/store/marketplace-store';

interface InstallButtonProps {
  template: MarketplaceTemplate;
  version: MarketplaceTemplateVersion | null;
  onProjectInstall: () => void;
  onAgentInstall: () => void;
}

export function InstallButton({
  template,
  version,
  onProjectInstall,
  onAgentInstall,
}: InstallButtonProps) {
  const t = useTranslations('marketplace');

  const isProject = template.type === 'project';
  const disabled = version === null;

  return (
    <div className="space-y-2">
      <Button
        variant="primary"
        size="md"
        className="w-full"
        disabled={disabled}
        icon={isProject ? <FolderPlus className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
        onClick={isProject ? onProjectInstall : onAgentInstall}
      >
        {isProject ? t('install.createProject') : t('install.addToProject')}
      </Button>
      {disabled && (
        <p className="text-xs text-muted text-center">{t('install.noVersionAvailable')}</p>
      )}
    </div>
  );
}
