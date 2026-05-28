/**
 * Flows List Sidebar
 *
 * Sidebar showing all flows in the pipeline. Each flow card shows:
 * - Flow name and priority
 * - Enabled/disabled status
 * - Selection rule summary
 * - Stage count
 *
 * Reference: docs/searchai/pipelines/design/frontend/UX-PIPELINE-CONFIGURATION.md
 */

import { useTranslations } from 'next-intl';
import { usePipelineStore } from '../../../store/pipeline-store';
import { Skeleton } from '../../ui/Skeleton';
import type { PipelineFlow } from '../../../api/pipelines';

export function FlowsList() {
  const t = useTranslations('search_ai.pipeline');
  const { draft, isLoading, selectedFlowId, selectFlow, addFlow, openTestSelection } =
    usePipelineStore();

  // Skeleton loading state — 3 placeholder cards
  if (isLoading || !draft) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-3 border-b border-default">
          <Skeleton className="h-4 w-24 mb-2" />
          <Skeleton className="h-3 w-full" />
        </div>
        <div className="flex-1 p-2 space-y-1">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-3 rounded-md">
              <div className="flex items-center justify-between mb-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-8" />
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-14" />
              </div>
            </div>
          ))}
        </div>
        <div className="p-3 border-t border-default">
          <Skeleton className="h-9 w-full rounded-md" />
        </div>
      </div>
    );
  }

  const handleAddFlow = () => {
    const newFlow: PipelineFlow = {
      id: `flow-${Date.now()}`,
      name: `Flow ${draft.flows.length + 1}`,
      description: '',
      enabled: true,
      isDefault: false,
      priority: (draft.flows.length + 1) * 10,
      stages: [],
      selectionRules: [],
    };
    addFlow(newFlow);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-default">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-foreground">
            {t('flows_header', { count: draft.flows.length })}
          </h3>
          <button
            className="text-xs text-muted hover:text-foreground"
            onClick={() => openTestSelection()}
          >
            {t('flows_test_selection')}
          </button>
        </div>
        <p className="text-xs text-muted">{t('flows_description')}</p>
      </div>

      {/* Flow cards */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {draft.flows
          .sort((a, b) => a.priority - b.priority)
          .map((flow) => (
            <FlowCard
              key={flow.id}
              flow={flow}
              isSelected={flow.id === selectedFlowId}
              onSelect={() => selectFlow(flow.id)}
            />
          ))}
      </div>

      {/* Add flow button */}
      <div className="p-3 border-t border-default">
        <button
          className="w-full px-3 py-2 text-sm border border-dashed border-default rounded-md text-muted hover:text-foreground hover:border-foreground/30"
          onClick={handleAddFlow}
        >
          {t('flows_add_flow')}
        </button>
      </div>
    </div>
  );
}

// ─── Flow Card ────────────────────────────────────────────────────────────

interface FlowCardProps {
  flow: PipelineFlow;
  isSelected: boolean;
  onSelect: () => void;
}

function FlowCard({ flow, isSelected, onSelect }: FlowCardProps) {
  const t = useTranslations('search_ai.pipeline');
  const isDefault = flow.isDefault;

  return (
    <button
      className={`w-full text-left p-3 rounded-md transition-colors ${
        isSelected
          ? 'bg-background-elevated border border-foreground/20'
          : 'hover:bg-background-muted border border-transparent'
      }`}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-foreground truncate">{flow.name}</span>
        <span className="text-xs text-muted ml-2 shrink-0">P{flow.priority}</span>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted">
        {!flow.enabled && (
          <span className="px-1.5 py-0.5 rounded bg-error-subtle text-error">
            {t('flows_disabled')}
          </span>
        )}
        {isDefault ? (
          <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent border border-accent/20">
            {t('flow_system_default')}
          </span>
        ) : (
          <span>{t('flow_rules_count', { count: flow.selectionRules.length })}</span>
        )}
        <span>{t('flow_stages_count', { count: flow.stages.length })}</span>
      </div>
    </button>
  );
}
