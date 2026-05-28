/**
 * Shared Stage Node
 *
 * Shared nodes that appear once on the canvas (Embedding, OpenSearch).
 * - Embedding: uses StageNode-like styling (colored bar), clickable → opens embedding config panel
 * - OpenSearch: locked terminal node (muted, non-interactive)
 */

import { memo, useCallback, useMemo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useTranslations } from 'next-intl';
import { Lock, Database } from 'lucide-react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import { usePipelineStore } from '../../../../../store/pipeline-store';
import { getStageNodeStyles } from '../edge-styles';
import type { V2NodeData } from '../graph-builder';

function SharedStageNodeInner({ id, data }: NodeProps) {
  const t = useTranslations('search_ai.pipeline');
  const openPanel = usePipelineStore((s) => s.openPanel);
  const nodeData = data as V2NodeData;
  const stageType = (nodeData.stageType as string) ?? 'neutral';
  const isTerminal = (nodeData as Record<string, unknown>).isTerminal === true;
  const isEmbedding = stageType === 'embedding';

  const stageStyles = useMemo(() => getStageNodeStyles(stageType), [stageType]);
  const mutedStyles = getIntentStyles('muted');

  const handleClick = useCallback(() => {
    if (isEmbedding) {
      openPanel('embedding-config', id);
    }
  }, [isEmbedding, openPanel, id]);

  const interactiveProps = isEmbedding
    ? {
        role: 'button' as const,
        tabIndex: 0,
        onClick: handleClick,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
          }
        },
      }
    : {};

  // Embedding uses StageNode styling; OpenSearch uses locked/muted styling
  if (isTerminal) {
    // OpenSearch — locked, muted, non-interactive
    return (
      <div
        className={`rounded-lg border px-4 py-3 opacity-80 ${mutedStyles.bgSubtle} ${mutedStyles.border}`}
      >
        <Handle id="left" type="target" position={Position.Left} className="h-2 w-2" />
        <Handle id="top" type="target" position={Position.Top} className="h-2 w-2 opacity-0" />
        <div className="flex items-center gap-2">
          <Database className={`h-4 w-4 ${mutedStyles.text}`} />
          <span className="text-sm font-medium text-foreground">{nodeData.label as string}</span>
          <Lock className="h-3 w-3 text-foreground-muted" />
        </div>
        <div className="mt-0.5 text-xs text-foreground-muted">{t('v2_locked')}</div>
      </div>
    );
  }

  // Embedding — exact same styling as StageNode (colored left bar, clean look)
  return (
    <div
      className={`flex w-[220px] rounded-lg border bg-background ${stageStyles.border} cursor-pointer transition-shadow hover:shadow-md`}
      {...interactiveProps}
    >
      {/* Colored left border bar */}
      <div className={`w-1.5 shrink-0 rounded-l-lg ${stageStyles.bg}`} />

      <div className="flex-1 px-3 py-2">
        {/* Directional handles — L/R for horizontal, T/B for L-shape vertical */}
        <Handle id="left" type="target" position={Position.Left} className="h-2 w-2" />
        <Handle id="right" type="source" position={Position.Right} className="h-2 w-2" />
        <Handle id="top" type="target" position={Position.Top} className="h-2 w-2 opacity-0" />
        <Handle
          id="bottom"
          type="source"
          position={Position.Bottom}
          className="h-2 w-2 opacity-0"
        />

        {/* Header — stage type label (matches StageNode) */}
        <div className="flex items-center gap-1.5">
          <span className={`text-xs font-semibold uppercase tracking-wide ${stageStyles.text}`}>
            {t('stage_embedding')}
          </span>
        </div>

        {/* Provider name (matches StageNode label row) */}
        <div className="mt-0.5 text-sm font-medium text-foreground">{nodeData.label as string}</div>
        {/* Model subtitle (matches StageNode provider row) */}
        {nodeData.embeddingModel ? (
          <div className="text-xs text-foreground-muted">{nodeData.embeddingModel as string}</div>
        ) : null}
      </div>
    </div>
  );
}

export const SharedStageNode = memo(SharedStageNodeInner);
