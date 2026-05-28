/**
 * Compound Output Node
 *
 * Combines Embedding + OpenSearch into one compact node.
 * Shows stacked list:
 *   - Cpu icon + "Embedding: {model}" with success intent
 *   - Database icon + "OpenSearch" with muted intent
 *   - Status dots next to each
 * Single target Handle on left side.
 * Clickable: onClick opens the embedding config panel via the pipeline store.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useTranslations } from 'next-intl';
import { Cpu, Database } from 'lucide-react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import { usePipelineStore } from '../../../../../store/pipeline-store';
import type { V2NodeData } from '../graph-builder';

function CompoundOutputNodeInner({ data, id }: NodeProps) {
  const t = useTranslations('search_ai.pipeline');
  const openPanel = usePipelineStore((s) => s.openPanel);
  const nodeData = data as V2NodeData;

  const embeddingModel = (nodeData.embeddingModel as string) ?? t('v2_embedding');
  const containerStyles = getIntentStyles('muted');
  const embeddingStyles = getIntentStyles('success');

  function handleClick() {
    openPanel('embedding-fields', id);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      className={`w-[200px] cursor-pointer rounded-lg border px-4 py-3 transition-shadow hover:shadow-md ${containerStyles.bgSubtle} ${containerStyles.border}`}
    >
      <Handle type="target" position={Position.Left} className="h-2 w-2" />

      {/* Embedding row */}
      <div className="flex items-center gap-1.5">
        <Cpu className={`h-3.5 w-3.5 shrink-0 ${embeddingStyles.text}`} />
        <span className="truncate text-xs font-medium text-foreground">
          {t('v2_compound_output_embedding_label', { model: embeddingModel })}
        </span>
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${embeddingStyles.bg}`}
          aria-hidden="true"
        />
      </div>

      {/* OpenSearch row */}
      <div className="mt-1 flex items-center gap-1.5">
        <Database className={`h-3.5 w-3.5 shrink-0 ${containerStyles.text}`} />
        <span className="truncate text-xs font-medium text-foreground">
          {t('v2_compound_output_opensearch_label')}
        </span>
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${containerStyles.bg}`}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

export const CompoundOutputNode = memo(CompoundOutputNodeInner);
