/**
 * FlowItem — Individual flow row in the V2 pipeline sidebar.
 *
 * Shows flow name, priority badge, stage count, enabled/disabled status,
 * and default badge. Supports selection and highlight interactions.
 */

'use client';

import { useCallback } from 'react';
import { Layers, Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '../../../../lib/utils';
import { Badge } from '../../../ui/Badge';
import type { PipelineFlow } from '../../../../api/pipelines';

export interface FlowItemProps {
  flow: PipelineFlow;
  isSelected: boolean;
  isHighlighted: boolean;
  onSelect: () => void;
  onHighlight: () => void;
}

export function FlowItem({
  flow,
  isSelected,
  isHighlighted,
  onSelect,
  onHighlight,
}: FlowItemProps) {
  const t = useTranslations('search_ai.pipeline');

  const handleDoubleClick = useCallback(() => {
    onHighlight();
  }, [onHighlight]);

  return (
    <button
      type="button"
      onClick={onSelect}
      onDoubleClick={handleDoubleClick}
      className={cn(
        'w-full text-left px-3 py-2.5 rounded-lg transition-all duration-200',
        'border border-transparent',
        'hover:bg-background-muted',
        isSelected && 'bg-accent-subtle border-l-2 border-l-accent border-accent',
        isHighlighted && 'animate-pulse',
        !flow.enabled && 'opacity-50',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-foreground truncate">{flow.name}</span>
        <Badge variant="default" className="shrink-0">
          {t('v2_sidebar_flow_priority', { priority: flow.priority })}
        </Badge>
      </div>

      <div className="flex items-center gap-2 mt-1.5">
        <span className="flex items-center gap-1 text-xs text-foreground-muted">
          <Layers className="h-3 w-3" />
          {t('v2_sidebar_flow_stages', { count: flow.stages.length })}
        </span>

        {flow.isDefault && (
          <Badge variant="accent" className="text-[10px]">
            {t('v2_sidebar_flow_default')}
          </Badge>
        )}

        {!flow.enabled && (
          <Badge variant="warning" className="text-[10px]">
            {t('v2_sidebar_flow_disabled')}
          </Badge>
        )}
      </div>

      {flow.enabled && (
        <div className="flex items-center gap-1 mt-1">
          <Zap className="h-3 w-3 text-success" />
          <span className="text-[10px] text-success">{t('flow_enabled')}</span>
        </div>
      )}
    </button>
  );
}
