/**
 * ModuleSettingsPanel Component
 *
 * Toggle between Application and Module mode with visibility controls.
 * Disabled when module feature flag is off. Blocks kind downgrade when
 * consumer dependencies exist (409 from API). Shows consumer project count
 * with expandable ReverseDepPanel.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, AlertTriangle, Package, ChevronDown, ChevronRight, Users } from 'lucide-react';
import { clsx } from 'clsx';
import { toast } from 'sonner';

import { useFeatures } from '../../hooks/use-features';
import { useNavigationStore } from '../../store/navigation-store';
import {
  getModuleSettings,
  enableModule,
  listConsumers,
  type ModuleSettings,
} from '../../api/modules';
import { Toggle } from '../ui/Toggle';
import { Select } from '../ui/Select';
import { ReverseDepPanel } from './ReverseDepPanel';

const VISIBILITY_OPTIONS = [
  { value: 'private', label: 'Private' },
  { value: 'tenant', label: 'Tenant' },
];

export function ModuleSettingsPanel() {
  const t = useTranslations('modules.settings');
  const tErrors = useTranslations('modules.errors');
  const tConsumers = useTranslations('modules.consumers');
  const { projectId } = useNavigationStore();
  const { hasModules, isLoading: featuresLoading } = useFeatures();

  const [settings, setSettings] = useState<ModuleSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consumerCount, setConsumerCount] = useState<number | null>(null);
  const [consumersExpanded, setConsumersExpanded] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    setError(null);
    try {
      const result = await getModuleSettings(projectId);
      setSettings(result.data);

      // Load consumer count if module is enabled
      if (result.data.enabled) {
        try {
          const consumersResult = await listConsumers(projectId);
          setConsumerCount(consumersResult.summary.totalConsumers);
        } catch {
          // Consumer count is non-critical — fail silently
          setConsumerCount(null);
        }
      } else {
        setConsumerCount(null);
      }
    } catch {
      setSettings(null);
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleToggle = async (enabled: boolean) => {
    if (!projectId) return;
    setIsSaving(true);
    setError(null);
    try {
      const params: { enabled: boolean; moduleVisibility?: 'tenant' | 'private' } = { enabled };
      if (enabled) {
        params.moduleVisibility = (settings?.moduleVisibility as 'tenant' | 'private') ?? 'private';
      }
      await enableModule(projectId, params);
      await load();
      toast.success(enabled ? t('enableModule') : t('disableModule'));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Check for 409 consumer dependency block
      const isConflict =
        (err instanceof Error && 'statusCode' in err
          ? (err as unknown as { statusCode?: number }).statusCode
          : undefined) === 409 || message.toLowerCase().includes('consumer');
      if (isConflict) {
        setError(tErrors('kindDowngradeBlocked'));
      } else {
        toast.error(message);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleVisibilityChange = async (visibility: string) => {
    if (!projectId || !settings?.enabled) return;
    setIsSaving(true);
    try {
      await enableModule(projectId, {
        enabled: true,
        moduleVisibility: visibility as 'tenant' | 'private',
      });
      await load();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading || featuresLoading) {
    return (
      <div className="rounded-lg border border-default bg-background-muted p-5">
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-5 h-5 animate-spin text-muted" />
        </div>
      </div>
    );
  }

  const isEnabled = settings?.enabled ?? false;
  const isDisabled = !hasModules;

  return (
    <div className="rounded-lg border border-default bg-background-muted p-5 space-y-4">
      <div className="flex items-center gap-3">
        <div className="p-1.5 rounded-md bg-accent-subtle">
          <Package className="w-4 h-4 text-accent" />
        </div>
        <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
      </div>

      {isDisabled && <p className="text-xs text-muted">{t('featureDisabled')}</p>}

      <Toggle
        checked={isEnabled}
        onChange={handleToggle}
        label={isEnabled ? t('disableModule') : t('enableModule')}
        disabled={isDisabled || isSaving}
      />

      {error && (
        <div className="flex items-start gap-2 rounded-md bg-error-subtle/10 border border-error/30 px-3 py-2">
          <AlertTriangle className="w-4 h-4 text-error shrink-0 mt-0.5" />
          <p className="text-sm text-error">{error}</p>
        </div>
      )}

      {isEnabled && (
        <div
          className={clsx(
            'border-t border-default pt-4',
            isDisabled && 'opacity-50 pointer-events-none',
          )}
        >
          <Select
            label={t('visibility')}
            options={VISIBILITY_OPTIONS.map((opt) => ({
              ...opt,
              label: opt.value === 'private' ? t('visibilityPrivate') : t('visibilityTenant'),
            }))}
            value={settings?.moduleVisibility ?? 'private'}
            onChange={handleVisibilityChange}
            disabled={isSaving}
          />
        </div>
      )}

      {/* Consumer projects section */}
      {isEnabled && consumerCount !== null && consumerCount > 0 && projectId && (
        <div className="border-t border-default pt-4">
          <button
            type="button"
            onClick={() => setConsumersExpanded(!consumersExpanded)}
            className="flex items-center gap-2 w-full text-left text-sm text-muted hover:text-foreground transition-default"
          >
            {consumersExpanded ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
            <Users className="w-3.5 h-3.5" />
            <span>{tConsumers('consumerCount', { count: consumerCount })}</span>
          </button>

          {consumersExpanded && (
            <div className="mt-3">
              <ReverseDepPanel projectId={projectId} />
            </div>
          )}
        </div>
      )}

      {isSaving && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span>{t('saving')}</span>
        </div>
      )}
    </div>
  );
}
