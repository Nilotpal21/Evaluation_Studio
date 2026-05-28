'use client';

/**
 * BuildSummaryCard — renders in chat when buildProgress.stage === 'complete'.
 *
 * Shows a compact summary of the build: each agent as a mini-card with
 * name, mode, tool count, and quality status. Tool configs section below.
 * Clickable agent names navigate to the file in the artifact panel.
 */

import { memo } from 'react';
import { clsx } from 'clsx';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';

interface AgentSummary {
  name: string;
  mode?: string;
  toolCount: number;
  hasWarnings: boolean;
}

interface BuildSummaryCardProps {
  agents: AgentSummary[];
  toolCount: number;
  projectName?: string;
}

function modeIcon(mode?: string): string {
  switch (mode) {
    case 'reasoning':
      return '🧠';
    case 'scripted':
      return '📋';
    case 'hybrid':
      return '🔀';
    default:
      return '🤖';
  }
}

function BuildSummaryCardImpl({ agents, toolCount, projectName }: BuildSummaryCardProps) {
  const setActiveTab = useArchAIStore((s) => s.setActiveTab);
  const tabs = useArchAIStore((s) => s.artifactTabs);

  const navigateToAgent = (name: string) => {
    const tab = tabs.find((t) => t.type === 'agent_code' && t.label === name);
    if (tab) setActiveTab(tab.id);
  };

  return (
    <div className="w-full rounded-lg border border-success/30 bg-success/5 p-4 animate-fade-in-up">
      <div className="flex items-center gap-2 mb-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-success/10 text-success text-sm">
          ✓
        </span>
        <h3 className="text-sm font-semibold text-foreground">
          Build Complete{projectName ? ` — ${projectName}` : ''}
        </h3>
      </div>

      {/* Agent grid */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        {agents.map((agent) => (
          <button
            key={agent.name}
            onClick={() => navigateToAgent(agent.name)}
            className="flex items-center gap-2 rounded-md bg-background/50 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-background"
          >
            <span>{modeIcon(agent.mode)}</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{agent.name}</div>
              <div className="text-foreground-muted">
                {agent.toolCount > 0 ? `${agent.toolCount} tools` : 'No tools'}
                {agent.hasWarnings && <span className="ml-1 text-warning">⚠</span>}
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* Tool configs summary */}
      {toolCount > 0 && (
        <div className="border-t border-success/10 pt-2 text-xs text-foreground-muted">
          {toolCount} tool config{toolCount !== 1 ? 's' : ''} generated
        </div>
      )}

      {/* Stats footer */}
      <div className="mt-2 flex items-center gap-3 text-[10px] text-foreground-muted">
        <span>
          {agents.length} agent{agents.length !== 1 ? 's' : ''}
        </span>
        <span>·</span>
        <span>
          {toolCount} tool{toolCount !== 1 ? 's' : ''}
        </span>
        <span>·</span>
        <span className={clsx(agents.some((a) => a.hasWarnings) ? 'text-warning' : 'text-success')}>
          {agents.some((a) => a.hasWarnings) ? 'Warnings present' : 'All quality checks passed'}
        </span>
      </div>
    </div>
  );
}

export const BuildSummaryCard = memo(BuildSummaryCardImpl);
