/**
 * StepTypeSelector Component
 *
 * Modal/dropdown that lets the user pick from 9 available workflow step types.
 * Each type is displayed in a 3-column grid with icon, label, and description.
 */

'use client';

import { useCallback, useEffect, useRef } from 'react';
import { clsx } from 'clsx';
import {
  Plug,
  Globe,
  Bot,
  GitBranch,
  Clock,
  Repeat,
  GitMerge,
  UserCheck,
  Wand2,
  Wrench,
  Webhook,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// =============================================================================
// TYPES
// =============================================================================

type StepType =
  | 'connector_action'
  | 'http'
  | 'tool_call'
  | 'async_webhook'
  | 'agent_invocation'
  | 'condition'
  | 'delay'
  | 'loop'
  | 'parallel'
  | 'approval'
  | 'transform';

interface StepTypeConfig {
  type: StepType;
  label: string;
  description: string;
  icon: LucideIcon;
}

interface StepTypeSelectorProps {
  onSelect: (type: string) => void;
  onClose: () => void;
}

// =============================================================================
// STEP TYPE DEFINITIONS
// =============================================================================

const STEP_TYPES: StepTypeConfig[] = [
  {
    type: 'connector_action',
    label: 'Connector Action',
    description: 'Execute an action through a connected service',
    icon: Plug,
  },
  {
    type: 'http',
    label: 'HTTP Request',
    description: 'Make an HTTP API call',
    icon: Globe,
  },
  {
    type: 'tool_call',
    label: 'Tool Call',
    description: 'Invoke a registered tool by name',
    icon: Wrench,
  },
  {
    type: 'async_webhook',
    label: 'Async Webhook',
    description: 'Send a webhook and wait for a callback',
    icon: Webhook,
  },
  {
    type: 'agent_invocation',
    label: 'Agent Invocation',
    description: 'Invoke an AI agent',
    icon: Bot,
  },
  {
    type: 'condition',
    label: 'Condition',
    description: 'Branch based on a condition',
    icon: GitBranch,
  },
  {
    type: 'delay',
    label: 'Delay',
    description: 'Wait for a specified duration',
    icon: Clock,
  },
  {
    type: 'loop',
    label: 'Loop',
    description: 'Iterate over a collection',
    icon: Repeat,
  },
  {
    type: 'parallel',
    label: 'Parallel',
    description: 'Execute branches in parallel',
    icon: GitMerge,
  },
  {
    type: 'approval',
    label: 'Approval',
    description: 'Wait for human approval',
    icon: UserCheck,
  },
  {
    type: 'transform',
    label: 'Transform',
    description: 'Transform data with expressions',
    icon: Wand2,
  },
];

// =============================================================================
// COMPONENT
// =============================================================================

export function StepTypeSelector({ onSelect, onClose }: StepTypeSelectorProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) {
        onClose();
      }
    },
    [onClose],
  );

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay animate-fade-in"
    >
      <div className="bg-background-elevated border border-default rounded-xl shadow-xl w-full max-w-2xl mx-4 animate-fade-in-scale">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-default">
          <h3 className="text-lg font-semibold text-foreground">Add Step</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted hover:text-foreground hover:bg-background-muted transition-fast"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Grid */}
        <div className="p-5 grid grid-cols-3 gap-3">
          {STEP_TYPES.map((stepType) => {
            const IconComponent = stepType.icon;
            return (
              <button
                key={stepType.type}
                onClick={() => onSelect(stepType.type)}
                className={clsx(
                  'flex flex-col items-start gap-2 p-4 rounded-lg border border-default',
                  'bg-background-subtle hover:bg-background-muted hover:border-accent/50',
                  'transition-default text-left group cursor-pointer',
                  'focus-ring',
                )}
              >
                <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-accent-subtle text-accent group-hover:bg-accent group-hover:text-accent-foreground transition-default">
                  <IconComponent className="w-4 h-4" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">{stepType.label}</p>
                  <p className="text-xs text-muted mt-0.5 leading-relaxed">
                    {stepType.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
