import { ArrowUpRight, Bot } from 'lucide-react';
import { projects, type AgentStatus } from '@/lib/mock-data';
import { cn } from '@/lib/utils';

const statusStyle: Record<AgentStatus, { dot: string; label: string }> = {
  active: { dot: 'bg-success', label: 'Active' },
  paused: { dot: 'bg-warning', label: 'Paused' },
  draft: { dot: 'bg-foreground-subtle', label: 'Draft' },
  error: { dot: 'bg-error', label: 'Error' },
};

export function ProjectsGrid() {
  return (
    <section>
      <div className="flex items-end justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold">Projects</h2>
          <p className="text-xs text-foreground-muted mt-0.5">
            {projects.length} projects across your workspace
          </p>
        </div>
        <button className="text-xs text-foreground-muted hover:text-foreground transition-colors flex items-center gap-1">
          View all
          <ArrowUpRight className="size-3" />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {projects.map((p) => {
          const s = statusStyle[p.status];
          return (
            <button
              key={p.id}
              className="text-left group rounded-lg border border-border-muted bg-background-subtle hover:border-border hover:bg-background-muted/50 transition-colors p-4"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="size-6 rounded-md bg-background-elevated border border-border-muted flex items-center justify-center">
                    <Bot className="size-3.5 text-foreground-muted group-hover:text-foreground transition-colors" />
                  </div>
                  <span className="text-sm font-medium font-mono">{p.name}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={cn('size-1.5 rounded-full', s.dot)} />
                  <span className="text-[10px] uppercase tracking-wide text-foreground-meta">
                    {s.label}
                  </span>
                </div>
              </div>

              <p className="text-xs text-foreground-muted leading-relaxed line-clamp-2 mb-3 min-h-[2.2rem]">
                {p.description}
              </p>

              <div className="grid grid-cols-3 gap-2 pt-3 border-t border-border-muted">
                <Stat label="Agents" value={p.agents.toString()} />
                <Stat label="Runs · 24h" value={p.runs24h.toLocaleString()} />
                <Stat label="Success" value={`${p.successRate}%`} />
              </div>

              <div className="mt-3 flex items-center justify-between text-[11px] text-foreground-subtle">
                <span>Updated {p.updatedAt}</span>
                <span className="font-mono">
                  <span className="size-4 inline-flex items-center justify-center rounded-full bg-accent-subtle text-[9px] text-foreground-muted mr-1">
                    {p.ownerInitials}
                  </span>
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-foreground-meta">{label}</div>
      <div className="text-xs font-medium tabular-nums mt-0.5">{value}</div>
    </div>
  );
}
