/**
 * Flow Detail Panel
 *
 * Shows the detail view for a selected flow including:
 * - Flow name, priority, enabled toggle
 * - Selection rules summary with edit button
 * - Stages list with configuration and reorder buttons
 * - Validation errors for this flow
 *
 * Reference: docs/searchai/pipelines/design/frontend/UX-PIPELINE-CONFIGURATION.md
 */

import { useMemo, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { usePipelineStore } from '../../../store/pipeline-store';
import type { PipelineFlow, PipelineStage } from '../../../api/pipelines';
import { PipelineCanvas } from './PipelineCanvas';
import { AddStageModal } from './AddStageModal';
import { Toggle } from '../../ui/Toggle';

// Stage type execution order: extraction → chunking → enrichment → embedding → multimodal
const STAGE_TYPE_ORDER: Record<string, number> = {
  extraction: 0,
  chunking: 1,
  enrichment: 2,
  embedding: 3,
  multimodal: 4,
};

/**
 * Calculate the correct insertion order for a new stage based on its type.
 * Inserts after the last stage of the same type, or after all stages of
 * earlier types if no stage of this type exists yet.
 */
function calculateInsertOrder(stages: PipelineStage[], newType: string): number {
  const sorted = [...stages].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const newTypeOrder = STAGE_TYPE_ORDER[newType] ?? 99;

  // Find the last stage whose type order is <= the new type's order
  let insertAfter = -1;
  for (let i = 0; i < sorted.length; i++) {
    const stageTypeOrder = STAGE_TYPE_ORDER[sorted[i].type] ?? 99;
    if (stageTypeOrder <= newTypeOrder) {
      insertAfter = i;
    }
  }

  // Insert after that position; shift all later stages down
  const insertPosition = insertAfter + 1;

  return insertPosition;
}

/**
 * Rebuild stage order values after insertion at a specific position.
 */
function rebuildStageOrders(
  stages: PipelineStage[],
  newStage: PipelineStage,
  insertPosition: number,
): PipelineStage[] {
  const sorted = [...stages].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const result: PipelineStage[] = [];

  for (let i = 0; i < sorted.length; i++) {
    if (i === insertPosition) {
      result.push({ ...newStage, order: i });
    }
    result.push({ ...sorted[i], order: i >= insertPosition ? i + 1 : i });
  }

  // If inserting at the end
  if (insertPosition >= sorted.length) {
    result.push({ ...newStage, order: sorted.length });
  }

  return result;
}

interface FlowDetailProps {
  flow: PipelineFlow;
}

export function FlowDetail({ flow }: FlowDetailProps) {
  const t = useTranslations('search_ai.pipeline');
  const {
    projectId,
    draft,
    updateFlow,
    addStage,
    removeStage,
    moveStage,
    removeFlow,
    openStageConfig,
    openRuleBuilder,
    validationErrors,
    updateStage,
  } = usePipelineStore();

  const [addStageModalOpen, setAddStageModalOpen] = useState(false);

  const isDefault = flow.isDefault;

  // Filter validation errors for this flow.
  // Paths use index-based format (flows[0].stages[1]...) so we match by
  // finding this flow's index in the draft, plus any errors without a path
  // (e.g., publish-time validation errors).
  const flowIndex = draft?.flows.findIndex((f) => f.id === flow.id) ?? -1;
  const flowPathPrefix = `flows[${flowIndex}]`;
  const flowErrors = validationErrors.filter(
    (e) =>
      e.path?.startsWith(flowPathPrefix + '.') ||
      e.path === flowPathPrefix ||
      (e.code === 'PUBLISH_VALIDATION' && !e.path),
  );

  const sortedStages = useMemo(
    () => [...flow.stages].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [flow.stages],
  );

  const handleAddStage = useCallback(
    (type: string, provider: string, description: string) => {
      const insertPosition = calculateInsertOrder(flow.stages, type);

      const newStage: PipelineStage = {
        id: `stage-${Date.now()}`,
        name: `${type.charAt(0).toUpperCase() + type.slice(1)} — ${provider}`,
        type,
        provider,
        providerConfig: {},
        onError: 'fail',
        order: insertPosition,
        description,
      };

      // Rebuild all stage orders to accommodate the new stage
      const reorderedStages = rebuildStageOrders(flow.stages, newStage, insertPosition);

      // Update the entire flow's stages array
      updateFlow(flow.id, { stages: reorderedStages });

      setAddStageModalOpen(false);
      openStageConfig(newStage.id);
    },
    [flow.id, flow.stages, updateFlow, openStageConfig],
  );

  return (
    <div className="p-6 space-y-6">
      {/* Flow header */}
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <input
            type="text"
            value={flow.name}
            onChange={(e) => updateFlow(flow.id, { name: e.target.value })}
            className="text-lg font-semibold text-foreground bg-transparent border-none outline-none w-full"
            placeholder={t('flow_name_placeholder')}
          />
          {flow.description !== undefined && (
            <input
              type="text"
              value={flow.description || ''}
              onChange={(e) => updateFlow(flow.id, { description: e.target.value })}
              className="text-sm text-muted bg-transparent border-none outline-none w-full mt-1"
              placeholder={t('flow_description_placeholder')}
            />
          )}
        </div>
        <div className="flex items-center gap-3 ml-4">
          {isDefault && (
            <span className="px-2 py-0.5 text-xs rounded bg-accent/10 text-accent border border-accent/20">
              {t('flow_system_default')}
            </span>
          )}
          <Toggle
            checked={flow.enabled}
            onChange={(checked) => updateFlow(flow.id, { enabled: checked })}
            label={t('flow_enabled')}
            disabled={isDefault}
          />
          {!isDefault && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">{t('flow_priority')}</span>
              <input
                type="number"
                value={flow.priority}
                onChange={(e) =>
                  updateFlow(flow.id, { priority: parseInt(e.target.value, 10) || 0 })
                }
                className="w-16 px-2 py-1 text-sm border border-default rounded bg-background-elevated text-foreground"
                min={1}
                max={999}
              />
            </label>
          )}
          {!isDefault && (
            <button
              className="text-xs text-error hover:text-error/80"
              onClick={() => removeFlow(flow.id)}
            >
              {t('flow_delete')}
            </button>
          )}
        </div>
      </div>

      {/* Validation errors */}
      {flowErrors.length > 0 && (
        <div className="p-3 rounded-md bg-error-subtle border border-error">
          <p className="text-sm font-medium text-error mb-1">{t('flow_validation_issues')}</p>
          <ul className="text-xs text-error/80 space-y-0.5">
            {flowErrors.map((e, i) => (
              <li key={i}>
                {e.severity === 'warning' ? '⚠' : '✕'} {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Selection Rules */}
      {isDefault ? (
        <section>
          <div className="p-3 rounded-md border border-default bg-background-elevated">
            <p className="text-sm text-muted">{t('flow_default_description')}</p>
          </div>
        </section>
      ) : (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-foreground">{t('flow_selection_rules')}</h3>
            <button
              className="text-xs text-muted hover:text-foreground"
              onClick={() => openRuleBuilder()}
            >
              {t('flow_edit_rules')}
            </button>
          </div>
          <div className="p-3 rounded-md border border-default bg-background-elevated">
            {flow.selectionRules.length === 0 ? (
              <p className="text-sm text-muted">{t('flow_no_rules')}</p>
            ) : (
              <div className="space-y-1">
                {flow.selectionRules.map((rule, i) => (
                  <div key={i} className="text-sm text-foreground">
                    {rule.type === 'simple' && (
                      <span>
                        {rule.field} {rule.operator} {String(rule.value)}
                      </span>
                    )}
                    {rule.type === 'cel' && (
                      <code className="text-xs bg-background-muted px-1 py-0.5 rounded">
                        {rule.celExpression}
                      </code>
                    )}
                    {rule.type === 'compound' && (
                      <span>
                        {rule.logic} (
                        {t('flow_conditions_count', { count: rule.conditions?.length ?? 0 })})
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Visual Canvas */}
      {flow.stages.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-foreground mb-3">{t('flow_pipeline_flow')}</h3>
          <PipelineCanvas flow={flow} />
        </section>
      )}

      {/* Stages */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">
            {t('flow_stages_header', { count: flow.stages.length })}
          </h3>
        </div>
        <div className="space-y-2">
          {sortedStages.map((stage, index) => (
            <StageCard
              key={stage.id}
              stage={stage}
              index={index}
              totalStages={sortedStages.length}
              flowId={flow.id}
              onConfigure={() => openStageConfig(stage.id)}
              onRemove={() => removeStage(flow.id, stage.id)}
              onMoveUp={() => moveStage(flow.id, stage.id, 'up')}
              onMoveDown={() => moveStage(flow.id, stage.id, 'down')}
            />
          ))}
        </div>
        <button
          className="mt-3 w-full px-3 py-2 text-sm border border-dashed border-default rounded-md text-muted hover:text-foreground hover:border-foreground/30"
          onClick={() => setAddStageModalOpen(true)}
        >
          {t('flow_add_stage')}
        </button>
      </section>

      {/* Add Stage Modal */}
      {addStageModalOpen && projectId && (
        <AddStageModal
          projectId={projectId}
          onAdd={handleAddStage}
          onClose={() => setAddStageModalOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Stage Card ─────────────────────────────────────────────────────────

interface StageCardProps {
  stage: PipelineStage;
  index: number;
  totalStages: number;
  flowId: string;
  onConfigure: () => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function StageCard({
  stage,
  index,
  totalStages,
  onConfigure,
  onRemove,
  onMoveUp,
  onMoveDown,
}: StageCardProps) {
  const t = useTranslations('search_ai.pipeline');

  const stageTypeLabels: Record<string, string> = useMemo(
    () => ({
      extraction: t('stage_extraction'),
      chunking: t('stage_chunking'),
      enrichment: t('stage_enrichment'),
      embedding: t('stage_embedding'),
      'knowledge-graph': t('stage_knowledge_graph'),
      multimodal: t('stage_multimodal'),
    }),
    [t],
  );

  return (
    <div className="flex items-center justify-between p-3 rounded-md border border-default bg-background-elevated hover:bg-background-muted group">
      <div className="flex items-center gap-3">
        {/* Move up/down buttons */}
        <div className="flex flex-col gap-0.5">
          <button
            className="text-[10px] text-muted hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed leading-none px-0.5"
            onClick={onMoveUp}
            disabled={index === 0}
            title={t('flow_move_up')}
          >
            ▲
          </button>
          <button
            className="text-[10px] text-muted hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed leading-none px-0.5"
            onClick={onMoveDown}
            disabled={index === totalStages - 1}
            title={t('flow_move_down')}
          >
            ▼
          </button>
        </div>

        <span className="text-xs text-muted w-5 text-center">{index + 1}.</span>
        <div>
          <span className="text-sm font-medium text-foreground">
            {stageTypeLabels[stage.type] || stage.type}
          </span>
          {stage.provider && <span className="text-xs text-muted ml-2">[{stage.provider}]</span>}
          {stage.executionCondition && (
            <span className="text-[10px] text-accent ml-2" title={stage.executionCondition}>
              ⚡ conditional
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          className="text-xs text-muted hover:text-foreground px-2 py-1 rounded hover:bg-background-elevated"
          onClick={onConfigure}
        >
          {t('flow_configure')}
        </button>
        <button
          className="text-xs text-error hover:text-error/80 px-2 py-1 rounded hover:bg-background-elevated"
          onClick={onRemove}
        >
          {t('flow_remove')}
        </button>
      </div>
    </div>
  );
}
