/**
 * StepList Component
 *
 * Ordered list of workflow steps with visual connectors between them.
 * Supports step selection, insertion between steps, and visual branching
 * for parallel and condition step types.
 */

'use client';

import { useState, useCallback } from 'react';
import { clsx } from 'clsx';
import {
  Plus,
  GripVertical,
  Plug,
  Globe,
  Bot,
  GitBranch,
  Clock,
  Repeat,
  GitMerge,
  UserCheck,
  Wand2,
  ChevronRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { WorkflowStep } from '../../../api/workflows';
import { StepTypeSelector } from './StepTypeSelector';

// =============================================================================
// TYPES
// =============================================================================

interface StepListProps {
  steps: WorkflowStep[];
  selectedStepId: string | null;
  onSelectStep: (id: string) => void;
  onAddStep: (afterId: string | null, type: string) => void;
  onReorderSteps: (steps: WorkflowStep[]) => void;
}

// =============================================================================
// STEP TYPE ICON MAP
// =============================================================================

const stepTypeIcons: Record<string, LucideIcon> = {
  connector_action: Plug,
  http: Globe,
  agent_invocation: Bot,
  condition: GitBranch,
  delay: Clock,
  loop: Repeat,
  parallel: GitMerge,
  approval: UserCheck,
  transform: Wand2,
};

const stepTypeLabels: Record<string, string> = {
  connector_action: 'Connector Action',
  http: 'HTTP Request',
  agent_invocation: 'Agent Invocation',
  condition: 'Condition',
  delay: 'Delay',
  loop: 'Loop',
  parallel: 'Parallel',
  approval: 'Approval',
  transform: 'Transform',
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Generate a brief config summary for display in the step list item.
 */
function getConfigSummary(step: WorkflowStep): string | null {
  const config = step.config;
  if (!config) return null;

  switch (step.type) {
    case 'connector_action': {
      const connector = config.connector as string | undefined;
      const action = config.action as string | undefined;
      if (connector && action) return `${connector} / ${action}`;
      if (connector) return connector;
      return null;
    }
    case 'http': {
      const method = config.method as string | undefined;
      const url = config.url as string | undefined;
      if (method && url) return `${method} ${url}`;
      if (url) return url;
      return null;
    }
    case 'agent_invocation': {
      const agent = config.agentId as string | undefined;
      return agent ?? null;
    }
    case 'condition': {
      const expression = config.expression as string | undefined;
      return expression ?? null;
    }
    case 'delay': {
      const duration = config.duration as number | undefined;
      const unit = config.unit as string | undefined;
      if (duration != null && unit) return `${duration} ${unit}`;
      return null;
    }
    case 'loop': {
      const collection = config.collection as string | undefined;
      return collection ?? null;
    }
    case 'parallel': {
      const branches = config.branches as unknown[] | undefined;
      if (Array.isArray(branches)) return `${branches.length} branches`;
      return null;
    }
    case 'approval': {
      const title = config.title as string | undefined;
      return title ?? null;
    }
    case 'transform': {
      const outputVar = config.outputVariable as string | undefined;
      return outputVar ? `=> ${outputVar}` : null;
    }
    default:
      return null;
  }
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

interface InsertButtonProps {
  onClick: () => void;
}

function InsertButton({ onClick }: InsertButtonProps) {
  return (
    <div className="flex items-center justify-center py-1 group/insert">
      <button
        onClick={onClick}
        className={clsx(
          'w-6 h-6 rounded-full border border-dashed border-default',
          'flex items-center justify-center',
          'text-subtle hover:text-accent hover:border-accent hover:bg-accent-subtle',
          'transition-default opacity-0 group-hover/insert:opacity-100',
          'focus-ring',
        )}
        aria-label="Insert step here"
      >
        <Plus className="w-3 h-3" />
      </button>
    </div>
  );
}

interface ConnectorLineProps {
  children?: React.ReactNode;
}

function ConnectorLine({ children }: ConnectorLineProps) {
  return (
    <div className="flex flex-col items-center">
      <div className="w-px h-3 bg-border" />
      {children}
      <div className="w-px h-3 bg-border" />
    </div>
  );
}

interface ConditionBranchesProps {
  step: WorkflowStep;
}

function ConditionBranches({ step }: ConditionBranchesProps) {
  const config = step.config ?? {};
  const thenLabel = (config.thenLabel as string) ?? 'Then';
  const elseLabel = (config.elseLabel as string) ?? 'Else';

  return (
    <div className="ml-8 mt-1 mb-1 flex gap-4">
      <div className="flex items-center gap-1.5 text-xs text-success">
        <ChevronRight className="w-3 h-3" />
        <span>{thenLabel}</span>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-warning">
        <ChevronRight className="w-3 h-3" />
        <span>{elseLabel}</span>
      </div>
    </div>
  );
}

interface ParallelBranchesPreviewProps {
  step: WorkflowStep;
}

function ParallelBranchesPreview({ step }: ParallelBranchesPreviewProps) {
  const branches = ((step.config ?? {}).branches as Array<{ name: string }>) ?? [];
  if (branches.length === 0) return null;

  return (
    <div className="ml-8 mt-1 mb-1 flex flex-wrap gap-2">
      {branches.map((branch, idx) => (
        <div
          key={idx}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-background-muted text-xs text-muted border border-default"
        >
          <GitMerge className="w-3 h-3" />
          <span>{branch.name || `Branch ${idx + 1}`}</span>
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// STEP ITEM
// =============================================================================

interface StepItemProps {
  step: WorkflowStep;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
}

function StepItem({ step, index, isSelected, onSelect }: StepItemProps) {
  const IconComponent = stepTypeIcons[step.type] ?? Wand2;
  const typeLabel = stepTypeLabels[step.type] ?? step.type;
  const summary = getConfigSummary(step);

  return (
    <div>
      <button
        onClick={onSelect}
        className={clsx(
          'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left',
          'transition-default group cursor-pointer',
          'focus-ring',
          isSelected
            ? 'bg-accent-subtle border border-accent/50 shadow-sm'
            : 'bg-background-subtle border border-default hover:bg-background-muted hover:border-accent/30',
        )}
      >
        {/* Drag handle */}
        <div className="text-subtle opacity-0 group-hover:opacity-100 transition-fast cursor-grab">
          <GripVertical className="w-4 h-4" />
        </div>

        {/* Step number */}
        <div
          className={clsx(
            'w-6 h-6 rounded-md flex items-center justify-center text-xs font-semibold shrink-0',
            isSelected ? 'bg-accent text-accent-foreground' : 'bg-background-muted text-muted',
          )}
        >
          {index + 1}
        </div>

        {/* Type icon */}
        <div
          className={clsx(
            'w-7 h-7 rounded-md flex items-center justify-center shrink-0',
            isSelected ? 'bg-accent/20 text-accent' : 'bg-background-muted text-muted',
          )}
        >
          <IconComponent className="w-3.5 h-3.5" />
        </div>

        {/* Name + summary */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground truncate">{step.name || typeLabel}</p>
          {summary && <p className="text-xs text-muted truncate mt-0.5 font-mono">{summary}</p>}
        </div>

        {/* Type label */}
        <span className="text-xs text-subtle shrink-0">{typeLabel}</span>
      </button>

      {/* Branch indicators for special types */}
      {step.type === 'condition' && <ConditionBranches step={step} />}
      {step.type === 'parallel' && <ParallelBranchesPreview step={step} />}
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function StepList({
  steps,
  selectedStepId,
  onSelectStep,
  onAddStep,
  onReorderSteps: _onReorderSteps,
}: StepListProps) {
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [insertAfterId, setInsertAfterId] = useState<string | null>(null);

  const handleOpenSelector = useCallback((afterId: string | null) => {
    setInsertAfterId(afterId);
    setSelectorOpen(true);
  }, []);

  const handleSelectType = useCallback(
    (type: string) => {
      onAddStep(insertAfterId, type);
      setSelectorOpen(false);
      setInsertAfterId(null);
    },
    [insertAfterId, onAddStep],
  );

  const handleCloseSelector = useCallback(() => {
    setSelectorOpen(false);
    setInsertAfterId(null);
  }, []);

  if (steps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <p className="text-sm text-muted mb-4">No steps yet. Add your first step to get started.</p>
        <button
          onClick={() => handleOpenSelector(null)}
          className={clsx(
            'flex items-center gap-2 px-4 py-2 rounded-lg',
            'bg-accent text-accent-foreground hover:opacity-90',
            'transition-default btn-press text-sm font-medium',
            'focus-ring',
          )}
        >
          <Plus className="w-4 h-4" />
          Add Step
        </button>

        {selectorOpen && (
          <StepTypeSelector onSelect={handleSelectType} onClose={handleCloseSelector} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {/* Insert at top */}
      <ConnectorLine>
        <InsertButton onClick={() => handleOpenSelector(null)} />
      </ConnectorLine>

      {steps.map((step, index) => (
        <div key={step.id}>
          <StepItem
            step={step}
            index={index}
            isSelected={selectedStepId === step.id}
            onSelect={() => onSelectStep(step.id)}
          />

          {/* Connector + insert button between steps or at end */}
          <ConnectorLine>
            <InsertButton onClick={() => handleOpenSelector(step.id)} />
          </ConnectorLine>
        </div>
      ))}

      {/* Add step button at the end */}
      <div className="flex justify-center pt-1">
        <button
          onClick={() => handleOpenSelector(steps[steps.length - 1]?.id ?? null)}
          className={clsx(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium',
            'border border-dashed border-default text-muted',
            'hover:border-accent hover:text-accent hover:bg-accent-subtle',
            'transition-default focus-ring',
          )}
        >
          <Plus className="w-3.5 h-3.5" />
          Add Step
        </button>
      </div>

      {selectorOpen && (
        <StepTypeSelector onSelect={handleSelectType} onClose={handleCloseSelector} />
      )}
    </div>
  );
}
