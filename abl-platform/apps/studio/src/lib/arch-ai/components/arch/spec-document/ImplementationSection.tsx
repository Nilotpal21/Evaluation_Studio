'use client';

import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import { SectionHeader } from './SectionHeader';

export function ImplementationSection() {
  const doc = useArchAIStore((s) => s.specDocument);
  const impl = (doc?.implementation ?? {}) as Record<string, unknown>;

  const tools = (impl.tools as Array<Record<string, unknown>>) ?? [];
  const guardrails = (impl.guardrails as Array<Record<string, unknown>>) ?? [];
  const buildStatus = (impl.buildStatus as string) ?? '';

  const hasContent = tools.length > 0 || guardrails.length > 0;
  const status = hasContent ? 'draft' : 'empty';

  return (
    <SectionHeader title="Implementation" status={status} locked>
      {!hasContent ? (
        <p className="text-xs text-foreground-muted/70">
          Implementation details will appear after Build phase
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Build status */}
          {buildStatus && (
            <div>
              <label className="text-xs font-medium text-foreground-muted">Build Status</label>
              <p className="mt-0.5 text-sm text-foreground">{buildStatus}</p>
            </div>
          )}

          {/* Tools table */}
          {tools.length > 0 && (
            <div>
              <label className="text-xs font-medium text-foreground-muted">Tools</label>
              <div className="mt-1.5 overflow-hidden rounded-lg border border-border/50">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border/40 bg-background-muted/50">
                      <th className="px-3 py-1.5 text-left font-medium text-foreground-muted">
                        Name
                      </th>
                      <th className="px-3 py-1.5 text-left font-medium text-foreground-muted">
                        Description
                      </th>
                      <th className="px-3 py-1.5 text-left font-medium text-foreground-muted">
                        Agent
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tools.map((tool, i) => (
                      <tr key={i} className="border-b border-border/30 last:border-0">
                        <td className="px-3 py-1.5 font-medium text-foreground">
                          {(tool.name as string) ?? `Tool ${i + 1}`}
                        </td>
                        <td className="px-3 py-1.5 text-foreground-muted">
                          {(tool.description as string) ?? ''}
                        </td>
                        <td className="px-3 py-1.5 text-foreground-muted">
                          {(tool.agent as string) ?? ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Guardrails table */}
          {guardrails.length > 0 && (
            <div>
              <label className="text-xs font-medium text-foreground-muted">Guardrails</label>
              <div className="mt-1.5 overflow-hidden rounded-lg border border-border/50">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border/40 bg-background-muted/50">
                      <th className="px-3 py-1.5 text-left font-medium text-foreground-muted">
                        Name
                      </th>
                      <th className="px-3 py-1.5 text-left font-medium text-foreground-muted">
                        Type
                      </th>
                      <th className="px-3 py-1.5 text-left font-medium text-foreground-muted">
                        Description
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {guardrails.map((gr, i) => (
                      <tr key={i} className="border-b border-border/30 last:border-0">
                        <td className="px-3 py-1.5 font-medium text-foreground">
                          {(gr.name as string) ?? `Guardrail ${i + 1}`}
                        </td>
                        <td className="px-3 py-1.5 text-foreground-muted">
                          {(gr.type as string) ?? ''}
                        </td>
                        <td className="px-3 py-1.5 text-foreground-muted">
                          {(gr.description as string) ?? ''}
                        </td>
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
