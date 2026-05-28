/**
 * Node Configuration Panel
 *
 * Right slide-over panel (320px) that opens when a pipeline node is selected.
 * Shows editable label, config form via ConfigSchemaForm, and execution settings.
 *
 * Pattern: follows StageConfigPanel.tsx for slide-over behavior.
 */

'use client';

import { useMemo, useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X, Trash2, Play, ChevronDown, ChevronRight } from 'lucide-react';
import { apiFetch } from '../../lib/api-client';
import { JsonViewer } from '../ui/JsonViewer';
import { usePipelineEditorStore } from '../../store/pipeline-editor-store';
import { ConfigSchemaForm } from './ConfigSchemaForm';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import type { NodeTypeDefinition, ConfigField } from '@agent-platform/pipeline-engine';
import { TRIGGER_NODE_ID } from './pipeline-trigger-constants';
import { TriggerConfigPanel } from './TriggerConfigPanel';
import { getAvailableDataNodes } from './available-data';

// =============================================================================
// Types
// =============================================================================

export interface NodeConfigPanelProps {
  /** Map of activity type -> NodeTypeDefinition with configSchema */
  nodeTypes: Map<string, NodeTypeDefinition>;
  /** Current project ID for model selection */
  projectId?: string | null;
}

// =============================================================================
// Constants
// =============================================================================

const ON_FAILURE_OPTIONS = [
  { value: 'stop', label: 'Stop Pipeline' },
  { value: 'skip', label: 'Skip Node' },
  { value: 'continue', label: 'Continue' },
];

const CUSTOM_PIPELINE_RESULTS_TABLE = 'abl_platform.custom_pipeline_results';
const CUSTOM_PIPELINE_RESULTS_COLLECTION = 'custom_pipeline_results';
const PREFERRED_SCORE_FIELDS = ['overallScore', 'score', 'rating', 'value', 'confidence'];

function normalizeStoreResultsField(
  field: ConfigField,
  values: Record<string, unknown>,
): ConfigField {
  const destination = String(values.destination ?? '').toLowerCase();

  if ((field.name === 'table' || field.name === 'collection') && destination === 'clickhouse') {
    return {
      ...field,
      label: 'Table',
      description: `Leave empty to use ${CUSTOM_PIPELINE_RESULTS_TABLE}, or enter an existing database.table for a custom ClickHouse table.`,
      placeholder: `Default: ${CUSTOM_PIPELINE_RESULTS_TABLE}`,
    };
  }

  if ((field.name === 'table' || field.name === 'collection') && destination === 'mongodb') {
    return {
      ...field,
      label: 'Collection',
      description: `Leave empty to use ${CUSTOM_PIPELINE_RESULTS_COLLECTION}, or enter an existing collection name for a custom MongoDB collection.`,
      placeholder: `Default: ${CUSTOM_PIPELINE_RESULTS_COLLECTION}`,
    };
  }

  if (field.name === '__destination_clickhouse_hint') {
    return {
      ...field,
      type: 'info',
      description: `Leave Table empty to use ${CUSTOM_PIPELINE_RESULTS_TABLE}. Enter an existing database.table only when you want this node to write to a custom ClickHouse table.`,
      intent: 'info',
    };
  }

  if (field.name === '__preview_unsupported_mongo') {
    return {
      ...field,
      type: 'info',
      description: `Leave Collection empty to use ${CUSTOM_PIPELINE_RESULTS_COLLECTION}. Enter an existing collection name only when you want this node to write to a custom MongoDB collection. Preview is not supported because the Observability Preview tab reads from ClickHouse only.`,
      intent: 'warning',
    };
  }

  return field;
}

function isNumericAvailableField(type: string): boolean {
  return ['number', 'integer', 'float', 'double', 'Float64', 'Int64', 'UInt64'].includes(type);
}

function scoreFieldRank(fieldPath: string): number {
  const directRank = PREFERRED_SCORE_FIELDS.indexOf(fieldPath);
  if (directRank >= 0) return directRank;
  const leaf = fieldPath.split('.').at(-1) ?? fieldPath;
  const leafRank = PREFERRED_SCORE_FIELDS.indexOf(leaf);
  return leafRank >= 0 ? leafRank + PREFERRED_SCORE_FIELDS.length : 999;
}

// =============================================================================
// Component
// =============================================================================

