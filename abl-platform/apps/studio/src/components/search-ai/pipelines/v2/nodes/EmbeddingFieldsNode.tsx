/**
 * Embedding Fields Node
 *
 * Field selection gate showing which fields will be embedded.
 * Clicking opens the embedding-fields panel via store action.
 * Styled consistently with StageNode (colored left bar pattern).
 */

import { memo, useCallback, useMemo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useTranslations } from 'next-intl';
import { usePipelineStore } from '../../../../../store/pipeline-store';
import { getStageNodeStyles } from '../edge-styles';

function EmbeddingFieldsNodeInner({ id }: NodeProps) {
  const t = useTranslations('search_ai.pipeline');
  const openPanel = usePipelineStore((s) => s.openPanel);
  const styles = useMemo(() => getStageNodeStyles('embedding'), []);

  const handleClick = useCallback(() => {
    openPanel('embedding-fields', id);
  }, [openPanel, id]);

  return (
    <div
      className={`flex w-[220px] cursor-pointer rounded-lg border bg-background transition-shadow hover:shadow-md ${styles.border}`}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
    >
      {/* Colored left border bar */}
      <div className={`w-1.5 shrink-0 rounded-l-lg ${styles.bg}`} />

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

        {/* Header */}
        <div className="flex items-center gap-1.5">
          <span className={`text-xs font-semibold uppercase tracking-wide ${styles.text}`}>
            {t('v2_embedding_fields')}
          </span>
        </div>

        {/* Summary */}
        <div className="mt-0.5 text-sm font-medium text-foreground">
          {t('v2_field_summary', {
            coreSelected: 2,
            coreTotal: 12,
            commonSelected: 3,
            commonTotal: 9,
          })}
        </div>
      </div>
    </div>
  );
}

export const EmbeddingFieldsNode = memo(EmbeddingFieldsNodeInner);
