/**
 * RuntimeConfigTab Component
 *
 * Project runtime configuration: extraction strategy, multi-intent handling,
 * inference settings, currency conversion, lookup tables, and reasoning pipeline.
 * Proxies to Runtime API at /api/projects/:projectId/runtime-config.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  Settings,
  Loader2,
  Check,
  RotateCcw,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Library,
  Copy,
  X,
} from 'lucide-react';
import {
  CLONABLE_FILLER_PROMPT_TEMPLATE,
  CLONABLE_FILLER_PROMPT_VARIABLES,
} from '@agent-platform/shared/prompts/builtin-runtime';
import { clsx } from 'clsx';
import { Toggle } from '../ui/Toggle';
import { useNavigationStore } from '../../store/navigation-store';
import { apiFetch } from '../../lib/api-client';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { EmptyState } from '../ui/EmptyState';
import { Select } from '../ui/Select';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import { PromptPickerModal, type PickerSelection } from '../prompt-library/PromptPickerModal';
import { useProjectModelOptions } from '../../hooks/useProjectModelOptions';
import { createPrompt } from '../../api/prompt-library';
import { formatModelOptionLabel } from '../../lib/model-display';

// =============================================================================
// Types
// =============================================================================

interface ExtractionConfig {
  strategy: string;
  correction_detection: string;
  sidecar_timeout_ms: number;
  sidecar_circuit_breaker_threshold: number;
  nlu_provider?: string;
  advanced_sidecar_url?: string;
  advanced_sidecar_timeout_ms?: number;
  advanced_sidecar_circuit_breaker_threshold?: number;
}

interface MultiIntentConfig {
  enabled: boolean;
  strategy: string;
  max_intents: number;
  confidence_threshold: number;
  queue_max_age_ms: number;
}

interface InferenceConfig {
  confidence: number;
  confirm: boolean;
  model_tier: string;
  max_fields_per_pass: number;
}

interface ConversionConfig {
  currency_mode: string;
  currency_api_url?: string;
}

interface LookupTableEntry {
  name: string;
  source: 'inline' | 'collection' | 'api';
  values?: string[];
  endpoint?: string;
  table_name?: string;
  field?: string;
  timeout_ms?: number;
  headers?: Record<string, string>;
  case_sensitive: boolean;
  fuzzy_match: boolean;
  fuzzy_threshold: number;
}

interface PipelineIntentBridgeConfig {
  enabled: boolean;
  programmaticThreshold: number;
  guidedThreshold: number;
  outOfScopeDecline: boolean;
  multiIntentSignal: boolean;
}

type RuntimeModelSource = 'system' | 'project' | 'tenant' | 'default';

interface PromptOverrideRef {
  promptId: string;
  versionId: string;
  promptName?: string;
  versionNumber?: number;
}

interface PipelineConfig {
  enabled: boolean;
  mode: 'parallel' | 'sequential';
  modelSource: 'default' | 'tenant';
  tenantModelId?: string;
  shortCircuit: { enabled: boolean; confidenceThreshold: number };
  toolFilter: { enabled: boolean; maxTools: number };
  keywordVeto: { enabled: boolean; keywords: string[] };
  intentBridge: PipelineIntentBridgeConfig;
}

interface PIIRedactionConfig {
  enabled: boolean;
  redact_input: boolean;
  redact_output: boolean;
}

interface FillerConfig {
  enabled: boolean;
  chatEnabled: boolean;
  voiceEnabled: boolean;
  chatDelayMs: number;
  voiceDelayMs: number;
  cooldownMs: number;
  maxPerTurn: number;
  piggybackEnabled: boolean;
  pipelineGenerationEnabled: boolean;
  modelSource: RuntimeModelSource;
  modelId?: string;
  tenantModelId?: string;
  promptRef?: PromptOverrideRef;
}

interface RuntimeConfig {
  extraction: ExtractionConfig;
  multi_intent: MultiIntentConfig;
  inference: InferenceConfig;
  conversion: ConversionConfig;
  lookup_tables: LookupTableEntry[];
  pipeline?: PipelineConfig;
  filler?: FillerConfig;
  pii_redaction: PIIRedactionConfig;
}

interface TenantModelOption {
  id: string;
  displayName: string;
  modelId: string;
  provider: string;
}

// =============================================================================
// Constants
// =============================================================================

const EXTRACTION_STRATEGIES = ['auto', 'ml', 'llm', 'hybrid', 'pattern'];
const NLU_PROVIDERS = ['standard', 'advanced'];
const CORRECTION_METHODS = ['auto', 'ml', 'regex', 'sidecar', 'llm', 'disabled'];
const MULTI_INTENT_STRATEGIES = ['primary_queue', 'sequential', 'parallel', 'disambiguate', 'auto'];
const MODEL_TIERS = ['fast', 'balanced', 'powerful'];
const CURRENCY_MODES = ['static', 'live'];
const LOOKUP_SOURCES = ['inline', 'collection', 'api'];

const PIPELINE_MODES = ['parallel', 'sequential'];

const STRATEGY_BADGE: Record<string, 'info' | 'success' | 'warning'> = {
  auto: 'info',
  ml: 'success',
  llm: 'warning',
  hybrid: 'warning',
  pattern: 'info',
};

// =============================================================================
// Helper: Collapsible Section
// =============================================================================

function ConfigSection({
  title,
  description,
  children,
  defaultOpen = true,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="border border-default rounded-lg overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-4 bg-background-subtle hover:bg-background-muted transition-default text-left"
      >
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="text-xs text-muted mt-0.5">{description}</p>
        </div>
        {isOpen ? (
          <ChevronDown className="w-4 h-4 text-muted flex-shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted flex-shrink-0" />
        )}
      </button>
      {isOpen && <div className="p-4 space-y-4 border-t border-default">{children}</div>}
    </div>
  );
}

// =============================================================================
// Helper: Form Field
// =============================================================================

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[200px_1fr] gap-4 items-start">
      <div>
        <label className="text-sm font-medium text-foreground">{label}</label>
        {description && <p className="text-xs text-muted mt-0.5">{description}</p>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function SelectField({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <div className="max-w-xs">
      <Select
        value={value}
        onChange={onChange}
        options={options.map((opt) => ({ value: opt, label: opt }))}
      />
    </div>
  );
}

function NumberField({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      min={min}
      max={max}
      step={step}
      className="w-full max-w-xs rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus/50"
    />
  );
}

function PromptOverrideControl({
  value,
  onPick,
  onClear,
  onCloneBuiltIn,
  cloningBuiltIn,
}: {
  value?: PromptOverrideRef;
  onPick: () => void;
  onClear: () => void;
  onCloneBuiltIn: () => void;
  cloningBuiltIn: boolean;
}) {
  const label = value
    ? `${value.promptName ?? value.promptId}${value.versionNumber ? ` · v${value.versionNumber}` : ''}`
    : 'Built-in filler prompt';
  const actionLabel = value ? 'Change prompt' : 'Choose prompt override';

  return (
    <div className="max-w-xl space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 basis-56 rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground">
          <span className="block truncate">{label}</span>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onPick}
          icon={<Library className="h-3.5 w-3.5" />}
        >
          {actionLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCloneBuiltIn}
          loading={cloningBuiltIn}
          icon={<Copy className="h-3.5 w-3.5" />}
          className="whitespace-nowrap"
        >
          Clone built-in
        </Button>
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClear}
            icon={<X className="h-3.5 w-3.5" />}
          >
            Clear
          </Button>
        )}
      </div>
      {!value && (
        <p className="text-xs text-muted">
          Select a prompt-library version to override the built-in filler prompt.
        </p>
      )}
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function RuntimeConfigTab() {
  const t = useTranslations('settings.runtime_config');
  const tCommon = useTranslations('common');
  const { projectId } = useNavigationStore();

  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [tenantModels, setTenantModels] = useState<TenantModelOption[]>([]);
  const [promptPickerTarget, setPromptPickerTarget] = useState<'filler' | null>(null);
  const [isCloningBuiltInFillerPrompt, setIsCloningBuiltInFillerPrompt] = useState(false);
  const { allOptions: projectModelOptions } = useProjectModelOptions(projectId);

  useEffect(() => {
    let cancelled = false;
    async function loadTenantModels() {
      try {
        const res = await apiFetch('/api/tenant-models');
        const data = await res.json();
        if (!cancelled) {
          setTenantModels(
            (data.models || [])
              .filter((m: any) => m.isActive !== false)
              .map((m: any) => ({
                id: m.id,
                displayName: m.displayName,
                modelId: m.modelId,
                provider: m.provider,
              })),
          );
        }
      } catch {
        // Silent — dropdown will just show "Default"
      }
    }
    loadTenantModels();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Load ---
  const load = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/runtime-config`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setConfig(data.data ?? data.config ?? data);
      setIsDirty(false);
    } catch (err) {
      toast.error(sanitizeError(err, t('load_failed')));
    } finally {
      setIsLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    load();
  }, [load]);

  // --- Save ---
  const handleSave = async () => {
    if (!projectId || !config) return;
    setIsSaving(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/runtime-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          extraction: config.extraction,
          multi_intent: config.multi_intent,
          inference: config.inference,
          conversion: config.conversion,
          lookup_tables: config.lookup_tables,
          pipeline: config.pipeline,
          filler: config.filler,
          pii_redaction: config.pii_redaction,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setConfig(data.data ?? data.config ?? data);
      setIsDirty(false);
      toast.success(t('saved'));
    } catch (err) {
      toast.error(sanitizeError(err, t('save_failed')));
    } finally {
      setIsSaving(false);
    }
  };

  // --- Reset ---
  const handleReset = async () => {
    if (!projectId) return;
    setIsResetting(true);
    try {
      const res = await apiFetch(`/api/projects/${projectId}/runtime-config`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setConfig(data.data ?? data.config ?? data);
      setShowReset(false);
      setIsDirty(false);
      toast.success(t('reset_success'));
    } catch (err) {
      toast.error(sanitizeError(err, t('reset_failed')));
    } finally {
      setIsResetting(false);
    }
  };

  // --- Update helpers ---
  const updateExtraction = (key: keyof ExtractionConfig, value: unknown) => {
    if (!config) return;
    setConfig({ ...config, extraction: { ...config.extraction, [key]: value } });
    setIsDirty(true);
  };

  const updateMultiIntent = (key: keyof MultiIntentConfig, value: unknown) => {
    if (!config) return;
    setConfig({ ...config, multi_intent: { ...config.multi_intent, [key]: value } });
    setIsDirty(true);
  };

  const updateInference = (key: keyof InferenceConfig, value: unknown) => {
    if (!config) return;
    setConfig({ ...config, inference: { ...config.inference, [key]: value } });
    setIsDirty(true);
  };

  const updateConversion = (key: keyof ConversionConfig, value: unknown) => {
    if (!config) return;
    setConfig({ ...config, conversion: { ...config.conversion, [key]: value } });
    setIsDirty(true);
  };

  const defaultPipeline: PipelineConfig = {
    enabled: false,
    mode: 'parallel',
    modelSource: 'default',
    shortCircuit: { enabled: true, confidenceThreshold: 0.85 },
    toolFilter: { enabled: true, maxTools: 6 },
    keywordVeto: { enabled: true, keywords: [] },
    intentBridge: {
      enabled: true,
      programmaticThreshold: 0.85,
      guidedThreshold: 0.5,
      outOfScopeDecline: true,
      multiIntentSignal: true,
    },
  };

  const defaultFiller: FillerConfig = {
    enabled: true,
    chatEnabled: true,
    voiceEnabled: true,
    chatDelayMs: 1200,
    voiceDelayMs: 500,
    cooldownMs: 3000,
    maxPerTurn: 5,
    piggybackEnabled: true,
    pipelineGenerationEnabled: true,
    modelSource: 'system',
  };

  const updatePipeline = (key: keyof PipelineConfig, value: unknown) => {
    if (!config) return;
    const current = config.pipeline ?? defaultPipeline;
    setConfig({ ...config, pipeline: { ...current, [key]: value } });
    setIsDirty(true);
  };

  const handlePipelineModelChange = (value: string) => {
    if (!config) return;
    const current = config.pipeline ?? defaultPipeline;
    if (value === 'default') {
      setConfig({
        ...config,
        pipeline: { ...current, modelSource: 'default', tenantModelId: undefined },
      });
    } else {
      setConfig({
        ...config,
        pipeline: { ...current, modelSource: 'tenant', tenantModelId: value },
      });
    }
    setIsDirty(true);
  };

  const updateFiller = (key: keyof FillerConfig, value: unknown) => {
    if (!config) return;
    const current = config.filler ?? defaultFiller;
    setConfig({ ...config, filler: { ...current, [key]: value } });
    setIsDirty(true);
  };

  const handleFillerModelChange = (value: string) => {
    if (!config) return;
    const current = config.filler ?? defaultFiller;
    if (value === 'system') {
      setConfig({
        ...config,
        filler: {
          ...current,
          modelSource: 'system',
          modelId: undefined,
          tenantModelId: undefined,
        },
      });
    } else {
      setConfig({
        ...config,
        filler: {
          ...current,
          modelSource: 'project',
          modelId: value,
          tenantModelId: undefined,
        },
      });
    }
    setIsDirty(true);
  };

  const handlePromptSelection = (selection: PickerSelection) => {
    if (!config || !promptPickerTarget) return;
    const promptRef: PromptOverrideRef = {
      promptId: selection.promptId,
      versionId: selection.versionId,
      promptName: selection.promptName,
      versionNumber: selection.versionNumber,
    };

    const current = config.filler ?? defaultFiller;
    setConfig({ ...config, filler: { ...current, promptRef } });
    setPromptPickerTarget(null);
    setIsDirty(true);
  };

  const clearFillerPrompt = () => updateFiller('promptRef', undefined);

  const cloneBuiltInFillerPrompt = async () => {
    if (!projectId || isCloningBuiltInFillerPrompt) return;
    setIsCloningBuiltInFillerPrompt(true);
    try {
      const timestamp = new Date().toISOString().replace('T', ' ').replace('Z', ' UTC');
      const cloneSuffix =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID().slice(0, 8)
          : Date.now().toString(36);
      await createPrompt(projectId, {
        name: `Contextual filler prompt ${timestamp} ${cloneSuffix}`,
        description:
          'Draft cloned from the built-in runtime filler prompt. Edit it, then select it as the filler prompt override when ready.',
        tags: ['runtime', 'filler', 'built-in-clone'],
        initialVersion: {
          template: CLONABLE_FILLER_PROMPT_TEMPLATE,
          variables: [...CLONABLE_FILLER_PROMPT_VARIABLES],
          description: 'Cloned from built-in runtime filler prompt',
        },
      });
      toast.success(
        'Built-in filler prompt cloned to Prompt Library. It was not selected as an override.',
      );
    } catch (err) {
      toast.error(sanitizeError(err, 'Failed to clone built-in filler prompt'));
    } finally {
      setIsCloningBuiltInFillerPrompt(false);
    }
  };

  const updatePipelineNested = (
    section: 'shortCircuit' | 'toolFilter' | 'keywordVeto' | 'intentBridge',
    key: string,
    value: unknown,
  ) => {
    if (!config) return;
    const current = config.pipeline ?? defaultPipeline;
    const sectionData = current[section] ?? defaultPipeline[section];
    setConfig({
      ...config,
      pipeline: {
        ...current,
        [section]: { ...sectionData, [key]: value },
      },
    });
    setIsDirty(true);
  };

  const updatePIIRedaction = (key: keyof PIIRedactionConfig, value: unknown) => {
    if (!config) return;
    setConfig({ ...config, pii_redaction: { ...config.pii_redaction, [key]: value } });
    setIsDirty(true);
  };

  const addLookupTable = () => {
    if (!config) return;
    setConfig({
      ...config,
      lookup_tables: [
        ...config.lookup_tables,
        {
          name: '',
          source: 'inline',
          values: [],
          case_sensitive: false,
          fuzzy_match: false,
          fuzzy_threshold: 0.8,
        },
      ],
    });
    setIsDirty(true);
  };

  const updateLookupTable = (index: number, updates: Partial<LookupTableEntry>) => {
    if (!config) return;
    const tables = [...config.lookup_tables];
    tables[index] = { ...tables[index], ...updates };
    setConfig({ ...config, lookup_tables: tables });
    setIsDirty(true);
  };

  const removeLookupTable = (index: number) => {
    if (!config) return;
    setConfig({ ...config, lookup_tables: config.lookup_tables.filter((_, i) => i !== index) });
    setIsDirty(true);
  };

  // --- Loading state ---
  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-6">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 text-muted animate-spin" />
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-6">
        <EmptyState
          icon={<Settings className="w-6 h-6" />}
          title={t('load_failed')}
          description={t('load_failed')}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto px-6 py-6">
      {/* Header with save/reset */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
          <p className="text-sm text-muted mt-1">{t('description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowReset(true)}
            icon={<RotateCcw className="w-3.5 h-3.5" />}
          >
            {t('reset_to_defaults')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            loading={isSaving}
            disabled={!isDirty}
            icon={<Check className="w-3.5 h-3.5" />}
          >
            {tCommon('save')}
          </Button>
        </div>
      </div>

      {/* Extraction Section */}
      <ConfigSection
        title={t('section_extraction')}
        description={t('section_extraction_description')}
      >
        <Field label={t('field_strategy')} description={t('field_strategy_description')}>
          <div className="flex items-center gap-2">
            <SelectField
              value={config.extraction.strategy}
              onChange={(v) => updateExtraction('strategy', v)}
              options={EXTRACTION_STRATEGIES}
            />
            <Badge variant={STRATEGY_BADGE[config.extraction.strategy] || 'info'}>
              {config.extraction.strategy}
            </Badge>
          </div>
        </Field>
        <Field
          label={t('field_correction_detection')}
          description={t('field_correction_detection_description')}
        >
          <SelectField
            value={config.extraction.correction_detection}
            onChange={(v) => updateExtraction('correction_detection', v)}
            options={CORRECTION_METHODS}
          />
        </Field>
        <Field label={t('field_nlu_provider')} description={t('field_nlu_provider_description')}>
          <div className="flex items-center gap-2">
            <SelectField
              value={config.extraction.nlu_provider ?? 'standard'}
              onChange={(v) => updateExtraction('nlu_provider', v)}
              options={NLU_PROVIDERS}
            />
            {config.extraction.nlu_provider === 'advanced' && (
              <Badge variant="warning">{t('nlu_provider_enterprise_badge')}</Badge>
            )}
          </div>
        </Field>
        {config.extraction.nlu_provider === 'advanced' && (
          <>
            <Field
              label={t('field_advanced_sidecar_url')}
              description={t('field_advanced_sidecar_url_description')}
            >
              <input
                type="url"
                value={config.extraction.advanced_sidecar_url ?? ''}
                onChange={(e) => updateExtraction('advanced_sidecar_url', e.target.value)}
                placeholder="http://kore-nlu:8090"
                className="w-full max-w-xs rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus/50"
              />
            </Field>
            <Field label={t('field_advanced_sidecar_timeout')}>
              <NumberField
                value={config.extraction.advanced_sidecar_timeout_ms ?? 3000}
                onChange={(v) => updateExtraction('advanced_sidecar_timeout_ms', v)}
                min={100}
                max={30000}
                step={100}
              />
            </Field>
            <Field label={t('field_advanced_sidecar_threshold')}>
              <NumberField
                value={config.extraction.advanced_sidecar_circuit_breaker_threshold ?? 5}
                onChange={(v) => updateExtraction('advanced_sidecar_circuit_breaker_threshold', v)}
                min={1}
                max={100}
              />
            </Field>
          </>
        )}
        <Field label={t('field_sidecar_timeout')}>
          <NumberField
            value={config.extraction.sidecar_timeout_ms}
            onChange={(v) => updateExtraction('sidecar_timeout_ms', v)}
            min={100}
            max={10000}
            step={100}
          />
        </Field>
        <Field label={t('field_sidecar_threshold')}>
          <NumberField
            value={config.extraction.sidecar_circuit_breaker_threshold}
            onChange={(v) => updateExtraction('sidecar_circuit_breaker_threshold', v)}
            min={1}
            max={100}
          />
        </Field>
      </ConfigSection>

      {/* Multi-Intent Section */}
      <ConfigSection
        title={t('section_multi_intent')}
        description={t('section_multi_intent_description')}
      >
        <Field label={t('field_multi_intent_enabled')}>
          <Toggle
            checked={config.multi_intent.enabled}
            onChange={(v) => updateMultiIntent('enabled', v)}
          />
        </Field>
        <Field label={t('field_multi_intent_strategy')}>
          <SelectField
            value={config.multi_intent.strategy}
            onChange={(v) => updateMultiIntent('strategy', v)}
            options={MULTI_INTENT_STRATEGIES}
          />
        </Field>
        <Field label={t('field_multi_intent_max')}>
          <NumberField
            value={config.multi_intent.max_intents}
            onChange={(v) => updateMultiIntent('max_intents', v)}
            min={1}
            max={10}
          />
        </Field>
        <Field label={t('field_multi_intent_confidence')}>
          <NumberField
            value={config.multi_intent.confidence_threshold}
            onChange={(v) => updateMultiIntent('confidence_threshold', v)}
            min={0}
            max={1}
            step={0.05}
          />
        </Field>
        <Field label={t('field_queue_max_age')}>
          <NumberField
            value={config.multi_intent.queue_max_age_ms}
            onChange={(v) => updateMultiIntent('queue_max_age_ms', v)}
            min={0}
            max={3600000}
            step={60000}
          />
        </Field>
      </ConfigSection>

      {/* Inference Section */}
      <ConfigSection
        title={t('section_inference')}
        description={t('section_inference_description')}
      >
        <Field label={t('field_inference_confidence')}>
          <NumberField
            value={config.inference.confidence}
            onChange={(v) => updateInference('confidence', v)}
            min={0}
            max={1}
            step={0.05}
          />
        </Field>
        <Field label={t('field_inference_confirm')}>
          <Toggle
            checked={config.inference.confirm}
            onChange={(v) => updateInference('confirm', v)}
          />
        </Field>
        <Field label={t('field_inference_model_tier')}>
          <SelectField
            value={config.inference.model_tier}
            onChange={(v) => updateInference('model_tier', v)}
            options={MODEL_TIERS}
          />
        </Field>
        <Field label={t('field_inference_max_fields')}>
          <NumberField
            value={config.inference.max_fields_per_pass}
            onChange={(v) => updateInference('max_fields_per_pass', v)}
            min={1}
            max={10}
          />
        </Field>
      </ConfigSection>

      {/* Conversion Section */}
      <ConfigSection
        title={t('section_conversion')}
        description={t('section_conversion_description')}
      >
        <Field label={t('field_currency_mode')}>
          <SelectField
            value={config.conversion.currency_mode}
            onChange={(v) => updateConversion('currency_mode', v)}
            options={CURRENCY_MODES}
          />
        </Field>
        {config.conversion.currency_mode === 'live' && (
          <Field label={t('field_currency_api_url')}>
            <input
              type="text"
              value={config.conversion.currency_api_url || ''}
              onChange={(e) => updateConversion('currency_api_url', e.target.value || undefined)}
              placeholder="https://api.exchangerate.host/latest"
              className="w-full rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus/50"
            />
          </Field>
        )}
      </ConfigSection>

      {/* Reasoning Pipeline Section */}
      <ConfigSection
        title={t('section_pipeline')}
        description={t('section_pipeline_description')}
        defaultOpen={false}
      >
        <div className="flex items-start gap-3 p-3 rounded-lg bg-warning/10 border border-warning/30">
          <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
          <div className="text-xs text-foreground space-y-1">
            <p className="font-medium">{t('pipeline_warning_title')}</p>
            <ul className="list-disc list-inside text-muted space-y-0.5">
              <li>{t('pipeline_warning_model')}</li>
              <li>{t('pipeline_warning_latency')}</li>
              <li>{t('pipeline_warning_circuit_breaker')}</li>
            </ul>
          </div>
        </div>
        <Field
          label={t('field_pipeline_enabled')}
          description={t('field_pipeline_enabled_description')}
        >
          <Toggle
            checked={config.pipeline?.enabled ?? false}
            onChange={(v) => updatePipeline('enabled', v)}
          />
        </Field>
        {config.pipeline?.enabled && (
          <>
            <Field
              label={t('field_pipeline_mode')}
              description={t('field_pipeline_mode_description')}
            >
              <SelectField
                value={config.pipeline?.mode ?? 'parallel'}
                onChange={(v) => updatePipeline('mode', v)}
                options={PIPELINE_MODES}
              />
            </Field>
            <Field
              label="Pipeline Model"
              description="Model used for intent classification. Default uses the project's tool_selection model."
            >
              <Select
                value={
                  config.pipeline?.modelSource === 'tenant' && config.pipeline?.tenantModelId
                    ? config.pipeline.tenantModelId
                    : 'default'
                }
                onChange={handlePipelineModelChange}
                className="max-w-xs"
                options={[
                  { value: 'default', label: 'Default' },
                  ...tenantModels.map((tm) => ({
                    value: tm.id,
                    label: formatModelOptionLabel(tm),
                  })),
                ]}
              />
            </Field>

            {/* Short Circuit */}
            <Field
              label="Short Circuit"
              description="Skip reasoning loop when classifier confidence is very high"
            >
              <Toggle
                checked={config.pipeline?.shortCircuit?.enabled ?? true}
                onChange={(v) => updatePipelineNested('shortCircuit', 'enabled', v)}
              />
            </Field>
            {config.pipeline?.shortCircuit?.enabled !== false && (
              <Field
                label="Short Circuit Threshold"
                description="Minimum confidence for programmatic routing (0.0–1.0)"
              >
                <NumberField
                  value={config.pipeline?.shortCircuit?.confidenceThreshold ?? 0.85}
                  onChange={(v) => updatePipelineNested('shortCircuit', 'confidenceThreshold', v)}
                  min={0}
                  max={1}
                  step={0.05}
                />
              </Field>
            )}

            {/* Tool Filter */}
            <Field
              label="Tool Filter"
              description="Reduce tool set sent to LLM based on classifier analysis"
            >
              <Toggle
                checked={config.pipeline?.toolFilter?.enabled ?? true}
                onChange={(v) => updatePipelineNested('toolFilter', 'enabled', v)}
              />
            </Field>
            {config.pipeline?.toolFilter?.enabled !== false && (
              <Field
                label="Max Tools"
                description="Maximum number of tools sent to the reasoning loop"
              >
                <NumberField
                  value={config.pipeline?.toolFilter?.maxTools ?? 6}
                  onChange={(v) => updatePipelineNested('toolFilter', 'maxTools', v)}
                  min={1}
                  max={50}
                  step={1}
                />
              </Field>
            )}

            {/* Keyword Veto */}
            <Field
              label="Keyword Veto"
              description="Override classifier routing when specific keywords are detected"
            >
              <Toggle
                checked={config.pipeline?.keywordVeto?.enabled ?? true}
                onChange={(v) => updatePipelineNested('keywordVeto', 'enabled', v)}
              />
            </Field>
            {config.pipeline?.keywordVeto?.enabled !== false && (
              <Field
                label="Veto Keywords"
                description="Comma-separated keywords that trigger veto (e.g., refund, cancel)"
              >
                <input
                  type="text"
                  value={(config.pipeline?.keywordVeto?.keywords ?? []).join(', ')}
                  onChange={(e) =>
                    updatePipelineNested(
                      'keywordVeto',
                      'keywords',
                      e.target.value
                        .split(',')
                        .map((k) => k.trim())
                        .filter(Boolean),
                    )
                  }
                  placeholder="refund, cancel, complaint"
                  className="w-full max-w-xs rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus/50"
                />
              </Field>
            )}

            {/* Intent Bridge */}
            <Field
              label="Intent Bridge"
              description="Map classifier output to session state for WHEN conditions and multi-intent dispatch"
            >
              <Toggle
                checked={config.pipeline?.intentBridge?.enabled ?? true}
                onChange={(v) => updatePipelineNested('intentBridge', 'enabled', v)}
              />
            </Field>
            {config.pipeline?.intentBridge?.enabled !== false && (
              <>
                <Field
                  label="Programmatic Threshold"
                  description="Confidence threshold for Tier 1 actions (auto-decline, auto-route)"
                >
                  <NumberField
                    value={config.pipeline?.intentBridge?.programmaticThreshold ?? 0.85}
                    onChange={(v) =>
                      updatePipelineNested('intentBridge', 'programmaticThreshold', v)
                    }
                    min={0}
                    max={1}
                    step={0.05}
                  />
                </Field>
                <Field
                  label="Guided Threshold"
                  description="Confidence threshold for Tier 2 guided reasoning (tool hiding, routing hints)"
                >
                  <NumberField
                    value={config.pipeline?.intentBridge?.guidedThreshold ?? 0.5}
                    onChange={(v) => updatePipelineNested('intentBridge', 'guidedThreshold', v)}
                    min={0}
                    max={1}
                    step={0.05}
                  />
                </Field>
                <Field
                  label="Out-of-Scope Decline"
                  description="Programmatically decline out-of-scope queries without LLM call"
                >
                  <Toggle
                    checked={config.pipeline?.intentBridge?.outOfScopeDecline ?? true}
                    onChange={(v) => updatePipelineNested('intentBridge', 'outOfScopeDecline', v)}
                  />
                </Field>
                <Field
                  label="Multi-Intent Signal"
                  description="Inject multi-intent hints when classifier detects 2+ intents"
                >
                  <Toggle
                    checked={config.pipeline?.intentBridge?.multiIntentSignal ?? true}
                    onChange={(v) => updatePipelineNested('intentBridge', 'multiIntentSignal', v)}
                  />
                </Field>
              </>
            )}
          </>
        )}
      </ConfigSection>

      {/* Filler Section */}
      <ConfigSection
        title="Filler Settings"
        description="Transient chat and voice status messages while runtime work is in progress"
        defaultOpen={false}
      >
        <Field label="Fillers Enabled" description="Enable transient processing status messages">
          <Toggle
            checked={config.filler?.enabled ?? true}
            onChange={(v) => updateFiller('enabled', v)}
          />
        </Field>
        {config.filler?.enabled !== false && (
          <>
            <Field label="Chat Fillers" description="Show status_update messages in chat clients">
              <Toggle
                checked={config.filler?.chatEnabled ?? true}
                onChange={(v) => updateFiller('chatEnabled', v)}
              />
            </Field>
            <Field label="Voice Fillers" description="Speak status updates on voice channels">
              <Toggle
                checked={config.filler?.voiceEnabled ?? true}
                onChange={(v) => updateFiller('voiceEnabled', v)}
              />
            </Field>
            <Field label="Chat Delay" description="Delay before static chat fillers are emitted">
              <NumberField
                value={config.filler?.chatDelayMs ?? 1200}
                onChange={(v) => updateFiller('chatDelayMs', v)}
                min={0}
                max={60000}
                step={100}
              />
            </Field>
            <Field label="Voice Delay" description="Delay before static voice fillers are emitted">
              <NumberField
                value={config.filler?.voiceDelayMs ?? 500}
                onChange={(v) => updateFiller('voiceDelayMs', v)}
                min={1}
                max={60000}
                step={100}
              />
            </Field>
            <Field label="Cooldown" description="Minimum interval between static fillers">
              <NumberField
                value={config.filler?.cooldownMs ?? 3000}
                onChange={(v) => updateFiller('cooldownMs', v)}
                min={0}
                max={60000}
                step={100}
              />
            </Field>
            <Field label="Max Per Turn" description="Maximum fillers emitted during one turn">
              <NumberField
                value={config.filler?.maxPerTurn ?? 5}
                onChange={(v) => updateFiller('maxPerTurn', v)}
                min={0}
                max={20}
                step={1}
              />
            </Field>
            <Field
              label="Status Tags"
              description="Use <status> tags emitted by the response model as fillers"
            >
              <Toggle
                checked={config.filler?.piggybackEnabled ?? true}
                onChange={(v) => updateFiller('piggybackEnabled', v)}
              />
            </Field>
            <Field
              label="Generated Fillers"
              description="Use a lightweight model call to create contextual fillers"
            >
              <Toggle
                checked={config.filler?.pipelineGenerationEnabled ?? true}
                onChange={(v) => updateFiller('pipelineGenerationEnabled', v)}
              />
            </Field>
            {config.filler?.pipelineGenerationEnabled !== false && (
              <>
                <Field
                  label="Filler Model"
                  description="Model used to generate contextual filler messages"
                >
                  <Select
                    value={
                      config.filler?.modelSource === 'project' && config.filler?.modelId
                        ? config.filler.modelId
                        : 'system'
                    }
                    onChange={handleFillerModelChange}
                    className="max-w-xs"
                    options={[
                      { value: 'system', label: 'Runtime default model' },
                      ...projectModelOptions.map((model) => ({
                        value: model.value,
                        label: `${model.label}${
                          model.isCredentialReady ? '' : ' - credentials unavailable'
                        }`,
                      })),
                    ]}
                  />
                  {projectModelOptions.length === 0 && (
                    <p className="mt-2 text-xs text-muted">
                      Add a project model to make a filler model override available.
                    </p>
                  )}
                </Field>
                <Field
                  label="Filler Prompt"
                  description="Optional prompt-library override for contextual filler generation. Use {{userMessage}}."
                >
                  <PromptOverrideControl
                    value={config.filler?.promptRef}
                    onPick={() => setPromptPickerTarget('filler')}
                    onClear={clearFillerPrompt}
                    onCloneBuiltIn={() => void cloneBuiltInFillerPrompt()}
                    cloningBuiltIn={isCloningBuiltInFillerPrompt}
                  />
                </Field>
              </>
            )}
          </>
        )}
      </ConfigSection>

      {/* PII Redaction Section */}
      <ConfigSection
        title={t('section_pii_redaction')}
        description={t('section_pii_redaction_description')}
      >
        <Field label={t('field_pii_enabled')} description={t('field_pii_enabled_description')}>
          <Toggle
            checked={config.pii_redaction.enabled}
            onChange={(v) => updatePIIRedaction('enabled', v)}
          />
        </Field>
        {config.pii_redaction.enabled && (
          <>
            <Field
              label={t('field_pii_redact_input')}
              description={t('field_pii_redact_input_description')}
            >
              <Toggle
                checked={config.pii_redaction.redact_input}
                onChange={(v) => updatePIIRedaction('redact_input', v)}
              />
            </Field>
            <Field
              label={t('field_pii_redact_output')}
              description={t('field_pii_redact_output_description')}
            >
              <Toggle
                checked={config.pii_redaction.redact_output}
                onChange={(v) => updatePIIRedaction('redact_output', v)}
              />
            </Field>
          </>
        )}
      </ConfigSection>

      {/* Lookup Tables Section */}
      <ConfigSection
        title={t('section_lookup_tables')}
        description={t('section_lookup_tables_description')}
      >
        <div className="rounded-lg border border-warning/30 bg-warning-subtle/40 px-3 py-3 text-sm text-warning">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="warning">{t('lookup_tables_canonical_badge')}</Badge>
                <Badge variant="purple">{t('lookup_tables_experimental_badge')}</Badge>
              </div>
              <p>{t('lookup_tables_project_contract_note')}</p>
            </div>
          </div>
        </div>
        {config.lookup_tables.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-sm text-muted">{t('no_lookup_tables')}</p>
            <p className="text-xs text-subtle mt-1">{t('no_lookup_tables_description')}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={addLookupTable}
              icon={<Plus className="w-3.5 h-3.5" />}
              className="mt-3"
            >
              {t('add_lookup_table')}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {config.lookup_tables.map((table, idx) => (
              <div
                key={idx}
                className="p-4 rounded-lg bg-background-elevated border border-default space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={table.name}
                      onChange={(e) => updateLookupTable(idx, { name: e.target.value })}
                      placeholder={t('lookup_table_name')}
                      className="rounded-md border border-default bg-background px-3 py-1 text-sm font-medium text-foreground w-48 focus:outline-none focus:ring-2 focus:ring-border-focus/50"
                    />
                    <Badge variant="info">{table.source}</Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => removeLookupTable(idx)}
                    icon={<Trash2 className="w-3.5 h-3.5 text-error" />}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted mb-1 block">
                      {t('lookup_table_source')}
                    </label>
                    <SelectField
                      value={table.source}
                      onChange={(v) =>
                        updateLookupTable(idx, { source: v as 'api' | 'inline' | 'collection' })
                      }
                      options={LOOKUP_SOURCES}
                    />
                  </div>

                  {table.source === 'inline' && (
                    <div className="col-span-2">
                      <label className="text-xs text-muted mb-1 block">
                        {t('lookup_table_values')}
                      </label>
                      <input
                        type="text"
                        value={(table.values ?? []).join(', ')}
                        onChange={(e) =>
                          updateLookupTable(idx, {
                            values: e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                        placeholder="LAX, JFK, SFO, ORD"
                        className="w-full rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus/50"
                      />
                    </div>
                  )}

                  {table.source === 'api' && (
                    <>
                      <div className="col-span-2">
                        <label className="text-xs text-muted mb-1 block">
                          {t('lookup_table_endpoint')}
                        </label>
                        <input
                          type="text"
                          value={table.endpoint ?? ''}
                          onChange={(e) =>
                            updateLookupTable(idx, { endpoint: e.target.value || undefined })
                          }
                          placeholder="https://api.example.com/lookup"
                          className="w-full rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus/50"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted mb-1 block">
                          {t('lookup_table_timeout')}
                        </label>
                        <input
                          type="number"
                          value={table.timeout_ms ?? 5000}
                          onChange={(e) =>
                            updateLookupTable(idx, {
                              timeout_ms: parseInt(e.target.value, 10) || undefined,
                            })
                          }
                          min={100}
                          max={30000}
                          className="w-full rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus/50"
                        />
                      </div>
                    </>
                  )}

                  {table.source === 'collection' && (
                    <>
                      <div>
                        <label className="text-xs text-muted mb-1 block">
                          {t('lookup_table_name_field')}
                        </label>
                        <input
                          type="text"
                          value={table.table_name ?? ''}
                          onChange={(e) =>
                            updateLookupTable(idx, {
                              table_name: e.target.value || undefined,
                            })
                          }
                          className="w-full rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus/50"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted mb-1 block">
                          {t('lookup_table_field')}
                        </label>
                        <input
                          type="text"
                          value={table.field ?? ''}
                          onChange={(e) =>
                            updateLookupTable(idx, { field: e.target.value || undefined })
                          }
                          placeholder="name"
                          className="w-full rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-border-focus/50"
                        />
                      </div>
                    </>
                  )}

                  {table.source === 'collection' && table.table_name && (
                    <div className="col-span-2 mt-2">
                      <label className="text-xs text-muted mb-1 block">
                        {t('lookup_table_upload')}
                      </label>
                      <p className="text-xs text-subtle mb-2">
                        {t('lookup_table_upload_description')}
                      </p>
                      <input
                        type="file"
                        accept=".csv,.json"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          if (file.size > 1048576) {
                            toast.error(t('lookup_table_upload_max_size'));
                            e.target.value = '';
                            return;
                          }
                          if (!projectId) return;
                          try {
                            const text = await file.text();
                            const contentType = file.name.endsWith('.csv')
                              ? 'text/csv'
                              : 'application/json';
                            const res = await apiFetch(
                              `/api/projects/${projectId}/lookup-tables/${table.table_name}/upload`,
                              {
                                method: 'POST',
                                headers: { 'Content-Type': contentType },
                                body: text,
                              },
                            );
                            if (!res.ok) {
                              const data = await res.json();
                              throw new Error(data.error?.message ?? `HTTP ${res.status}`);
                            }
                            const data = await res.json();
                            toast.success(`Uploaded ${data.data?.inserted ?? 0} entries`);
                          } catch (err) {
                            toast.error(sanitizeError(err, 'Upload failed'));
                          } finally {
                            e.target.value = '';
                          }
                        }}
                        className="text-sm text-foreground file:mr-4 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-accent file:text-accent-foreground hover:file:opacity-90"
                      />
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-6 pt-2 border-t border-default">
                  <label className="flex items-center gap-2 text-xs text-muted">
                    <Toggle
                      checked={table.case_sensitive}
                      onChange={(v) => updateLookupTable(idx, { case_sensitive: v })}
                    />
                    {t('lookup_table_case_sensitive')}
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted">
                    <Toggle
                      checked={table.fuzzy_match}
                      onChange={(v) => updateLookupTable(idx, { fuzzy_match: v })}
                    />
                    {t('lookup_table_fuzzy')}
                  </label>
                  {table.fuzzy_match && (
                    <label className="flex items-center gap-2 text-xs text-muted">
                      {t('lookup_table_fuzzy_threshold')}
                      <NumberField
                        value={table.fuzzy_threshold}
                        onChange={(v) => updateLookupTable(idx, { fuzzy_threshold: v })}
                        min={0}
                        max={1}
                        step={0.05}
                      />
                    </label>
                  )}
                </div>
              </div>
            ))}

            <Button
              variant="secondary"
              size="sm"
              onClick={addLookupTable}
              icon={<Plus className="w-3.5 h-3.5" />}
            >
              {t('add_lookup_table')}
            </Button>
          </div>
        )}
      </ConfigSection>

      {/* Reset confirmation dialog */}
      <ConfirmDialog
        open={showReset}
        onClose={() => setShowReset(false)}
        onConfirm={handleReset}
        title={t('reset_confirm_title')}
        description={t('reset_confirm_description')}
        variant="danger"
        loading={isResetting}
      />
      {promptPickerTarget && projectId && (
        <PromptPickerModal
          projectId={projectId}
          onConfirm={handlePromptSelection}
          onClose={() => setPromptPickerTarget(null)}
        />
      )}
    </div>
  );
}