export function NodeConfigPanel({ nodeTypes, projectId }: NodeConfigPanelProps) {
  const t = useTranslations('pipelines');

  const selectedNodeId = usePipelineEditorStore((s) => s.selectedNodeId);
  const isConfigPanelOpen = usePipelineEditorStore((s) => s.isConfigPanelOpen);
  const nodes = usePipelineEditorStore((s) => s.nodes);
  const edges = usePipelineEditorStore((s) => s.edges);
  const pipelineId = usePipelineEditorStore((s) => s.pipelineId);

  // Preview state
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSession, setPreviewSession] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewResult, setPreviewResult] = useState<{
    output: Record<string, unknown>;
    skippedNodes: string[];
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [activeExpressionTarget, setActiveExpressionTarget] = useState<{
    fieldName: string;
    insert: (text: string) => void;
  } | null>(null);
  const updateNodeData = usePipelineEditorStore((s) => s.updateNodeData);
  const renameNode = usePipelineEditorStore((s) => s.renameNode);
  const removeNode = usePipelineEditorStore((s) => s.removeNode);
  const clearSelection = usePipelineEditorStore((s) => s.clearSelection);

  // Find the selected node
  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null;
    return nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [selectedNodeId, nodes]);

  const nodeData = selectedNode?.data as Record<string, unknown> | undefined;
  const activityType = (nodeData?.activityType as string) ?? '';
  const nodeTypeDef = activityType ? (nodeTypes.get(activityType) ?? null) : null;

  // Current config values
  const configValues = useMemo<Record<string, unknown>>(() => {
    return (nodeData?.config as Record<string, unknown>) ?? {};
  }, [nodeData]);

  // Config schema fields
  const configFields = useMemo<ConfigField[]>(() => {
    if (!nodeTypeDef?.configSchema?.fields) return [];
    if (activityType !== 'store-results') return nodeTypeDef.configSchema.fields;
    return nodeTypeDef.configSchema.fields.map((field) =>
      normalizeStoreResultsField(field, configValues),
    );
  }, [activityType, configValues, nodeTypeDef]);

  const availableDataNodes = useMemo(() => {
    if (!selectedNodeId) return [];
    return getAvailableDataNodes(nodes, edges, selectedNodeId);
  }, [edges, nodes, selectedNodeId]);

  const handleLabelChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!selectedNodeId) return;
      renameNode(selectedNodeId, e.target.value);
    },
    [selectedNodeId, renameNode],
  );

  const updateNodeConfig = usePipelineEditorStore((s) => s.updateNodeConfig);

  const handleConfigChange = useCallback(
    (key: string, value: unknown) => {
      if (!selectedNodeId) return;
      updateNodeConfig(selectedNodeId, key, value);
    },
    [selectedNodeId, updateNodeConfig],
  );

  const handleExpressionFocus = useCallback((fieldName: string, insert: (text: string) => void) => {
    setActiveExpressionTarget({ fieldName, insert });
  }, []);

  const handleAvailableFieldClick = useCallback(
    (path: string) => {
      if (activeExpressionTarget) {
        activeExpressionTarget.insert(path);
        return;
      }
      void navigator.clipboard?.writeText(path);
    },
    [activeExpressionTarget],
  );

  const applyScoreSuggestion = useCallback(
    (sourceReferenceName: string, fieldPath: string) => {
      if (!selectedNodeId) return;
      updateNodeConfig(selectedNodeId, 'storageStrategy', 'score_and_document');
      updateNodeConfig(selectedNodeId, 'destination', 'clickhouse');
      updateNodeConfig(selectedNodeId, 'sourceStep', sourceReferenceName);
      updateNodeConfig(
        selectedNodeId,
        'scorePath',
        `steps.${sourceReferenceName}.output.${fieldPath}`,
      );
      updateNodeConfig(selectedNodeId, 'scoreName', fieldPath.split('.').at(-1) ?? fieldPath);
      updateNodeConfig(selectedNodeId, 'documentPath', `steps.${sourceReferenceName}.output`);
    },
    [selectedNodeId, updateNodeConfig],
  );

  const applyDocumentSuggestion = useCallback(
    (sourceReferenceName: string) => {
      if (!selectedNodeId) return;
      updateNodeConfig(selectedNodeId, 'storageStrategy', 'document_only');
      updateNodeConfig(selectedNodeId, 'destination', 'mongodb');
      updateNodeConfig(selectedNodeId, 'sourceStep', sourceReferenceName);
      updateNodeConfig(selectedNodeId, 'documentPath', `steps.${sourceReferenceName}.output`);
    },
    [selectedNodeId, updateNodeConfig],
  );

  const applyInspectSuggestion = useCallback(
    (sourceReferenceName: string, fieldPath?: string) => {
      if (!selectedNodeId) return;
      updateNodeConfig(selectedNodeId, 'sourceStep', sourceReferenceName);
      updateNodeConfig(selectedNodeId, 'fieldPath', fieldPath ?? undefined);
    },
    [selectedNodeId, updateNodeConfig],
  );

  const scoreSuggestions = useMemo(
    () =>
      availableDataNodes
        .flatMap((sourceNode) =>
          sourceNode.fields
            .filter((field) => isNumericAvailableField(field.type))
            .map((field) => ({ sourceNode, field })),
        )
        .sort((a, b) => {
          const rankDelta = scoreFieldRank(a.field.fieldPath) - scoreFieldRank(b.field.fieldPath);
          return rankDelta !== 0 ? rankDelta : a.field.fieldPath.localeCompare(b.field.fieldPath);
        }),
    [availableDataNodes],
  );

  const handleTimeoutChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!selectedNodeId) return;
      const raw = e.target.value;
      updateNodeData(selectedNodeId, {
        timeout: raw === '' ? undefined : Number(raw),
      });
    },
    [selectedNodeId, updateNodeData],
  );

  const handleRetriesChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!selectedNodeId) return;
      const raw = e.target.value;
      updateNodeData(selectedNodeId, {
        retries: raw === '' ? undefined : Number(raw),
      });
    },
    [selectedNodeId, updateNodeData],
  );

  const handleOnFailureChange = useCallback(
    (value: string) => {
      if (!selectedNodeId) return;
      updateNodeData(selectedNodeId, { onFailure: value });
    },
    [selectedNodeId, updateNodeData],
  );

  const handleRemoveNode = useCallback(() => {
    if (!selectedNodeId) return;
    removeNode(selectedNodeId);
  }, [selectedNodeId, removeNode]);

  const handlePreview = useCallback(async () => {
    if (!selectedNodeId || !projectId || !pipelineId || !previewSession.trim()) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewResult(null);
    try {
      const resp = await apiFetch(
        `/api/runtime/projects/${encodeURIComponent(projectId)}/pipeline-observability/pipelines/${encodeURIComponent(pipelineId)}/preview-node`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId: selectedNodeId, sampleSessionId: previewSession.trim() }),
        },
      );
      const body = (await resp.json()) as {
        success: boolean;
        output?: Record<string, unknown>;
        skippedNodes?: string[];
        error?: { message?: string };
      };
      if (!body.success) {
        setPreviewError(body.error?.message ?? 'Preview failed');
      } else {
        setPreviewResult({ output: body.output ?? {}, skippedNodes: body.skippedNodes ?? [] });
      }
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewLoading(false);
    }
  }, [selectedNodeId, projectId, pipelineId, previewSession]);

  // ── Trigger node: render trigger config panel instead ──
  if (selectedNodeId === TRIGGER_NODE_ID && isConfigPanelOpen) {
    return (
      <div className="w-80 border-l border-default bg-background flex flex-col shrink-0 h-full overflow-hidden">
        {/* Header */}
        <div className="px-4 py-3 border-b border-default shrink-0">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">Trigger Configuration</h3>
            <button
              type="button"
              className="p-1 text-muted hover:text-foreground rounded transition-colors"
              onClick={clearSelection}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-[11px] text-foreground-muted mt-1">
            Choose when this pipeline should run
          </p>
        </div>

        {/* Trigger selection list */}
        <div className="flex-1 overflow-y-auto">
          <TriggerConfigPanel />
        </div>
      </div>
    );
  }

  if (!isConfigPanelOpen || !selectedNode || !nodeData) {
    return null;
  }

  return (
    <div className="w-80 border-l border-default bg-background flex flex-col shrink-0 h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-default shrink-0">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-foreground">{t('editor_config_panel')}</h3>
          <button
            type="button"
            className="p-1 text-muted hover:text-foreground rounded transition-colors"
            onClick={clearSelection}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Node label - editable */}
        <Input
          type="text"
          value={String(nodeData.label ?? '')}
          onChange={handleLabelChange}
          placeholder="Node label"
          className="!text-sm !font-medium"
        />

        {/* Activity type badge */}
        {activityType && (
          <div className="mt-2">
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-background-muted text-foreground-muted border border-default">
              {activityType}
            </span>
          </div>
        )}
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* Config schema form */}
        {configFields.length > 0 && (
          <div className="px-4 py-4 border-b border-default">
            <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-3">
              {t('config_section_parameters')}
            </h4>
            <ConfigSchemaForm
              fields={configFields}
              values={configValues}
              onChange={handleConfigChange}
              projectId={projectId}
              currentNodeId={selectedNodeId ?? undefined}
              onExpressionFocus={handleExpressionFocus}
            />
          </div>
        )}

        {activityType === 'store-results' && availableDataNodes.length > 0 && (
          <div className="px-4 py-4 border-b border-default">
            <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-2">
              Save Suggestions
            </h4>
            <div className="space-y-3">
              <div className="rounded-md border border-default bg-background-muted/40 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-medium text-foreground">ClickHouse Score</p>
                    <p className="text-[11px] text-muted">
                      Stores one numeric analytics score, preferably overallScore.
                    </p>
                  </div>
                  <span className="text-[10px] text-muted font-mono shrink-0">score_value</span>
                </div>
                {scoreSuggestions.length === 0 ? (
                  <p className="mt-2 text-[11px] text-warning">
                    No numeric score fields declared upstream. Save the document to MongoDB or add a
                    transform node that outputs overallScore.
                  </p>
                ) : (
                  <div className="mt-2 space-y-1.5">
                    {scoreSuggestions.slice(0, 4).map(({ sourceNode, field }) => (
                      <button
                        key={`${sourceNode.id}:${field.fieldPath}`}
                        type="button"
                        className="w-full rounded border border-default bg-background px-2 py-1.5 text-left hover:bg-background-muted transition-colors"
                        onClick={() =>
                          applyScoreSuggestion(sourceNode.referenceName, field.fieldPath)
                        }
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-foreground truncate">
                            {field.fieldPath}
                          </span>
                          <span className="text-[10px] text-muted font-mono">{field.type}</span>
                        </div>
                        <p className="text-[10px] text-muted font-mono truncate">
                          steps.{sourceNode.referenceName}.output.{field.fieldPath}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-md border border-default bg-background-muted/40 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-medium text-foreground">MongoDB Document</p>
                    <p className="text-[11px] text-muted">
                      Stores the full upstream output as the audit/document payload.
                    </p>
                  </div>
                  <span className="text-[10px] text-muted font-mono shrink-0">
                    {CUSTOM_PIPELINE_RESULTS_COLLECTION}
                  </span>
                </div>
                <div className="mt-2 space-y-1.5">
                  {availableDataNodes.map((sourceNode) => (
                    <button
                      key={sourceNode.id}
                      type="button"
                      className="w-full rounded border border-default bg-background px-2 py-1.5 text-left hover:bg-background-muted transition-colors"
                      onClick={() => applyDocumentSuggestion(sourceNode.referenceName)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-foreground truncate">{sourceNode.label}</span>
                        <span className="text-[10px] text-muted font-mono">object</span>
                      </div>
                      <p className="text-[10px] text-muted font-mono truncate">
                        steps.{sourceNode.referenceName}.output
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {activityType === 'inspect-output' && availableDataNodes.length > 0 && (
          <div className="px-4 py-4 border-b border-default">
            <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-2">
              Inspect Source
            </h4>
            <div className="space-y-2">
              {availableDataNodes.map((sourceNode) => (
                <div
                  key={sourceNode.id}
                  className="rounded-md border border-default bg-background-muted/40 p-2"
                >
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => applyInspectSuggestion(sourceNode.referenceName)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-foreground truncate">
                        {sourceNode.label}
                      </span>
                      <span className="text-[10px] text-muted font-mono shrink-0">full output</span>
                    </div>
                    <p className="text-[10px] text-muted font-mono truncate">
                      {sourceNode.referenceName}
                    </p>
                  </button>
                  {sourceNode.fields.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {sourceNode.fields.slice(0, 6).map((field) => (
                        <button
                          key={field.fieldPath}
                          type="button"
                          className="rounded border border-default bg-background px-1.5 py-1 text-[10px] text-foreground-muted hover:text-foreground hover:bg-background-muted"
                          onClick={() =>
                            applyInspectSuggestion(sourceNode.referenceName, field.fieldPath)
                          }
                        >
                          {field.fieldPath}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Available upstream data */}
        <div className="px-4 py-4 border-b border-default">
          <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-2">
            Available Data
          </h4>
          {availableDataNodes.length === 0 && (
            <p className="text-xs text-muted leading-relaxed">
              Connect a previous node to make its output fields available here.
            </p>
          )}
          {availableDataNodes.length > 0 && (
            <div className="space-y-3">
              {availableDataNodes.map((sourceNode) => (
                <div
                  key={sourceNode.id}
                  className="rounded-md border border-default bg-background-muted/40"
                >
                  <div className="px-2.5 py-2 border-b border-default">
                    <div className="text-xs font-medium text-foreground truncate">
                      {sourceNode.label}
                    </div>
                    <div className="text-[10px] text-muted font-mono truncate">
                      {sourceNode.activityType} · {sourceNode.referenceName}
                    </div>
                  </div>
                  {sourceNode.fields.length === 0 ? (
                    <p className="px-2.5 py-2 text-xs text-muted">No declared output fields.</p>
                  ) : (
                    <div className="divide-y divide-default">
                      {sourceNode.fields.map((field) => (
                        <button
                          key={field.path}
                          type="button"
                          className="w-full px-2.5 py-2 text-left hover:bg-background-muted transition-colors"
                          title={field.path}
                          onClick={() => handleAvailableFieldClick(field.path)}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-foreground truncate">
                              {field.fieldPath}
                            </span>
                            <span className="text-[10px] text-muted font-mono shrink-0">
                              {field.type}
                            </span>
                          </div>
                          {field.description && (
                            <p className="mt-0.5 text-[11px] text-muted line-clamp-2">
                              {field.description}
                            </p>
                          )}
                          <p className="mt-1 text-[10px] text-foreground-subtle font-mono truncate">
                            {activeExpressionTarget
                              ? `Click to insert into ${activeExpressionTarget.fieldName}`
                              : field.path}
                          </p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Execution settings */}
        <div className="px-4 py-4">
          <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-3">
            Settings
          </h4>
          <div className="space-y-4">
            <Input
              type="number"
              label="Timeout (ms)"
              value={nodeData.timeout != null ? String(nodeData.timeout) : ''}
              onChange={handleTimeoutChange}
              placeholder={
                nodeTypeDef?.defaultTimeout ? `Default: ${nodeTypeDef.defaultTimeout}` : '60000'
              }
              min={0}
            />

            <Input
              type="number"
              label="Retries"
              value={nodeData.retries != null ? String(nodeData.retries) : ''}
              onChange={handleRetriesChange}
              placeholder={
                nodeTypeDef?.defaultRetries != null ? `Default: ${nodeTypeDef.defaultRetries}` : '0'
              }
              min={0}
              max={10}
            />

            <Select
              label="On Failure"
              options={ON_FAILURE_OPTIONS}
              value={String(nodeData.onFailure ?? 'stop')}
              onChange={handleOnFailureChange}
            />
          </div>
        </div>

        {/* Live preview (P7) */}
        <div className="px-4 py-3 border-t border-default">
          <button
            type="button"
            className="w-full flex items-center gap-1.5 text-xs font-medium text-foreground-muted hover:text-foreground transition-colors"
            onClick={() => setPreviewOpen((v) => !v)}
          >
            {previewOpen ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
            Preview output
          </button>
          {previewOpen && (
            <div className="mt-3 space-y-2">
              <input
                type="text"
                value={previewSession}
                onChange={(e) => setPreviewSession(e.target.value)}
                placeholder="Session ID (e.g. sdk_abc123)"
                className="w-full text-xs rounded border border-input bg-background px-2 py-1.5 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <button
                type="button"
                onClick={handlePreview}
                disabled={previewLoading || !previewSession.trim()}
                className="w-full inline-flex items-center justify-center gap-1.5 px-2 py-1.5 text-xs font-medium rounded border border-accent/30 text-accent hover:bg-accent/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {previewLoading ? (
                  <div className="w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Play className="w-3 h-3" />
                )}
                {previewLoading ? 'Running…' : 'Run preview'}
              </button>
              {previewError && (
                <p className="text-xs text-error bg-error-subtle rounded px-2 py-1.5">
                  {previewError}
                </p>
              )}
              {previewResult && (
                <div className="space-y-1">
                  {previewResult.skippedNodes.length > 0 && (
                    <p className="text-xs text-foreground-subtle">
                      Skipped (write/external): {previewResult.skippedNodes.join(', ')}
                    </p>
                  )}
                  <div className="rounded border border-default overflow-hidden">
                    <JsonViewer data={previewResult.output} copyable />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Remove node */}
        <div className="px-4 py-4 border-t border-default">
          <button
            type="button"
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-error hover:bg-error-subtle border border-error/20 rounded-md transition-colors"
            onClick={handleRemoveNode}
          >
            <Trash2 className="w-3.5 h-3.5" />
            Remove Node
          </button>
        </div>
      </div>
    </div>
  );
}
