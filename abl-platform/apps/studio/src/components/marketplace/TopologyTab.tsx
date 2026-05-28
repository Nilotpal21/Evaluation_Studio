'use client';

import { useTranslations } from 'next-intl';
import { Bot, Wrench } from 'lucide-react';
import type { MarketplaceTemplate, MarketplaceTemplateVersion } from '@/store/marketplace-store';

interface TopologyTabProps {
  template: MarketplaceTemplate;
  version: MarketplaceTemplateVersion | null;
}

export function TopologyTab({ template, version }: TopologyTabProps) {
  const t = useTranslations('marketplace');

  // Parse manifest data
  const manifest = version?.manifest as Record<string, unknown> | null;
  const agents = manifest?.agents as Record<string, { description?: string | null }> | undefined;
  const tools = manifest?.tools as Record<string, { path?: string }> | undefined;
  const entryAgent = manifest?.entry_agent as string | undefined;

  return (
    <div className="space-y-6">
      {/* Agents section */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <Bot className="w-4 h-4" />
          {t('topology.agents')}
          {agents && <span className="text-xs text-muted">({Object.keys(agents).length})</span>}
        </h3>

        {agents && Object.keys(agents).length > 0 ? (
          <div className="space-y-2">
            {Object.entries(agents).map(([name, agent]) => (
              <div
                key={name}
                className="flex items-start gap-3 p-3 rounded-lg border border-default bg-background-subtle"
              >
                <Bot className="w-4 h-4 text-muted mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{name}</span>
                    {name === entryAgent && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent-subtle text-accent font-medium">
                        {t('topology.entry')}
                      </span>
                    )}
                    {template.typeMetadata?.hasSupervisor === true &&
                      name.toLowerCase().includes('supervisor') && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-subtle text-purple font-medium">
                          {t('topology.supervisor')}
                        </span>
                      )}
                  </div>
                  {agent.description && (
                    <p className="text-xs text-muted mt-0.5">{agent.description}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted italic">{t('topology.noAgents')}</p>
        )}
      </div>

      {/* Tools section */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <Wrench className="w-4 h-4" />
          {t('topology.tools')}
          {tools && Object.keys(tools).length > 0 && (
            <span className="text-xs text-muted">({Object.keys(tools).length})</span>
          )}
        </h3>

        {tools && Object.keys(tools).length > 0 ? (
          <div className="space-y-2">
            {Object.entries(tools).map(([name]) => (
              <div
                key={name}
                className="flex items-start gap-3 p-3 rounded-lg border border-default bg-background-subtle"
              >
                <Wrench className="w-4 h-4 text-muted mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <span className="text-sm font-medium text-foreground">{name}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted italic">{t('topology.noTools')}</p>
        )}
      </div>

      {/* Summary from typeMetadata (if no manifest detail) */}
      {!agents && template.typeMetadata && (
        <div className="p-4 rounded-lg border border-default bg-background-subtle">
          <p className="text-sm text-muted">
            {typeof template.typeMetadata.agentCount === 'number'
              ? template.typeMetadata.agentCount
              : 0}{' '}
            agent
            {(typeof template.typeMetadata.agentCount === 'number'
              ? template.typeMetadata.agentCount
              : 0) !== 1
              ? 's'
              : ''}
            {template.typeMetadata.hasSupervisor === true && ' (includes supervisor)'}
            {template.typeMetadata.hasFlow === true && ' \u2022 Flow-based'}
          </p>
        </div>
      )}
    </div>
  );
}

export default TopologyTab;
