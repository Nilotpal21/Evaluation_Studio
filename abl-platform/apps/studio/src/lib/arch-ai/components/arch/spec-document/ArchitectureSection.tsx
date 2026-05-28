'use client';

import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import { SectionHeader } from './SectionHeader';

export function ArchitectureSection() {
  const doc = useArchAIStore((s) => s.specDocument);
  const arch = (doc?.architecture ?? {}) as Record<string, unknown>;

  const agents = (arch.agents as Array<Record<string, unknown>>) ?? [];
  const edges = (arch.edges as Array<Record<string, string>>) ?? [];
  const pattern = (arch.pattern as string) ?? '';
  const entryPoint = (arch.entryPoint as string) ?? '';
  const rationale = (arch.rationale as string) ?? '';

  const hasContent = agents.length > 0;
  const status = hasContent ? 'draft' : 'empty';

  return (
    <SectionHeader title="Architecture" status={status} locked>
      {!hasContent ? (
        <p className="text-xs text-foreground-muted/70">
          Architecture will appear after Blueprint phase
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Pattern & Entry */}
          {(pattern || entryPoint) && (
            <div className="flex gap-4">
              {pattern && (
                <div className="flex-1">
                  <label className="text-xs font-medium text-foreground-muted">Pattern</label>
                  <p className="mt-0.5 text-sm text-foreground">{pattern}</p>
                </div>
              )}
              {entryPoint && (
                <div className="flex-1">
                  <label className="text-xs font-medium text-foreground-muted">Entry Point</label>
                  <p className="mt-0.5 text-sm font-medium text-foreground">{entryPoint}</p>
                </div>
              )}
            </div>
          )}

          {/* Rationale */}
          {rationale && (
            <div>
              <label className="text-xs font-medium text-foreground-muted">Rationale</label>
              <p className="mt-0.5 text-xs leading-relaxed text-foreground-muted">{rationale}</p>
            </div>
          )}

          {/* Agents table */}
          <div>
            <label className="text-xs font-medium text-foreground-muted">Agents</label>
            <div className="mt-1.5 overflow-hidden rounded-lg border border-border/50">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/40 bg-background-muted/50">
                    <th className="px-3 py-1.5 text-left font-medium text-foreground-muted">
                      Name
                    </th>
                    <th className="px-3 py-1.5 text-left font-medium text-foreground-muted">
                      Role
                    </th>
                    <th className="px-3 py-1.5 text-left font-medium text-foreground-muted">
                      Mode
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((agent, i) => (
                    <tr key={i} className="border-b border-border/30 last:border-0">
                      <td className="px-3 py-1.5 font-medium text-foreground">
                        {(agent.name as string) ?? `Agent ${i + 1}`}
                      </td>
                      <td className="px-3 py-1.5 text-foreground-muted">
                        {(agent.role as string) ?? (agent.description as string) ?? ''}
                      </td>
                      <td className="px-3 py-1.5 text-foreground-muted">
                        {(agent.mode as string) ?? (agent.executionMode as string) ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Edges / topology table */}
          {edges.length > 0 && (
            <div>
              <label className="text-xs font-medium text-foreground-muted">Topology</label>
              <div className="mt-1.5 overflow-hidden rounded-lg border border-border/50">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border/40 bg-background-muted/50">
                      <th className="px-3 py-1.5 text-left font-medium text-foreground-muted">
                        From
                      </th>
                      <th className="px-3 py-1.5 text-left font-medium text-foreground-muted">
                        To
                      </th>
                      <th className="px-3 py-1.5 text-left font-medium text-foreground-muted">
                        Type
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {edges.map((edge, i) => (
                      <tr key={i} className="border-b border-border/30 last:border-0">
                        <td className="px-3 py-1.5 font-medium text-foreground">{edge.from}</td>
                        <td className="px-3 py-1.5 text-foreground">{edge.to}</td>
                        <td className="px-3 py-1.5 text-foreground-muted">{edge.type}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </SectionHeader>
  );
}
