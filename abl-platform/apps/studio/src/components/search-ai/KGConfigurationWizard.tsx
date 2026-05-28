/**
 * KGConfigurationWizard Component
 *
 * Smart wizard that checks workspace context before showing model selection.
 * Three modes:
 * 1. Workspace Inheritance (when sibling indexes have KG configured)
 * 2. Tenant Model Selection (when tenant has models but no workspace config)
 * 3. Configuration Guide (when no models configured)
 */

'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import {
  useKGConfigurationStatus,
  useKGConfigureModel,
  type KGConfigurationStatus,
} from '../../hooks/useKnowledgeGraph';
import { KGWorkspaceInheritanceCard } from './KGWorkspaceInheritanceCard';
import { KGModelSelectionCard } from './KGModelSelectionCard';
import { KGConfigureModelsCard } from './KGConfigureModelsCard';

interface KGConfigurationWizardProps {
  indexId: string;
  onComplete: () => void;
}

type WizardMode = 'workspace' | 'tenant' | 'none' | 'loading';

export function KGConfigurationWizard({ indexId, onComplete }: KGConfigurationWizardProps) {
  const t = useTranslations('knowledgeGraph');
  const { status, isLoading, error, refresh } = useKGConfigurationStatus(indexId);
  const { configureModel, isConfiguring } = useKGConfigureModel(indexId);
  const [mode, setMode] = useState<WizardMode>('loading');

  // Update mode based on configuration status
  useEffect(() => {
    if (isLoading) {
      setMode('loading');
      return;
    }

    if (error) {
      toast.error(
        t('config_status_error', { defaultValue: 'Failed to check configuration status' }),
      );
      return;
    }

    if (status) {
      setMode(status.configurationLevel);
    }
  }, [status, isLoading, error, t]);

  // Handle model configuration from workspace inheritance
  const handleInherit = async (modelId: string, inheritedFrom: string) => {
    try {
      await configureModel({ modelId, inheritedFrom });
      toast.success(
        t('model_configured_success', { defaultValue: 'Model configured successfully' }),
      );
      // Refresh configuration status and notify parent
      setTimeout(() => {
        refresh();
        onComplete();
      }, 500);
    } catch (err) {
      toast.error(
        t('model_config_failed', {
          defaultValue: err instanceof Error ? err.message : 'Failed to configure model',
        }),
      );
    }
  };

  // Handle model selection from tenant models
  const handleSelectModel = async (modelId: string) => {
    try {
      await configureModel({ modelId });
      toast.success(
        t('model_configured_success', { defaultValue: 'Model configured successfully' }),
      );
      // Refresh configuration status and notify parent
      setTimeout(() => {
        refresh();
        onComplete();
      }, 500);
    } catch (err) {
      toast.error(
        t('model_config_failed', {
          defaultValue: err instanceof Error ? err.message : 'Failed to configure model',
        }),
      );
    }
  };

  // Handle "choose different" from workspace inheritance
  const handleChooseDifferent = () => {
    setMode('tenant');
  };

  // Loading state
  if (mode === 'loading') {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 text-accent animate-spin" />
          <p className="text-sm text-muted">
            {t('checking_configuration', { defaultValue: 'Checking configuration...' })}
          </p>
        </div>
      </div>
    );
  }

  // Mode 1: Workspace Inheritance
  if (mode === 'workspace' && status?.workspace.hasKGConfigured) {
    return (
      <KGWorkspaceInheritanceCard
        configuredIndexes={status.workspace.configuredIndexes}
        recommendation={status.workspace.recommendation!}
        onInherit={handleInherit}
        onChooseDifferent={handleChooseDifferent}
        isConfiguring={isConfiguring}
      />
    );
  }

  // Mode 2: Tenant Model Selection
  if (mode === 'tenant' && status?.tenant && status.tenant.models.length > 0) {
    return (
      <KGModelSelectionCard
        models={status.tenant.models}
        recommendation={status.tenant.recommendation}
        onSelect={handleSelectModel}
        isConfiguring={isConfiguring}
      />
    );
  }

  // Mode 3: Configuration Guide (no models configured)
  if (mode === 'none' || status?.requiresConfiguration) {
    return <KGConfigureModelsCard />;
  }

  // Fallback: show configuration guide if status is unclear
  return <KGConfigureModelsCard />;
}
