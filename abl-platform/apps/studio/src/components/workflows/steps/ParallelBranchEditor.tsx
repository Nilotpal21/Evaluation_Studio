/**
 * ParallelBranchEditor Component
 *
 * Editor for parallel step branches displayed as side-by-side columns.
 * Each branch has a name input and (placeholder) step list.
 * Includes add/remove branch controls and failure strategy configuration.
 */

'use client';

import { useCallback } from 'react';
import { clsx } from 'clsx';
import { Plus, Trash2, GitMerge, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { WorkflowStep } from '../../../api/workflows';

// =============================================================================
// TYPES
// =============================================================================

interface Branch {
  name: string;
  steps: WorkflowStep[];
}

interface ParallelBranchEditorProps {
  branches: Branch[];
  failureStrategy: string;
  onChange: (branches: Branch[], failureStrategy: string) => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MIN_BRANCHES = 2;

const FAILURE_STRATEGIES = [
  {
    value: 'fail_fast',
    label: 'Fail Fast',
    description: 'Cancel remaining branches when any branch fails',
    icon: AlertTriangle,
  },
  {
    value: 'wait_all',
    label: 'Wait All',
    description: 'Continue until all branches complete, even on failure',
    icon: CheckCircle2,
  },
];

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

interface BranchColumnProps {
  branch: Branch;
  index: number;
  canRemove: boolean;
  onNameChange: (name: string) => void;
  onRemove: () => void;
}

function BranchColumn({ branch, index, canRemove, onNameChange, onRemove }: BranchColumnProps) {
  return (
    <div
      className={clsx(
        'flex-1 min-w-[200px] rounded-lg border border-default bg-background-subtle',
        'flex flex-col',
      )}
    >
      {/* Branch header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-default">
        <GitMerge className="w-3.5 h-3.5 text-accent shrink-0" />
        <input
          type="text"
          value={branch.name}
          onChange={(e) => onNameChange(e.target.value)}
          className={clsx(
            'flex-1 bg-transparent text-sm font-medium text-foreground',
            'border-none outline-none focus:ring-0 p-0',
            'placeholder:text-subtle',
          )}
          placeholder={`Branch ${index + 1}`}
        />
        {canRemove && (
          <button
            onClick={onRemove}
            className="p-1 text-subtle hover:text-error transition-fast rounded"
            aria-label={`Remove branch ${branch.name || index + 1}`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Branch step list (placeholder for now) */}
      <div className="flex-1 p-3">
        {branch.steps.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <p className="text-xs text-subtle mb-2">No steps in this branch</p>
            <div
              className={clsx(
                'px-3 py-1.5 rounded-md border border-dashed border-default',
                'text-xs text-muted',
              )}
            >
              Steps will appear here
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {branch.steps.map((step, stepIdx) => (
              <div
                key={step.id}
                className={clsx(
                  'flex items-center gap-2 px-2.5 py-2 rounded-md',
                  'bg-background-muted border border-default text-sm',
                )}
              >
                <span className="w-5 h-5 rounded flex items-center justify-center bg-background-elevated text-xs text-muted shrink-0">
                  {stepIdx + 1}
                </span>
                <span className="text-foreground truncate text-xs">{step.name || step.type}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export function ParallelBranchEditor({
  branches,
  failureStrategy,
  onChange,
}: ParallelBranchEditorProps) {
  const canRemoveBranch = branches.length > MIN_BRANCHES;

  const handleBranchNameChange = useCallback(
    (index: number, name: string) => {
      const updated = branches.map((b, i) => (i === index ? { ...b, name } : b));
      onChange(updated, failureStrategy);
    },
    [branches, failureStrategy, onChange],
  );

  const handleRemoveBranch = useCallback(
    (index: number) => {
      if (!canRemoveBranch) return;
      const updated = branches.filter((_, i) => i !== index);
      onChange(updated, failureStrategy);
    },
    [branches, failureStrategy, canRemoveBranch, onChange],
  );

  const handleAddBranch = useCallback(() => {
    const newBranch: Branch = {
      name: `Branch ${branches.length + 1}`,
      steps: [],
    };
    onChange([...branches, newBranch], failureStrategy);
  }, [branches, failureStrategy, onChange]);

  const handleStrategyChange = useCallback(
    (strategy: string) => {
      onChange(branches, strategy);
    },
    [branches, onChange],
  );

  return (
    <div className="space-y-5">
      {/* Failure Strategy Selector */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-foreground">Failure Strategy</label>
        <div className="grid grid-cols-2 gap-2">
          {FAILURE_STRATEGIES.map((strategy) => {
            const isSelected = failureStrategy === strategy.value;
            const IconComponent = strategy.icon;
            return (
              <button
                key={strategy.value}
                onClick={() => handleStrategyChange(strategy.value)}
                className={clsx(
                  'flex items-start gap-2.5 p-3 rounded-lg border text-left transition-default',
                  isSelected
                    ? 'border-accent bg-accent-subtle'
                    : 'border-default bg-background-subtle hover:bg-background-muted',
                )}
              >
                <IconComponent
                  className={clsx(
                    'w-4 h-4 mt-0.5 shrink-0',
                    isSelected ? 'text-accent' : 'text-muted',
                  )}
                />
                <div>
                  <p
                    className={clsx(
                      'text-sm font-medium',
                      isSelected ? 'text-accent' : 'text-foreground',
                    )}
                  >
                    {strategy.label}
                  </p>
                  <p className="text-xs text-muted mt-0.5">{strategy.description}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Branch Columns */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-foreground">
            Branches ({branches.length})
          </label>
          <button
            onClick={handleAddBranch}
            className={clsx(
              'flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium',
              'text-accent hover:bg-accent-subtle transition-default',
              'focus-ring',
            )}
          >
            <Plus className="w-3 h-3" />
            Add Branch
          </button>
        </div>

        <div className="flex gap-3 overflow-x-auto pb-2">
          {branches.map((branch, idx) => (
            <BranchColumn
              key={idx}
              branch={branch}
              index={idx}
              canRemove={canRemoveBranch}
              onNameChange={(name) => handleBranchNameChange(idx, name)}
              onRemove={() => handleRemoveBranch(idx)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
