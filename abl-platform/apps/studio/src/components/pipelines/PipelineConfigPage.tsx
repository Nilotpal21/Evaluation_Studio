/**
 * PipelineConfigPage Component
 *
 * Builtin pipeline detail/config page. When a user clicks a builtin pipeline
 * card (e.g., "Sentiment Analysis"), this page lets them:
 * - Enable/disable the pipeline
 * - Configure parameters via a dynamic form (ConfigSchemaForm)
 * - Manage triggers (TriggerManager)
 *
 * Follows the ToolDetailPage pattern: back button, save/discard, dirty tracking.
 *
 * Data fetching uses 3 SWR hooks:
 * 1. GET /api/projects/:pid/pipeline-config/:type  — config values + enabled state
 * 2. GET /api/projects/:pid/pipeline-config/:type/schema — config field definitions
 * 3. GET /api/projects/:pid/pipeline-config/:type/triggers — trigger states
 */

'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Loader2, TestTube2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Toggle } from '../ui/Toggle';
import { Tabs } from '../ui/Tabs';
import { ErrorAlert } from '../ui/ErrorAlert';
import { ConfigSchemaForm } from './ConfigSchemaForm';
import { TriggerManager } from './TriggerManager';
import { RecentRunsPanel } from './runs/RecentRunsPanel';
import { PipelineTestDrawer } from './PipelineTestDrawer';

import { swrFetcher } from '../../lib/swr-config';
import { apiFetch, handleResponse } from '../../lib/api-client';
import { sanitizeErrors } from '../../lib/sanitize-error';
import { useNavigationStore } from '../../store/navigation-store';
import { useProjectStore } from '../../store/project-store';
import { useRunsStore } from '../../store/pipeline-runs-store';

import type { ConfigField, TriggerEntry } from '@agent-platform/pipeline-engine';

// =============================================================================
// TYPES
// =============================================================================

interface PipelineConfigResponse {
  success: boolean;
  data: {
    pipelineType: string;
    version: number;
    enabled: boolean;
    config: Record<string, unknown>;
    projectId?: string;
    lastProcessedAt?: string | null;
    backfillStatus?: string;
    activeTriggers?: string[];
    triggerConfigs?: Record<string, { samplingRate?: number }>;
  } | null;
}

interface PipelineSchemaResponse {
  success: boolean;
  data: {
    fields: ConfigField[];
    sharedFields: ConfigField[];
  };
}

