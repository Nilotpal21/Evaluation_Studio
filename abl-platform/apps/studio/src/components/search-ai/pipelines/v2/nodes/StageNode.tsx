/**
 * Stage Node — the main configurable pipeline stage node
 *
 * Shows colored left border bar based on stage type (using design tokens).
 * Header: stage type label (uppercase), provider name.
 * Click anywhere to select (dispatches expandStage to store).
 * Right-click opens context menu (Configure, Move, Duplicate, Remove).
 * When locked: reduced opacity, no click/context handlers.
 */

import { memo, useMemo, useCallback, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useTranslations } from 'next-intl';

import { usePipelineStore } from '../../../../../store/pipeline-store';
import { getStageNodeStyles } from '../edge-styles';
import type { V2NodeData } from '../graph-builder';
import { StageContextMenu } from './StageContextMenu';

function StageNodeInner({ data }: NodeProps) {
  const t = useTranslations('search_ai.pipeline');
  const expandedStageId = usePipelineStore((s) => s.expandedStageId);
  const expandStage = usePipelineStore((s) => s.expandStage);
  const moveStage = usePipelineStore((s) => s.moveStage);
  const removeStage = usePipelineStore((s) => s.removeStage);
  const addStage = usePipelineStore((s) => s.addStage);
  const draft = usePipelineStore((s) => s.draft);

  const nodeData = data as V2NodeData;
  const stageType = nodeData.stageType as string | undefined;
  const stageId = nodeData.stageId as string;
  const flowId = nodeData.flowId as string;
  const isLocked = nodeData.locked === true;
  const isSelected = expandedStageId === stageId;

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const styles = useMemo(
    () => (stageType ? getStageNodeStyles(stageType) : getStageNodeStyles('extraction')),
    [stageType],
  );

  const stageTypeLabels: Record<string, string> = useMemo(
    () => ({
      extraction: t('stage_extraction'),
      chunking: t('stage_chunking'),
      enrichment: t('stage_enrichment'),
      'content-intelligence': t('v2_stage_content_intelligence'),
      'visual-analysis': t('v2_stage_visual_analysis'),
      embedding: t('stage_embedding'),
      'knowledge-graph': t('stage_knowledge_graph'),
      multimodal: t('stage_multimodal'),
      'field-mapping': t('v2_stage_field_mapping'),
      'api-webhook': t('v2_stage_api_webhook'),
      'llm-stage': t('v2_stage_llm_stage'),
    }),
    [t],
  );

  // Find stage's position in flow for move left/right
  const { canMoveLeft, canMoveRight, currentStage } = useMemo(() => {
    if (!draft || !flowId || !stageId)
      return { canMoveLeft: false, canMoveRight: false, currentStage: undefined };
    const flow = draft.flows.find((f) => f.id === flowId);
    if (!flow) return { canMoveLeft: false, canMoveRight: false, currentStage: undefined };
    const stages = flow.stages
      .filter((s) => s.type !== 'embedding')
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const idx = stages.findIndex((s) => s.id === stageId);
    return {
      canMoveLeft: idx > 0,
      canMoveRight: idx >= 0 && idx < stages.length - 1,
      currentStage: stages[idx],
    };
  }, [draft, flowId, stageId]);

  const handleClick = useCallback(() => {
    if (isLocked) return;
    expandStage(stageId);
  }, [isLocked, stageId, expandStage]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isLocked) return;
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY });
    },
    [isLocked],
  );

  const handleConfigure = useCallback(() => {
    expandStage(stageId);
  }, [stageId, expandStage]);

  const handleMoveLeft = useCallback(() => {
    if (flowId && stageId) moveStage(flowId, stageId, 'up');
  }, [flowId, stageId, moveStage]);

  const handleMoveRight = useCallback(() => {
    if (flowId && stageId) moveStage(flowId, stageId, 'down');
  }, [flowId, stageId, moveStage]);

  const handleDuplicate = useCallback(() => {
    if (!currentStage || !flowId) return;
    const newStage = {
      ...currentStage,
      id: `${currentStage.id}-dup-${Date.now()}`,
      name: `${currentStage.name} (Copy)`,
      order: (currentStage.order ?? 0) + 1,
    };
    addStage(flowId, newStage);
  }, [currentStage, flowId, addStage]);

  const handleRemove = useCallback(() => {
    if (flowId && stageId) removeStage(flowId, stageId);
  }, [flowId, stageId, removeStage]);

  const typeLabel = stageType !== undefined ? (stageTypeLabels[stageType] ?? stageType) : '';

  return (
    <>
      <div
        className={`flex w-[220px] rounded-lg border bg-background ${styles.border} ${isLocked ? 'opacity-60' : 'cursor-pointer hover:shadow-md'} transition-shadow ${isSelected ? 'ring-2 ring-accent' : ''}`}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        {/* Colored left border bar */}
        <div className={`w-1.5 shrink-0 rounded-l-lg ${styles.bg}`} />

        <div className="flex-1 px-3 py-2">
          <Handle id="left" type="target" position={Position.Left} className="h-2 w-2" />
          <Handle id="right" type="source" position={Position.Right} className="h-2 w-2" />

          {/* Header */}
          <div className="flex items-center gap-1.5">
            <span className={`text-xs font-semibold uppercase tracking-wide ${styles.text}`}>
              {typeLabel}
            </span>
          </div>

          {/* Provider name */}
          <div className="mt-0.5 text-sm font-medium text-foreground">
            {nodeData.label as string}
          </div>
          {nodeData.provider ? (
            <div className="text-xs text-foreground-muted">{nodeData.provider as string}</div>
          ) : null}
        </div>
      </div>

      {contextMenu && (
        <StageContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          stageId={stageId}
          flowId={flowId}
          canMoveLeft={canMoveLeft}
          canMoveRight={canMoveRight}
          onConfigure={handleConfigure}
          onMoveLeft={handleMoveLeft}
          onMoveRight={handleMoveRight}
          onDuplicate={handleDuplicate}
          onRemove={handleRemove}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}

export const StageNode = memo(StageNodeInner);
