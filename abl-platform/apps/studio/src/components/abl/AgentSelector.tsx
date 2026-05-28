/**
 * Agent Selector Component
 *
 * Dropdown to select agents grouped by domain
 */

import { useState } from 'react';
import { useAgents } from '../../hooks/useAgents';
import { useWebSocketContext } from '../../contexts/WebSocketContext';
import { useSession } from '../../hooks/useSession';
import { useNavigationStore } from '../../store/navigation-store';
import { ChevronDown, ChevronRight, Users, Bot, RefreshCw, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import type { AgentInfo } from '../../types';
import { formatAgentName } from '../../lib/format/agent-name';

export function AgentSelector() {
  const { agents, domains, isLoading, error, refresh } = useAgents();
  const { loadAgent } = useWebSocketContext();
  const { agent: selectedAgent } = useSession();
  const { projectId } = useNavigationStore();

  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set(domains));

  const toggleDomain = (domain: string) => {
    setExpandedDomains((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) {
        next.delete(domain);
      } else {
        next.add(domain);
      }
      return next;
    });
  };

  const handleSelectAgent = (agent: AgentInfo) => {
    if (!projectId) {
      return;
    }
    loadAgent(agent.id, projectId);
  };

  if (isLoading) {
    return (
      <div className="p-4 flex items-center justify-center text-subtle">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading agents...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <p className="text-error text-sm mb-2">{error}</p>
        <button
          onClick={refresh}
          className="text-sm text-accent hover:text-accent/80 flex items-center gap-1"
        >
          <RefreshCw className="w-4 h-4" />
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="overflow-y-auto">
      {/* Header */}
      <div className="px-3 py-2 border-b border-default flex items-center justify-between">
        <span className="text-sm font-medium text-muted">Select Agent</span>
        <button
          onClick={refresh}
          className="p-1 hover:bg-background-muted rounded transition-colors"
          title="Refresh agent list"
        >
          <RefreshCw className="w-4 h-4 text-muted" />
        </button>
      </div>

      {/* Agent List */}
      <div className="py-1">
        {domains.map((domain) => (
          <div key={domain}>
            {/* Domain Header */}
            <button
              onClick={() => toggleDomain(domain)}
              className="w-full px-3 py-2 flex items-center gap-2 hover:bg-background-muted transition-colors"
            >
              {expandedDomains.has(domain) ? (
                <ChevronDown className="w-4 h-4 text-subtle" />
              ) : (
                <ChevronRight className="w-4 h-4 text-subtle" />
              )}
              <span className="text-sm font-medium text-muted capitalize">{domain}</span>
              <span className="text-xs text-subtle">({agents[domain]?.length || 0})</span>
            </button>

            {/* Agents */}
            {expandedDomains.has(domain) && (
              <div className="ml-4">
                {agents[domain]?.map((agent) => (
                  <AgentItem
                    key={agent.id}
                    agent={agent}
                    isSelected={selectedAgent?.id === agent.id}
                    onSelect={() => handleSelectAgent(agent)}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface AgentItemProps {
  agent: AgentInfo;
  isSelected: boolean;
  onSelect: () => void;
}

function AgentItem({ agent, isSelected, onSelect }: AgentItemProps) {
  return (
    <button
      onClick={onSelect}
      className={clsx(
        'w-full px-3 py-2 flex items-center gap-2 text-left transition-colors',
        isSelected
          ? 'bg-accent/20 border-l-2 border-accent'
          : 'hover:bg-background-muted border-l-2 border-transparent',
      )}
    >
      {/* Icon */}
      {agent.isSupervisor ? (
        <Users className="w-4 h-4 text-accent flex-shrink-0" />
      ) : (
        <Bot className="w-4 h-4 text-accent flex-shrink-0" />
      )}

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="text-sm text-foreground truncate">{formatAgentName(agent.name)}</div>
        <div className="flex items-center gap-2 text-xs text-subtle">
          <span
            className={clsx(
              'px-1.5 py-0.5 rounded',
              agent.mode === 'reasoning'
                ? 'bg-success-subtle text-success'
                : 'bg-accent-subtle text-accent',
            )}
          >
            {agent.mode}
          </span>
          {agent.toolCount > 0 && <span>{agent.toolCount} tools</span>}
          {agent.gatherFieldCount > 0 && <span>{agent.gatherFieldCount} fields</span>}
        </div>
      </div>
    </button>
  );
}