interface PipelineTriggersResponse {
  success: boolean;
  data: {
    triggers: (TriggerEntry & {
      active: boolean;
      samplingRate: number;
      executionMode: string;
    })[];
    defaultTriggerIds: string[];
  };
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Converts a pipeline_type slug to a human-readable name.
 * e.g., "sentiment_analysis" -> "Sentiment Analysis"
 */
function humanizePipelineType(pipelineType: string): string {
  return pipelineType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function cloneTriggerConfigs(
  triggerConfigs: Record<string, { samplingRate?: number }> | undefined,
): Record<string, { samplingRate?: number }> {
  if (!triggerConfigs) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(triggerConfigs).map(([triggerId, config]) => [triggerId, { ...(config ?? {}) }]),
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function PipelineConfigPage() {
  const t = useTranslations('pipelines');
  const navigate = useNavigationStore((s) => s.navigate);
  const pipelineType = useNavigationStore((s) => s.subPage);
  const projectId = useProjectStore((s) => s.currentProject?.id);
  const openRun = useRunsStore((s) => s.openRun);

  // ── Local state ────────────────────────────────────────────────────────────
  const [draftConfig, setDraftConfig] = useState<Record<string, unknown>>({});
  const [draftActiveTriggers, setDraftActiveTriggers] = useState<string[]>([]);
  const [draftTriggerConfigs, setDraftTriggerConfigs] = useState<
    Record<string, { samplingRate?: number }>
  >({});
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | string[] | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [activeTab, setActiveTab] = useState('config');
  const [isTestOpen, setIsTestOpen] = useState(false);

  const configTabs = useMemo(
    () => [
      { id: 'config', label: t('tab_config') },
      { id: 'runs', label: t('tab_runs') },
    ],
    [t],
  );

  // ── SWR Hooks ──────────────────────────────────────────────────────────────

  const configKey =
    projectId && pipelineType ? `/api/projects/${projectId}/pipeline-config/${pipelineType}` : null;

  const schemaKey =
    projectId && pipelineType
      ? `/api/projects/${projectId}/pipeline-config/${pipelineType}/schema`
      : null;

  const triggersKey =
    projectId && pipelineType
      ? `/api/projects/${projectId}/pipeline-config/${pipelineType}/triggers`
      : null;

  const {
    data: configData,
    error: configError,
    isLoading: configLoading,
    mutate: mutateConfig,
  } = useSWR<PipelineConfigResponse>(configKey, swrFetcher);

  const { data: schemaData, isLoading: schemaLoading } = useSWR<PipelineSchemaResponse>(
    schemaKey,
    swrFetcher,
  );

  const {
    data: triggersData,
    isLoading: triggersLoading,
    mutate: mutateTriggers,
  } = useSWR<PipelineTriggersResponse>(triggersKey, swrFetcher);

  // ── Derived Data ───────────────────────────────────────────────────────────

  const configRecord = configData?.data;
  const enabled = configRecord?.enabled ?? false;
  const savedConfig = configRecord?.config ?? {};
  const savedActiveTriggers = configRecord?.activeTriggers ?? [];
  const savedTriggerConfigs = configRecord?.triggerConfigs ?? {};

  const allFields = useMemo(() => {
    const schema = schemaData?.data;
    if (!schema) return [];
    return [...(schema.fields ?? []), ...(schema.sharedFields ?? [])];
  }, [schemaData]);

  const triggerEntries: TriggerEntry[] = useMemo(() => {
    return (triggersData?.data?.triggers ?? []).map((trig) => ({
      id: trig.id,
      type: trig.type,
      kafkaTopic: trig.kafkaTopic,
      eventFilter: trig.eventFilter,
      schedule: trig.schedule,
      strategy: trig.strategy,
      label: trig.label,
      description: trig.description,
      inputSchema: trig.inputSchema,
    }));
  }, [triggersData]);

  const testTriggers = useMemo(
    () =>
      (triggersData?.data?.triggers ?? []).map((trigger) => ({
        id: trigger.id,
        type: trigger.type,
        kafkaTopic: trigger.kafkaTopic,
        eventFilter: trigger.eventFilter,
        schedule: trigger.schedule,
        strategy: trigger.strategy,
        label: trigger.label,
        description: trigger.description,
        inputSchema: trigger.inputSchema,
        active: trigger.active,
      })),
    [triggersData],
  );

  const pipelineName = humanizePipelineType(pipelineType ?? '');
  const isLoading = configLoading || schemaLoading || triggersLoading;

  // ── Initialize Draft State from Server ─────────────────────────────────────

  useEffect(() => {
    if (!configLoading && configData && !initialized) {
      setDraftConfig(savedConfig);
      setInitialized(true);
    }
  }, [configLoading, configData, savedConfig, initialized]);

  useEffect(() => {
    if (!triggersLoading && triggersData) {
      const serverActiveTriggers = (triggersData.data?.triggers ?? [])
        .filter((trig) => trig.active)
        .map((trig) => trig.id);
      setDraftActiveTriggers(serverActiveTriggers);
      setDraftTriggerConfigs(cloneTriggerConfigs(savedTriggerConfigs));
    }
  }, [triggersLoading, triggersData, savedTriggerConfigs]);

  // ── Dirty Tracking ─────────────────────────────────────────────────────────

  const isDirty = useMemo(() => {
    const configDirty = JSON.stringify(draftConfig) !== JSON.stringify(savedConfig);
    const triggersDirty =
      JSON.stringify(draftActiveTriggers) !== JSON.stringify(savedActiveTriggers);
    const triggerConfigsDirty =
      JSON.stringify(draftTriggerConfigs) !== JSON.stringify(savedTriggerConfigs);
    return configDirty || triggersDirty || triggerConfigsDirty;
  }, [
    draftConfig,
    savedConfig,
    draftActiveTriggers,
    savedActiveTriggers,
    draftTriggerConfigs,
    savedTriggerConfigs,
  ]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  const handleConfigChange = useCallback((key: string, value: unknown) => {
    setDraftConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleToggleTrigger = useCallback((triggerId: string, active: boolean) => {
    setDraftActiveTriggers((prev) =>
      active ? [...prev, triggerId] : prev.filter((id) => id !== triggerId),
    );
  }, []);

  const handleSamplingRateChange = useCallback((triggerId: string, rate: number) => {
    setDraftTriggerConfigs((prev) => ({
      ...prev,
      [triggerId]: { ...prev[triggerId], samplingRate: rate },
    }));
  }, []);

  const handleSave = async () => {
    if (!projectId || !pipelineType) return;
    setSaving(true);
    setError(null);
    try {
      const url = `/api/projects/${projectId}/pipeline-config/${pipelineType}`;
      const response = await apiFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: draftConfig,
          activeTriggers: draftActiveTriggers,
          triggerConfigs: draftTriggerConfigs,
        }),
      });
      await handleResponse(response);
      const freshData = await mutateConfig();
      if (freshData?.data?.config) {
        setDraftConfig(freshData.data.config as Record<string, unknown>);
      }
      await mutateTriggers();
      toast.success(t('config_saved'));
    } catch (err) {
      setError(sanitizeErrors(err, 'Failed to save configuration'));
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setDraftConfig(savedConfig);
    setDraftActiveTriggers(savedActiveTriggers);
    setDraftTriggerConfigs(cloneTriggerConfigs(savedTriggerConfigs));
    setError(null);
  };

  const handleToggleEnabled = async () => {
    if (!projectId || !pipelineType) return;
    setToggling(true);
    setError(null);
    try {
      const url = `/api/projects/${projectId}/pipeline-config/${pipelineType}/toggle`;
      const response = await apiFetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });
      await handleResponse(response);
      await mutateConfig();
    } catch (err) {
      setError(sanitizeErrors(err, 'Failed to toggle pipeline'));
    } finally {
      setToggling(false);
    }
  };

  const handleBack = () => {
    if (projectId) {
      navigate(`/projects/${projectId}/pipelines`);
    }
  };

  // ── Loading ────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 text-muted animate-spin" />
      </div>
    );
  }

  // ── Error state (no data at all) ───────────────────────────────────────────

  if (configError && !configData) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-sm text-muted">Failed to load pipeline configuration</p>
          <Button variant="secondary" className="mt-4" onClick={handleBack}>
            {t('back_to_list')}
          </Button>
        </div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {/* Header */}
        <div className="mb-6">
          <button
            onClick={handleBack}
            className="flex items-center gap-1 text-sm text-muted hover:text-foreground transition-default mb-4"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('back_to_list')}
          </button>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              {/* Title row: pipeline name + builtin badge + enable/disable toggle */}
              <div className="flex items-center gap-2.5">
                <h1 className="text-2xl font-semibold text-foreground tracking-tight truncate">
                  {pipelineName}
                </h1>
                <Badge variant="accent">{t('config_builtin_badge')}</Badge>
              </div>

              {/* Enable/disable toggle */}
              <div className="mt-3">
                <Toggle
                  checked={enabled}
                  onChange={handleToggleEnabled}
                  label={enabled ? t('config_disable') : t('config_enable')}
                  disabled={toggling}
                />
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="secondary"
                size="sm"
                icon={<TestTube2 className="w-4 h-4" />}
                onClick={() => setIsTestOpen(true)}
                disabled={!projectId || !pipelineType || isDirty || testTriggers.length === 0}
              >
                {t('test.test_button')}
              </Button>

              {/* Save / Discard buttons — only shown on config tab */}
              {activeTab === 'config' && (
                <>
                  <AnimatePresence mode="wait">
                    {isDirty && (
                      <motion.div
                        key="discard-action"
                        initial={{ opacity: 0, x: 12 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 12 }}
                        transition={{ duration: 0.15 }}
                      >
                        <Button variant="ghost" size="sm" onClick={handleDiscard} disabled={saving}>
                          {t('config_discard')}
                        </Button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleSave}
                    loading={saving}
                    disabled={!isDirty}
                  >
                    {t('config_save')}
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>

        {error && <ErrorAlert error={error} onDismiss={() => setError(null)} className="mb-4" />}

        {/* Tab switcher */}
        <div className="mb-6">
          <Tabs
            tabs={configTabs}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            layoutId="pipeline-config-tabs"
          />
        </div>

        {/* Config tab content */}
        {activeTab === 'config' && (
          <div className="space-y-6">
            {/* Configuration Section */}
            <section className="rounded-lg border border-default bg-background-elevated p-5 sm:p-6">
              <h2 className="text-base font-semibold text-foreground mb-4">
                {t('config_section_parameters')}
              </h2>
              <ConfigSchemaForm
                fields={allFields}
                values={draftConfig}
                onChange={handleConfigChange}
                disabled={saving}
              />
            </section>

            {/* Triggers Section */}
            {triggerEntries.length > 0 && (
              <section className="rounded-lg border border-default bg-background-elevated p-5 sm:p-6">
                <h2 className="text-base font-semibold text-foreground mb-4">
                  {t('config_section_triggers')}
                </h2>
                <TriggerManager
                  triggers={triggerEntries}
                  activeTriggerIds={draftActiveTriggers}
                  triggerConfigs={draftTriggerConfigs}
                  onToggleTrigger={handleToggleTrigger}
                  onSamplingRateChange={handleSamplingRateChange}
                  disabled={saving}
                />
              </section>
            )}
          </div>
        )}

        {/* Runs tab content */}
        {activeTab === 'runs' && projectId && pipelineType && (
          <RecentRunsPanel projectId={projectId} pipelineIdOverride={pipelineType} />
        )}
      </div>

      {projectId && pipelineType && (
        <PipelineTestDrawer
          open={isTestOpen}
          onClose={() => setIsTestOpen(false)}
          projectId={projectId}
          pipelineId={pipelineType}
          triggers={testTriggers}
          onRunCreated={(runId) => {
            setActiveTab('runs');
            openRun(runId);
          }}
        />
      )}
    </div>
  );
}
