'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Key, Plug, Server, Shield, Bot } from 'lucide-react';
import type { AppliedCounts, ProvisioningReport } from '@/api/template-install';

interface PostInstallChecklistProps {
  provisioningRequired?: ProvisioningReport;
  applied?: AppliedCounts;
  entryAgentName?: string | null;
}

export function PostInstallChecklist({
  provisioningRequired,
  applied,
  entryAgentName,
}: PostInstallChecklistProps) {
  const t = useTranslations('marketplace');

  const sections = useMemo(() => {
    if (!provisioningRequired) return [];
    return [
      {
        key: 'envVars',
        label: t('install.provisioningEnvVars'),
        icon: Key,
        items: provisioningRequired.envVars,
      },
      {
        key: 'connectors',
        label: t('install.provisioningConnectors'),
        icon: Plug,
        items: provisioningRequired.connectors,
      },
      {
        key: 'mcpServers',
        label: t('install.provisioningMcpServers'),
        icon: Server,
        items: provisioningRequired.mcpServers,
      },
      {
        key: 'authProfiles',
        label: t('install.provisioningAuthProfiles'),
        icon: Shield,
        items: provisioningRequired.authProfiles,
      },
    ];
  }, [provisioningRequired, t]);

  const hasProvisioning = sections.some((s) => s.items.length > 0);

  return (
    <div className="space-y-3">
      {/* Summary */}
      {applied && (
        <div className="rounded-lg border border-default bg-background-subtle px-3 py-2">
          <p className="text-sm text-foreground">
            {t('install.installSummary', {
              agents: applied.created,
              tools: applied.toolsCreated,
            })}
          </p>
          {entryAgentName && (
            <div className="flex items-center gap-1.5 mt-1">
              <Bot className="w-3.5 h-3.5 text-muted" />
              <p className="text-xs text-muted">
                {t('install.entryAgent', { name: entryAgentName })}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Provisioning report */}
      {hasProvisioning && (
        <div className="space-y-3">
          <h4 className="text-xs font-medium text-warning">{t('install.provisioningRequired')}</h4>
          {sections
            .filter((s) => s.items.length > 0)
            .map((section) => {
              const IconComponent = section.icon;
              return (
                <div key={section.key}>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <IconComponent className="w-3.5 h-3.5 text-muted" />
                    <span className="text-xs font-medium text-muted">{section.label}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {section.items.map((item) => (
                      <span
                        key={item}
                        className="inline-flex items-center px-2 py-0.5 rounded-md text-xs bg-warning/10 text-warning border border-warning/20"
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {/* No provisioning */}
      {!hasProvisioning && provisioningRequired && (
        <div className="flex items-center gap-2 text-success">
          <CheckCircle2 className="w-4 h-4" />
          <p className="text-xs">{t('install.noProvisioning')}</p>
        </div>
      )}
    </div>
  );
}
