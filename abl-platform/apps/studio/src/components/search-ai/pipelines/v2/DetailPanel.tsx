/**
 * DetailPanel — persistent 420px right panel in the pipeline editor flex layout.
 *
 * Modes:
 *   - Empty state (default): prompts user to select a stage
 *   - Stage config: provider dropdown + config form for the selected stage
 *   - Embedding info: read-only display of shared embedding config
 *   - Version: placeholder for future version history
 */

'use client';

import { useState, useCallback, useMemo, useRef, useEffect, type DragEvent } from 'react';
import { useTranslations } from 'next-intl';
import {
  Layers,
  Database,
  Settings,
  GripVertical,
  Settings2,
  Trash2,
  Plus,
  ChevronDown,
  ChevronRight,
  Filter,
  GitBranch,
  ArrowDown,
  Shield,
  Download,
  Upload,
  Eye,
  Copy,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';
import { usePipelineStore } from '../../../../store/pipeline-store';
import { Select } from '../../../ui/Select';
import { Button } from '../../../ui/Button';
import { Toggle } from '../../../ui/Toggle';
import { DoclingConfig } from './providers/DoclingConfig';
import { LlamaIndexConfig } from './providers/LlamaIndexConfig';
// TreeBuilderConfig removed — tree-builder chunking is not fully wired
import { ChunkingConfig } from './providers/ChunkingConfig';
import { EnrichmentConfig } from './providers/EnrichmentConfig';
import type { PipelineStage, PipelineFlow, RuleCondition } from '../../../../api/pipelines';
import { isUtilityStage } from './stage-insertion-rules';
import { FieldMappingConfig } from './providers/FieldMappingConfig';
import { ApiStageConfig } from './providers/ApiStageConfig';
import { LlmStageConfig } from './providers/LlmStageConfig';
import { ContentIntelligenceConfig } from './providers/ContentIntelligenceConfig';
import { VisualAnalysisConfig } from './providers/VisualAnalysisConfig';

// =============================================================================
// PROVIDER LOOKUPS
// =============================================================================

/** Provider value → i18n key mapping. Product names (Docling, LlamaIndex, BGE-M3) stay as-is. */
const PROVIDER_LABEL_KEYS: Record<string, string> = {
  'http-webhook': 'v2_provider_custom_api',
  'recursive-character': 'v2_provider_recursive_char',
  'fixed-size': 'v2_provider_fixed_size',
  'llm-enrichment': 'v2_provider_llm_enrichment',
  'question-synthesis': 'v2_provider_question_synthesis',
};

/** Available providers per stage type — labels resolved via i18n at render time */
const PROVIDERS_BY_TYPE: Record<string, { value: string; fallbackLabel: string }[]> = {
  extraction: [
    { value: 'docling', fallbackLabel: 'Docling' },
    { value: 'llamaindex', fallbackLabel: 'LlamaIndex' },
    { value: 'http-webhook', fallbackLabel: 'Custom API' },
  ],
  chunking: [
    { value: 'recursive-character', fallbackLabel: 'Recursive Character' },
    { value: 'fixed-size', fallbackLabel: 'Fixed Size' },
  ],
  enrichment: [
    { value: 'llm-enrichment', fallbackLabel: 'LLM Enrichment' },
    { value: 'question-synthesis', fallbackLabel: 'Question Synthesis' },
    { value: 'http-webhook', fallbackLabel: 'Custom API' },
  ],
  embedding: [{ value: 'bge-m3', fallbackLabel: 'BGE-M3' }],
};

/** Providers that open a side panel instead of showing inline config */
const COMPLEX_PROVIDERS = ['http-webhook'];

// =============================================================================
// STAGE TYPE LABELS (reused from StageNode pattern)
// =============================================================================

const STAGE_TYPE_KEYS: Record<string, string> = {
  extraction: 'stage_extraction',
  chunking: 'stage_chunking',
  enrichment: 'stage_enrichment',
  'content-intelligence': 'v2_stage_content_intelligence',
  'visual-analysis': 'v2_stage_visual_analysis',
  embedding: 'stage_embedding',
  'field-mapping': 'v2_stage_field_mapping',
  'api-webhook': 'v2_stage_api_webhook',
  'llm-stage': 'v2_stage_llm_stage',
};

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function EmptyState() {
  const t = useTranslations('search_ai.pipeline');
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <Layers className="mb-3 h-8 w-8 text-foreground-muted" />
      <p className="text-sm font-medium text-foreground">{t('v2_detail_empty_title')}</p>
      <p className="mt-1 text-xs text-foreground-muted">{t('v2_detail_empty_description')}</p>
    </div>
  );
}

