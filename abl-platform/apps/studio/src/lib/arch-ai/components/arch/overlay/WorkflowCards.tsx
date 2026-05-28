'use client';

import { PlusCircle, Bug, TrendingUp, Network } from 'lucide-react';

interface WorkflowCardsProps {
  onSelect: (prompt: string) => void;
}

const WORKFLOWS = [
  {
    id: 'add-agent',
    icon: PlusCircle,
    title: 'Add Agent',
    description: 'Create a new agent',
    prompt: 'I want to add a new agent to this project',
  },
  {
    id: 'debug',
    icon: Bug,
    title: 'Debug Issue',
    description: 'Diagnose a problem',
    prompt: 'Help me debug an issue in this project',
  },
  {
    id: 'improve',
    icon: TrendingUp,
    title: 'Improve Agent',
    description: 'Optimize an agent',
    prompt: 'Help me improve an agent in this project',
  },
  {
    id: 'review-topo',
    icon: Network,
    title: 'Review Topology',
    description: 'Check agent connections',
    prompt: 'Review my project agent topology',
  },
];

export function WorkflowCards({ onSelect }: WorkflowCardsProps) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {WORKFLOWS.map((w) => (
        <button
          key={w.id}
          onClick={() => onSelect(w.prompt)}
          className="flex items-start gap-3 rounded-xl border border-border bg-background-muted p-3 text-left transition-colors hover:bg-background-elevated hover:border-border-focus/30"
        >
          <w.icon className="mt-0.5 h-4 w-4 shrink-0 text-foreground-muted" />
          <div>
            <p className="text-xs font-medium text-foreground">{w.title}</p>
            <p className="text-xs text-foreground-subtle leading-relaxed">{w.description}</p>
          </div>
        </button>
      ))}
    </div>
  );
}
