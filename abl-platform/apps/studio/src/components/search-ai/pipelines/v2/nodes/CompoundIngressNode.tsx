/**
 * Compound Ingress Node
 *
 * Combines Documents + Content Router into one compact node.
 * Tier 2 visual: muted styling, dashed border, non-interactive.
 * Shows: FileText icon + "Documents" + divider + GitBranch icon + "Content Router" + flow count badge.
 * Single source Handle on right side.
 */

import { memo, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useTranslations } from 'next-intl';
import { FileText, GitBranch } from 'lucide-react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import { usePipelineStore } from '../../../../../store/pipeline-store';
import type { V2NodeData } from '../graph-builder';

function CompoundIngressNodeInner({ id, data }: NodeProps) {
  const t = useTranslations('search_ai.pipeline');
  const styles = getIntentStyles('muted');
  const nodeData = data as V2NodeData;
  const flowCount = (nodeData.flowCount as number) ?? 0;
  const openPanel = usePipelineStore((s) => s.openPanel);
  const expandStage = usePipelineStore((s) => s.expandStage);
  const selectFlow = usePipelineStore((s) => s.selectFlow);

  const handleClick = useCallback(() => {
    // Open the router overview panel
    expandStage(null);
    selectFlow(null);
    openPanel('router', id);
  }, [expandStage, selectFlow, openPanel, id]);

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
      className={`w-[200px] cursor-pointer rounded-lg border border-dashed px-4 py-3 transition-shadow hover:shadow-md ${styles.bgSubtle} ${styles.border}`}
    >
      {/* Documents row */}
      <div className="flex items-center gap-2">
        <FileText className={`h-4 w-4 ${styles.text}`} />
        <span className="text-sm font-medium text-foreground">{t('v2_document_ingress')}</span>
      </div>

      {/* Divider */}
      <div className="my-1.5 border-t border-dashed border-border" />

      {/* Content Router row */}
      <div className="flex items-center gap-2">
        <GitBranch className={`h-4 w-4 ${styles.text}`} />
        <span className="text-sm font-medium text-foreground">{t('v2_content_router')}</span>
        {flowCount > 0 ? (
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-xs ${styles.bgSubtle} ${styles.text}`}
          >
            {t('v2_flows_count', { count: flowCount })}
          </span>
        ) : null}
      </div>

      <Handle type="source" position={Position.Right} className="h-2 w-2" />
    </div>
  );
}

export const CompoundIngressNode = memo(CompoundIngressNodeInner);