function EmbeddingInfoMode() {
  const t = useTranslations('search_ai.pipeline');
  const draft = usePipelineStore((s) => s.draft);
  const openEmbeddingDialog = usePipelineStore((s) => s.openEmbeddingDialog);
  const embeddingConfig = draft?.activeEmbeddingConfig;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-default px-4 py-3">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-foreground-muted" />
          <h2 className="text-sm font-semibold text-foreground">
            {t('v2_detail_embedding_title')}
          </h2>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-4">
          {/* Embedding Provider Settings */}
          <div className="rounded-lg border border-default bg-background p-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-muted">
              {t('v2_embedding')}
            </h3>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-foreground-muted">
                  {t('v2_detail_embedding_provider')}
                </span>
                <span className="text-xs font-medium text-foreground">
                  {embeddingConfig?.provider ?? t('v2_detail_not_configured')}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-foreground-muted">
                  {t('v2_detail_embedding_model')}
                </span>
                <span className="text-xs font-medium text-foreground">
                  {embeddingConfig?.model ?? t('v2_detail_not_configured')}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-foreground-muted">
                  {t('v2_detail_embedding_dimensions')}
                </span>
                <span className="text-xs font-medium text-foreground">
                  {embeddingConfig?.dimensions !== undefined
                    ? String(embeddingConfig.dimensions)
                    : t('v2_detail_not_configured')}
                </span>
              </div>
            </div>
          </div>

          {/* Change Provider Button */}
          <Button variant="secondary" size="sm" onClick={openEmbeddingDialog}>
            {t('v2_embedding_change_provider')}
          </Button>

          {/* Scope & Warnings */}
          <div className="space-y-2">
            <div className="rounded-lg border border-default bg-background-muted p-3">
              <p className="text-xs text-foreground-muted">
                {t('v2_detail_embedding_shared_note')}
              </p>
            </div>
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
              <p className="text-xs text-foreground-muted">
                {t('v2_detail_embedding_reindex_warning')}
              </p>
            </div>
          </div>

          {/* Embedding Fields — Phase 2 */}
          <div className="border-t border-default pt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-muted">
              {t('v2_embedding_fields_title')}
            </h3>
            <div className="rounded-lg border border-default bg-background-muted p-3">
              <p className="text-xs text-foreground-muted">
                {t('v2_embedding_fields_placeholder')}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function VersionMode() {
  const t = useTranslations('search_ai.pipeline');
  const draft = usePipelineStore((s) => s.draft);
  const updateDraft = usePipelineStore((s) => s.updateDraft);
  const [showJson, setShowJson] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalStages = useMemo(
    () =>
      draft?.flows.reduce(
        (sum, f) => sum + f.stages.filter((s) => s.type !== 'embedding').length,
        0,
      ) ?? 0,
    [draft?.flows],
  );

  const jsonString = useMemo(() => (draft ? JSON.stringify(draft, null, 2) : '{}'), [draft]);

  const handleExport = useCallback(() => {
    if (!draft) return;
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pipeline-v${draft.version ?? 1}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [draft, jsonString]);

  const handleCopyJson = useCallback(() => {
    void navigator.clipboard.writeText(jsonString);
  }, [jsonString]);

  const handleImport = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setImportError(null);
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const parsed = JSON.parse(ev.target?.result as string);
          if (!parsed.flows || !Array.isArray(parsed.flows)) {
            setImportError(t('v2_version_import_invalid'));
            return;
          }
          updateDraft(parsed);
        } catch {
          setImportError(t('v2_version_import_parse_error'));
        }
      };
      reader.readAsText(file);
      // Reset input so same file can be re-selected
      e.target.value = '';
    },
    [updateDraft, t],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-default px-4 py-3">
        <div className="flex items-center gap-2">
          <Settings className="h-4 w-4 text-foreground-muted" />
          <h2 className="text-sm font-semibold text-foreground">{t('v2_detail_version_title')}</h2>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-4">
          {/* Current version info */}
          <div className="rounded-lg border border-default bg-background p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">
                {t('v2_deploy_version', { version: draft?.version ?? 1 })}
              </span>
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                {draft?.status === 'active'
                  ? t('v2_history_current')
                  : t('v2_history_not_deployed')}
              </span>
            </div>
            <div className="mt-2 flex gap-4 text-xs text-foreground-muted">
              <span>{t('v2_deploy_flows', { count: draft?.flows.length ?? 0 })}</span>
              <span>{t('v2_deploy_stages', { count: totalStages })}</span>
            </div>
          </div>

          {/* Actions */}
          <div className="space-y-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<Eye className="h-3.5 w-3.5" />}
              onClick={() => setShowJson(!showJson)}
            >
              {showJson ? t('v2_version_hide_json') : t('v2_version_view_json')}
            </Button>

            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={<Download className="h-3.5 w-3.5" />}
                onClick={handleExport}
              >
                {t('v2_version_export')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Upload className="h-3.5 w-3.5" />}
                onClick={() => fileInputRef.current?.click()}
              >
                {t('v2_version_import')}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={handleImport}
              />
            </div>
          </div>

          {importError && (
            <div className="rounded-md border border-error/30 bg-error/5 px-3 py-2">
              <p className="text-xs text-error">{importError}</p>
            </div>
          )}

          {/* JSON viewer */}
          {showJson && (
            <div className="relative">
              <button
                onClick={handleCopyJson}
                className="absolute right-2 top-2 rounded p-1 text-foreground-muted hover:bg-background-muted hover:text-foreground"
                title="Copy"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              <pre className="max-h-[400px] overflow-auto rounded-lg border border-default bg-background-muted p-3 text-[10px] leading-relaxed text-foreground">
                {jsonString}
              </pre>
            </div>
          )}

          {/* Version history note */}
          <div className="rounded-lg border border-default bg-background-muted p-3">
            <p className="text-xs text-foreground-muted">{t('v2_version_history_note')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

interface StageConfigModeProps {
  flowName: string;
  stage: PipelineStage;
  flowId: string;
}

function StageConfigMode({ flowName, stage, flowId }: StageConfigModeProps) {
  const t = useTranslations('search_ai.pipeline');
  const updateStage = usePipelineStore((s) => s.updateStage);
  const removeStage = usePipelineStore((s) => s.removeStage);
  const expandStage = usePipelineStore((s) => s.expandStage);
  const openPanel = usePipelineStore((s) => s.openPanel);

  const [selectedProvider, setSelectedProvider] = useState(stage.provider);
  const [localConfig, setLocalConfig] = useState<Record<string, unknown>>(
    stage.providerConfig ?? {},
  );

  // Sync selectedProvider with stage.provider when stage changes
  useEffect(() => {
    setSelectedProvider(stage.provider);
  }, [stage.provider, stage.id]);

  const stageTypeLabel = STAGE_TYPE_KEYS[stage.type] ? t(STAGE_TYPE_KEYS[stage.type]) : stage.type;

  const providerOptions = useMemo(
    () =>
      (PROVIDERS_BY_TYPE[stage.type] ?? []).map((p) => ({
        value: p.value,
        label: PROVIDER_LABEL_KEYS[p.value] ? t(PROVIDER_LABEL_KEYS[p.value]) : p.fallbackLabel,
      })),
    [stage.type, t],
  );

  const isComplex = COMPLEX_PROVIDERS.includes(selectedProvider);
  const activePanelType = usePipelineStore((s) => s.activePanelType);

  // Auto-open ConfigSidePanel if stage already has a complex provider
  // Auto-close ConfigSidePanel if stage has a non-complex provider (but keep DetailPanel open)
  useEffect(() => {
    if (isComplex && activePanelType !== 'config') {
      openPanel('config', stage.id);
    } else if (!isComplex && activePanelType === 'config') {
      // Close ConfigSidePanel but keep DetailPanel expanded
      usePipelineStore.setState({
        activePanelType: null,
        activePanelNodeId: null,
        detailPanelCollapsed: false,
      });
    }
  }, [isComplex, stage.id, openPanel, activePanelType]);

  const handleProviderChange = useCallback(
    (newProvider: string) => {
      setSelectedProvider(newProvider);
      if (COMPLEX_PROVIDERS.includes(newProvider)) {
        openPanel('config', stage.id);
      } else {
        setLocalConfig({});
      }
    },
    [openPanel, stage.id],
  );

  const [celEnabled, setCelEnabled] = useState(!!stage.executionCondition);
  const [celExpression, setCelExpression] = useState(stage.executionCondition ?? '');

  const handleApply = useCallback(() => {
    updateStage(flowId, stage.id, {
      provider: selectedProvider,
      providerConfig: localConfig,
      executionCondition: celEnabled && celExpression.trim() ? celExpression.trim() : undefined,
    });
  }, [updateStage, flowId, stage.id, selectedProvider, localConfig, celEnabled, celExpression]);

  const handleReset = useCallback(() => {
    setSelectedProvider(stage.provider);
    setLocalConfig(stage.providerConfig ?? {});
  }, [stage.provider, stage.providerConfig]);

  const handleRemoveStage = useCallback(() => {
    removeStage(flowId, stage.id);
    expandStage(null);
  }, [removeStage, expandStage, flowId, stage.id]);

  // For utility stages and built-in enrichment stages, render dedicated config (no provider dropdown)
  const isUtility = isUtilityStage(stage.type);
  const isBuiltInEnrichment =
    stage.type === 'content-intelligence' || stage.type === 'visual-analysis';

  const renderConfigForm = () => {
    if (isComplex) return null;

    // Built-in enrichment stages have dedicated config components
    if (isBuiltInEnrichment) {
      switch (stage.type) {
        case 'content-intelligence':
          return <ContentIntelligenceConfig config={localConfig} onChange={setLocalConfig} />;
        case 'visual-analysis':
          return <VisualAnalysisConfig config={localConfig} onChange={setLocalConfig} />;
        default:
          return null;
      }
    }

    // Utility stages have dedicated config components
    if (isUtility) {
      switch (stage.type) {
        case 'field-mapping':
          return <FieldMappingConfig config={localConfig} onChange={setLocalConfig} />;
        case 'api-webhook':
          return <ApiStageConfig config={localConfig} onChange={setLocalConfig} />;
        case 'llm-stage':
          return <LlmStageConfig config={localConfig} onChange={setLocalConfig} />;
        default:
          return null;
      }
    }

    switch (selectedProvider) {
      case 'docling':
        return <DoclingConfig config={localConfig} onChange={setLocalConfig} />;
      case 'llamaindex':
        return <LlamaIndexConfig config={localConfig} onChange={setLocalConfig} />;
      case 'recursive-character':
      case 'fixed-size':
        return <ChunkingConfig config={localConfig} onChange={setLocalConfig} />;
      case 'llm-enrichment':
      case 'question-synthesis':
        return (
          <EnrichmentConfig
            provider={selectedProvider}
            config={localConfig}
            onChange={setLocalConfig}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start justify-between border-b border-default px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{stage.name}</h2>
          <span className="mt-0.5 inline-block rounded bg-background-muted px-1.5 py-0.5 text-xs font-medium text-foreground-muted">
            {stageTypeLabel}
          </span>
        </div>
        <button
          onClick={handleRemoveStage}
          className="rounded p-1.5 text-foreground-muted transition-colors hover:bg-error/10 hover:text-error"
          title={t('v2_context_menu_remove')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Config body */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-3">
          {/* Built-in enrichment + utility stages skip the provider dropdown */}
          {!isUtility && !isBuiltInEnrichment && (
            <Select
              label={t('v2_provider_label')}
              placeholder={t('v2_provider_select')}
              value={selectedProvider}
              onChange={handleProviderChange}
              options={providerOptions}
            />
          )}

          {renderConfigForm()}

          {/* ── CEL Execution Condition ── */}
          <div className="mt-4 border-t border-default pt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-foreground-subtle">
                {t('v2_cel_section_title')}
              </span>
              <Toggle
                checked={celEnabled}
                onChange={(v: boolean) => {
                  setCelEnabled(v);
                  if (!v) setCelExpression('');
                }}
              />
            </div>
            <p className="mb-2 text-[11px] text-foreground-muted">{t('v2_cel_section_desc')}</p>
            {celEnabled && (
              <div className="space-y-2">
                <textarea
                  className="w-full rounded-md border border-default bg-background-muted px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-accent"
                  rows={2}
                  placeholder='e.g. document.mimeType == "application/pdf"'
                  value={celExpression}
                  onChange={(e) => setCelExpression(e.target.value)}
                />
                <div className="flex flex-wrap gap-1">
                  {[
                    { label: 'PDF only', expr: 'document.mimeType == "application/pdf"' },
                    { label: 'Large files', expr: 'document.size > 1048576' },
                    {
                      label: 'Rich docs',
                      expr: 'document.mimeType in ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/html"]',
                    },
                    { label: 'Not text', expr: 'document.mimeType != "text/plain"' },
                  ].map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => setCelExpression(preset.expr)}
                      className="rounded-full border border-default px-2 py-0.5 text-[10px] text-foreground-muted transition-colors hover:border-accent hover:text-accent"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <details className="text-[10px] text-foreground-subtle">
                  <summary className="cursor-pointer font-medium">
                    {t('v2_cel_available_vars')}
                  </summary>
                  <pre className="mt-1 rounded bg-background-muted p-2 font-mono leading-relaxed">
                    {`document.name        string
document.mimeType    string
document.extension   string
document.size        number (bytes)
source.connector     string`}
                  </pre>
                </details>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer actions */}
      {!isComplex && (
        <div className="flex gap-2 border-t border-default px-4 py-3">
          <Button size="sm" variant="primary" onClick={handleApply}>
            {t('v2_config_apply')}
          </Button>
          <Button size="sm" variant="ghost" onClick={handleReset}>
            {t('v2_detail_reset')}
          </Button>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// ROUTER OVERVIEW MODE
// =============================================================================

function RouterOverviewMode() {
  const t = useTranslations('search_ai.pipeline');
  const draft = usePipelineStore((s) => s.draft);
  const selectFlow = usePipelineStore((s) => s.selectFlow);
  const closePanel = usePipelineStore((s) => s.closePanel);
  const openRuleBuilder = usePipelineStore((s) => s.openRuleBuilder);

  const flows = useMemo(
    () =>
      [...(draft?.flows ?? [])]
        .filter((f) => f.enabled)
        .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999)),
    [draft?.flows],
  );

  const handleFlowClick = useCallback(
    (flowId: string) => {
      closePanel();
      selectFlow(flowId);
    },
    [closePanel, selectFlow],
  );

  const handleEditRules = useCallback(
    (flowId: string) => {
      closePanel();
      selectFlow(flowId);
      openRuleBuilder();
    },
    [closePanel, selectFlow, openRuleBuilder],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-default px-4 py-3">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-foreground-muted" />
          <h2 className="text-sm font-semibold text-foreground">{t('v2_router_title')}</h2>
        </div>
        <p className="mt-1 text-xs text-foreground-muted">{t('v2_router_description')}</p>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-3">
          {/* Routing waterfall label */}
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-foreground-muted">
            {t('v2_router_priority_order')}
          </div>

          {/* Flow cards in priority order */}
          {flows.map((flow, index) => {
            const stageCount = flow.stages.filter((s) => s.type !== 'embedding').length;
            const hasRules = flow.selectionRules.length > 0;
            const isDefault = flow.isDefault;

            return (
              <div key={flow.id}>
                {/* Flow card */}
                <div
                  className="group cursor-pointer rounded-lg border border-default bg-background p-3 transition-all hover:border-accent hover:shadow-sm"
                  role="button"
                  tabIndex={0}
                  onClick={() => handleFlowClick(flow.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleFlowClick(flow.id);
                    }
                  }}
                >
                  {/* Flow header row */}
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[10px] font-bold text-accent">
                      {flow.priority}
                    </span>
                    <span className="flex-1 truncate text-sm font-medium text-foreground">
                      {flow.name}
                    </span>
                    {isDefault && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                        <Shield className="h-2.5 w-2.5" />
                        {t('v2_router_default_badge')}
                      </span>
                    )}
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-foreground-muted transition-transform group-hover:translate-x-0.5" />
                  </div>

                  {/* Selection rules */}
                  <div className="mt-2 space-y-1">
                    {hasRules ? (
                      flow.selectionRules.map((rule, rIdx) => (
                        <div
                          key={rIdx}
                          className="flex items-start gap-1.5 rounded bg-background-muted px-2 py-1"
                        >
                          <Filter className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
                          <span className="truncate text-xs text-foreground">
                            {formatRuleSummary(rule)}
                          </span>
                        </div>
                      ))
                    ) : (
                      <div className="flex items-center gap-1.5 rounded bg-background-muted px-2 py-1">
                        <span className="text-xs text-foreground-muted">
                          {isDefault
                            ? t('v2_router_catches_remaining')
                            : t('v2_router_no_rules_hint')}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Footer: stage count + edit rules */}
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-[10px] text-foreground-muted">
                      {t('v2_flow_config_stages', { count: stageCount })}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEditRules(flow.id);
                      }}
                      className="rounded px-1.5 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/10"
                    >
                      {t('v2_edit_rules')}
                    </button>
                  </div>
                </div>

                {/* Arrow between cards showing waterfall */}
                {index < flows.length - 1 && (
                  <div className="flex items-center justify-center py-1">
                    <div className="flex items-center gap-1 text-foreground-muted">
                      <ArrowDown className="h-3 w-3" />
                      <span className="text-[10px]">{t('v2_router_no_match')}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* How it works explanation */}
          <div className="mt-4 border-t border-default pt-4">
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-foreground-muted">
              {t('v2_router_how_title')}
            </h4>
            <p className="text-xs leading-relaxed text-foreground-muted">
              {t('v2_router_how_description')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// FLOW CONFIG MODE
// =============================================================================

interface FlowConfigModeProps {
  flow: PipelineFlow;
}

/** Available stage types for "Add Stage" picker */
const ADD_STAGE_TYPES: { type: string; defaultProvider: string; group: 'pipeline' | 'utility' }[] =
  [
    { type: 'extraction', defaultProvider: 'docling', group: 'pipeline' },
    { type: 'chunking', defaultProvider: 'recursive-character', group: 'pipeline' },
    { type: 'content-intelligence', defaultProvider: 'content-intelligence', group: 'pipeline' },
    { type: 'visual-analysis', defaultProvider: 'visual-analysis', group: 'pipeline' },
    { type: 'enrichment', defaultProvider: 'llm-enrichment', group: 'pipeline' },
    { type: 'field-mapping', defaultProvider: 'field-mapping', group: 'utility' },
    { type: 'api-webhook', defaultProvider: 'api-webhook', group: 'utility' },
    { type: 'llm-stage', defaultProvider: 'llm-stage', group: 'utility' },
  ];

/** Render a human-readable summary of a selection rule */
function formatRuleSummary(rule: RuleCondition): string {
  if (rule.type === 'cel' && rule.celExpression) {
    return rule.celExpression;
  }
  if (rule.type === 'simple' && rule.field && rule.operator) {
    const field = rule.field.replace('document.', '').replace('source.', '');
    const op = rule.operator === 'in' ? 'IN' : rule.operator.toUpperCase();
    const val = Array.isArray(rule.value)
      ? (rule.value as string[]).join(', ')
      : String(rule.value ?? '');
    return `${field} ${op} ${val}`;
  }
  if (rule.type === 'compound' && rule.conditions) {
    return `${rule.logic ?? 'AND'} (${rule.conditions.length} conditions)`;
  }
  return 'Custom rule';
}

function FlowConfigMode({ flow }: FlowConfigModeProps) {
  const t = useTranslations('search_ai.pipeline');
  const updateFlow = usePipelineStore((s) => s.updateFlow);
  const removeFlow = usePipelineStore((s) => s.removeFlow);
  const removeStage = usePipelineStore((s) => s.removeStage);
  const addStage = usePipelineStore((s) => s.addStage);
  const expandStage = usePipelineStore((s) => s.expandStage);
  const selectFlow = usePipelineStore((s) => s.selectFlow);
  const openRuleBuilder = usePipelineStore((s) => s.openRuleBuilder);

  const [flowName, setFlowName] = useState(flow.name);
  const [flowDescription, setFlowDescription] = useState(flow.description ?? '');
  const [flowPriority, setFlowPriority] = useState(String(flow.priority));
  const [showAddStageMenu, setShowAddStageMenu] = useState(false);
  const draggedStageIdRef = useRef<string | null>(null);
  const [draggedStageId, setDraggedStageId] = useState<string | null>(null);
  const [dragOverStageId, setDragOverStageId] = useState<string | null>(null);

  const sortedStages = useMemo(
    () =>
      [...flow.stages]
        .filter((s) => s.type !== 'embedding')
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [flow.stages],
  );

  const handleNameBlur = useCallback(() => {
    if (flowName.trim() && flowName !== flow.name) {
      updateFlow(flow.id, { name: flowName.trim() });
    }
  }, [flowName, flow.name, flow.id, updateFlow]);

  const handleDescriptionBlur = useCallback(() => {
    const trimmed = flowDescription.trim();
    if (trimmed !== (flow.description ?? '')) {
      updateFlow(flow.id, { description: trimmed || undefined });
    }
  }, [flowDescription, flow.description, flow.id, updateFlow]);

  const handlePriorityBlur = useCallback(() => {
    const num = parseInt(flowPriority, 10);
    if (!isNaN(num) && num > 0 && num !== flow.priority) {
      updateFlow(flow.id, { priority: num });
    }
  }, [flowPriority, flow.priority, flow.id, updateFlow]);

  const handleToggleEnabled = useCallback(
    (enabled: boolean) => {
      updateFlow(flow.id, { enabled });
    },
    [flow.id, updateFlow],
  );

  const handleDeleteFlow = useCallback(() => {
    if (flow.isDefault) return;
    removeFlow(flow.id);
  }, [flow.id, flow.isDefault, removeFlow]);

  const handleAddStage = useCallback(
    (stageType: string, defaultProvider: string) => {
      const stageId = `stage-${flow.id}-${stageType}-${Date.now()}`;
      addStage(flow.id, {
        id: stageId,
        name: stageType.charAt(0).toUpperCase() + stageType.slice(1),
        type: stageType,
        provider: defaultProvider,
        providerConfig: {},
        onError: 'fail',
      });
      setShowAddStageMenu(false);
      // Auto-select the new stage for configuration
      expandStage(stageId);
    },
    [flow.id, addStage, expandStage],
  );

  const handleDragStart = useCallback((e: DragEvent<HTMLDivElement>, stageId: string) => {
    draggedStageIdRef.current = stageId;
    setDraggedStageId(stageId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', stageId);
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>, stageId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggedStageIdRef.current && draggedStageIdRef.current !== stageId) {
      setDragOverStageId(stageId);
    }
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverStageId(null);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>, targetStageId: string) => {
      e.preventDefault();
      setDragOverStageId(null);
      const draggedId = draggedStageIdRef.current;
      draggedStageIdRef.current = null;
      setDraggedStageId(null);
      if (!draggedId || draggedId === targetStageId) return;

      // Reorder: move dragged stage to the position of the target
      const currentOrder = sortedStages.map((s) => s.id);
      const fromIdx = currentOrder.indexOf(draggedId);
      const toIdx = currentOrder.indexOf(targetStageId);
      if (fromIdx < 0 || toIdx < 0) return;

      // Remove from old position, insert at new position
      currentOrder.splice(fromIdx, 1);
      currentOrder.splice(toIdx, 0, draggedId);

      // Update order fields for all stages in this flow
      const reorderedStages = flow.stages.map((s) => {
        const newOrder = currentOrder.indexOf(s.id);
        if (newOrder >= 0) {
          return { ...s, order: newOrder };
        }
        return s;
      });
      updateFlow(flow.id, { stages: reorderedStages });
    },
    [sortedStages, flow.id, flow.stages, updateFlow],
  );

  const handleDragEnd = useCallback(() => {
    draggedStageIdRef.current = null;
    setDraggedStageId(null);
    setDragOverStageId(null);
  }, []);

  const stageTypeLabel = (type: string) => {
    const key = STAGE_TYPE_KEYS[type];
    return key ? t(key) : type;
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-default px-4 py-3">
        <div className="flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-foreground-muted" />
          <h2 className="text-sm font-semibold text-foreground">{t('v2_flow_config_title')}</h2>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-4">
          {/* Flow Name */}
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground-muted">
              {t('v2_flow_config_name')}
            </label>
            <input
              type="text"
              value={flowName}
              onChange={(e) => setFlowName(e.target.value)}
              onBlur={handleNameBlur}
              className="w-full rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>

          {/* Flow Description */}
          <div>
            <label className="mb-1 block text-xs font-medium text-foreground-muted">
              {t('v2_flow_config_description')}
            </label>
            <textarea
              value={flowDescription}
              onChange={(e) => setFlowDescription(e.target.value)}
              onBlur={handleDescriptionBlur}
              placeholder={t('v2_flow_config_description_placeholder')}
              rows={2}
              className="w-full resize-none rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>

          {/* Priority + Enabled */}
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-foreground-muted">
                {t('v2_flow_config_priority')}
              </label>
              <input
                type="number"
                min={1}
                max={999}
                value={flowPriority}
                onChange={(e) => setFlowPriority(e.target.value)}
                onBlur={handlePriorityBlur}
                className="w-full rounded-md border border-default bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              />
            </div>
            <div>
              <Toggle
                checked={flow.enabled}
                onChange={handleToggleEnabled}
                label={t('v2_flow_config_enabled')}
                disabled={flow.isDefault}
              />
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-default" />

          {/* Selection Rules */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-foreground-muted">
                {t('v2_selection_rules_title')}
              </span>
              <Button
                variant="ghost"
                size="xs"
                icon={<Filter className="h-3 w-3" />}
                onClick={() => {
                  selectFlow(flow.id);
                  openRuleBuilder();
                }}
              >
                {t('v2_edit_rules')}
              </Button>
            </div>
            {flow.selectionRules.length === 0 ? (
              <div className="rounded-md border border-dashed border-default bg-background-muted px-3 py-2">
                <p className="text-xs text-foreground-muted">{t('v2_no_rules')}</p>
              </div>
            ) : (
              <div className="space-y-1">
                {flow.selectionRules.map((rule, idx) => (
                  <div
                    key={idx}
                    className="rounded-md border border-default bg-background px-2.5 py-1.5"
                  >
                    <p className="truncate text-xs text-foreground">{formatRuleSummary(rule)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="border-t border-default" />

          {/* Stages List */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-foreground-muted">
                {t('v2_flow_config_stages', { count: sortedStages.length })}
              </span>
            </div>

            <div className="space-y-1">
              {sortedStages.map((stage) => (
                <div
                  key={stage.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, stage.id)}
                  onDragOver={(e) => handleDragOver(e, stage.id)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, stage.id)}
                  onDragEnd={handleDragEnd}
                  className={`flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 transition-all ${
                    dragOverStageId === stage.id ? 'border-accent shadow-sm' : 'border-default'
                  } ${draggedStageId === stage.id ? 'opacity-50' : 'opacity-100'}`}
                >
                  <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-foreground-muted" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-foreground truncate">
                      {stageTypeLabel(stage.type)}
                    </div>
                    <div className="text-[10px] text-foreground-muted truncate">
                      {stage.provider}
                    </div>
                  </div>
                  <button
                    onClick={() => expandStage(stage.id)}
                    className="rounded p-1 text-foreground-muted hover:bg-background-muted hover:text-foreground"
                    title={t('v2_flow_config_configure_stage')}
                  >
                    <Settings2 className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => removeStage(flow.id, stage.id)}
                    className="rounded p-1 text-foreground-muted hover:bg-error/10 hover:text-error"
                    title={t('v2_flow_config_remove_stage')}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>

            {/* Add Stage */}
            <div className="relative mt-2">
              <Button
                variant="ghost"
                size="sm"
                icon={<Plus className="h-3.5 w-3.5" />}
                onClick={() => setShowAddStageMenu(!showAddStageMenu)}
              >
                {t('v2_add_stage')}
                <ChevronDown
                  className={`ml-auto h-3 w-3 transition-transform ${showAddStageMenu ? 'rotate-180' : ''}`}
                />
              </Button>
              {showAddStageMenu && (
                <div className="mt-1 rounded-md border border-default bg-background-elevated py-1 shadow-lg">
                  <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                    {t('v2_insert_pipeline_stages')}
                  </div>
                  {ADD_STAGE_TYPES.filter((s) => s.group === 'pipeline').map(
                    ({ type, defaultProvider }) => (
                      <button
                        key={type}
                        onClick={() => handleAddStage(type, defaultProvider)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-background-muted"
                      >
                        <span className="font-medium">{stageTypeLabel(type)}</span>
                      </button>
                    ),
                  )}
                  <div className="my-1 border-t border-default" />
                  <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                    {t('v2_insert_utility_stages')}
                  </div>
                  {ADD_STAGE_TYPES.filter((s) => s.group === 'utility').map(
                    ({ type, defaultProvider }) => (
                      <button
                        key={type}
                        onClick={() => handleAddStage(type, defaultProvider)}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-background-muted"
                      >
                        <span className="font-medium">{stageTypeLabel(type)}</span>
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Delete Flow (non-default only) */}
          {!flow.isDefault && (
            <>
              <div className="border-t border-default" />
              <Button
                variant="danger"
                size="sm"
                onClick={handleDeleteFlow}
                icon={<Trash2 className="h-3.5 w-3.5" />}
              >
                {t('v2_flow_config_delete')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function DetailPanel() {
  const t = useTranslations('search_ai.pipeline');
  const draft = usePipelineStore((s) => s.draft);
  const expandedStageId = usePipelineStore((s) => s.expandedStageId);
  const activePanelType = usePipelineStore((s) => s.activePanelType);
  const selectedFlowId = usePipelineStore((s) => s.selectedFlowId);
  const collapsed = usePipelineStore((s) => s.detailPanelCollapsed);
  const toggleDetailPanel = usePipelineStore((s) => s.toggleDetailPanel);

  // Determine mode based on existing store fields
  const mode = useMemo(() => {
    if (activePanelType === 'version') return 'version' as const;
    if (activePanelType === 'router') return 'router' as const;
    if (expandedStageId) return 'stage-config' as const;
    if (activePanelType === 'embedding-config') return 'embedding-info' as const;
    if (selectedFlowId && !expandedStageId) return 'flow-config' as const;
    return 'empty' as const;
  }, [expandedStageId, activePanelType, selectedFlowId]);

  // Find the flow + stage for stage-config mode
  const { flow, stage } = useMemo(() => {
    if (mode !== 'stage-config' || !draft?.flows || !expandedStageId) {
      return { flow: undefined, stage: undefined };
    }
    for (const f of draft.flows) {
      const s = f.stages.find((st) => st.id === expandedStageId);
      if (s) return { flow: f, stage: s };
    }
    return { flow: undefined, stage: undefined };
  }, [mode, draft?.flows, expandedStageId]);

  // Find the selected flow for flow-config mode
  const selectedFlow = useMemo(() => {
    if (mode !== 'flow-config' || !draft?.flows || !selectedFlowId) return undefined;
    return draft.flows.find((f) => f.id === selectedFlowId);
  }, [mode, draft?.flows, selectedFlowId]);

  const renderContent = () => {
    switch (mode) {
      case 'router':
        return <RouterOverviewMode />;
      case 'stage-config':
        if (!flow || !stage) return <EmptyState />;
        return (
          <StageConfigMode key={stage.id} flowName={flow.name} stage={stage} flowId={flow.id} />
        );
      case 'flow-config':
        if (!selectedFlow) return <EmptyState />;
        return <FlowConfigMode key={selectedFlow.id} flow={selectedFlow} />;
      case 'embedding-info':
        return <EmbeddingInfoMode />;
      case 'version':
        return <VersionMode />;
      default:
        return <EmptyState />;
    }
  };

  return (
    <div
      className={`flex h-full shrink-0 flex-col border-l border-default bg-background-elevated transition-all duration-200 ${
        collapsed ? 'w-10' : 'w-[420px]'
      }`}
      role="complementary"
      aria-label={t('v2_detail_panel_label')}
    >
      {/* Toggle button — always visible */}
      <div
        className={`flex items-center pt-2 ${collapsed ? 'justify-center px-0' : 'justify-end px-2'}`}
      >
        <button
          onClick={toggleDetailPanel}
          className="rounded p-1.5 text-foreground-muted transition-colors hover:bg-background-muted hover:text-foreground"
          title={collapsed ? t('v2_detail_panel_expand') : t('v2_detail_panel_collapse')}
        >
          {collapsed ? (
            <PanelRightOpen className="h-4 w-4" />
          ) : (
            <PanelRightClose className="h-4 w-4" />
          )}
        </button>
      </div>
      {/* Content — hidden when collapsed via opacity + overflow */}
      <div
        className={`flex-1 overflow-hidden transition-opacity duration-200 ${
          collapsed ? 'opacity-0' : 'opacity-100'
        }`}
      >
        {!collapsed && renderContent()}
      </div>
    </div>
  );
}
