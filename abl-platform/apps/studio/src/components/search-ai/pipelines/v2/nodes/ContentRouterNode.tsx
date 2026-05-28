/**
 * Content Router Node
 *
 * Decision/routing node that distributes documents to flows.
 * Shows a "Content Router" label with flow count badge.
 * Non-interactive for now.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useTranslations } from 'next-intl';
import { GitBranch } from 'lucide-react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import type { V2NodeData } from '../graph-builder';

function ContentRouterNodeInner({ data }: NodeProps) {
  const t = useTranslations('search_ai.pipeline');
  const styles = getIntentStyles('accent');
  const nodeData = data as V2NodeData;
  const flowCount = (nodeData.flowCount as number) ?? 0;

  return (
    <div className={`rounded-lg border-2 px-4 py-3 ${styles.bgSubtle} ${styles.border}`}>
      <Handle type="target" position={Position.Left} className="h-2 w-2" />
      <div className="flex items-center gap-2">
        <GitBranch className={`h-4 w-4 ${styles.text}`} />
        <span className="text-sm font-medium text-foreground">{t('v2_content_router')}</span>
      </div>
      {flowCount > 0 ? (
        <div
          className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs ${styles.bgSubtle} ${styles.text}`}
        >
          {t('v2_flows_count', { count: flowCount })}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} className="h-2 w-2" />
    </div>
  );
}

export const ContentRouterNode = memo(ContentRouterNodeInner);
