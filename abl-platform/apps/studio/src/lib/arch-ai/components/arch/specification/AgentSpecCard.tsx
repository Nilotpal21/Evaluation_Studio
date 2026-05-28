'use client';

interface AgentSpecCardProps {
  agent: {
    name: string;
    role: string;
    executionMode: string;
    description: string;
  };
  index: number;
  total: number;
  isEntryPoint: boolean;
  handoffs: Array<{ to: string; type: string; condition: string }>;
}

/**
 * AgentSpecCard — displays per-agent specification from topology.
 * S2-F08: sequential display in build order after topology approval.
 */
export function AgentSpecCard({ agent, index, total, isEntryPoint, handoffs }: AgentSpecCardProps) {
  return (
    <div className="rounded-lg border border-border p-3 text-sm">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{agent.name}</span>
          {isEntryPoint && (
            <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
              entry
            </span>
          )}
          <span className="rounded bg-background-muted px-1.5 py-0.5 text-[10px] text-foreground-muted">
            {agent.executionMode}
          </span>
        </div>
        <span className="text-[10px] text-foreground-muted">
          {index + 1} of {total}
        </span>
      </div>

      <p className="text-xs text-foreground-muted mb-2">{agent.role}</p>

      {agent.description && agent.description !== agent.role && (
        <p className="text-xs text-foreground/70 mb-2">{agent.description}</p>
      )}

      {handoffs.length > 0 && (
        <div className="mt-2 border-t border-border/50 pt-2">
          <div className="text-[10px] font-medium text-foreground-muted mb-1">Handoffs</div>
          {handoffs.map((h, i) => (
            <div key={i} className="flex items-center gap-1 text-[11px] text-foreground-muted">
              <span className="text-accent">→</span>
              <span>{h.to}</span>
              <span className="text-[10px]">({h.type})</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
