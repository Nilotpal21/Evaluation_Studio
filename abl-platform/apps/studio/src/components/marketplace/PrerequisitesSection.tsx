'use client';

import { useTranslations } from 'next-intl';
import { Key, Plug, Server, Shield, Cpu } from 'lucide-react';
import type { TemplatePrerequisites } from '@/store/marketplace-store';

interface PrerequisitesSectionProps {
  prerequisites: TemplatePrerequisites;
}

export function PrerequisitesSection({ prerequisites }: PrerequisitesSectionProps) {
  const t = useTranslations('marketplace');

  const sections = [
    {
      key: 'envVars',
      label: t('prerequisites.envVars'),
      icon: Key,
      items: prerequisites.envVars,
    },
    {
      key: 'connectors',
      label: t('prerequisites.connectors'),
      icon: Plug,
      items: prerequisites.connectors,
    },
    {
      key: 'mcpServers',
      label: t('prerequisites.mcpServers'),
      icon: Server,
      items: prerequisites.mcpServers,
    },
    {
      key: 'authProfiles',
      label: t('prerequisites.authProfiles'),
      icon: Shield,
      items: prerequisites.authProfiles,
    },
    {
      key: 'models',
      label: t('prerequisites.models'),
      icon: Cpu,
      items: prerequisites.models,
    },
  ];

  const hasAnyPrerequisites = sections.some((s) => s.items.length > 0);

  if (!hasAnyPrerequisites) {
    return <p className="text-sm text-muted">{t('prerequisites.noPrerequisites')}</p>;
  }

  return (
    <div className="space-y-4">
      {sections
        .filter((s) => s.items.length > 0)
        .map((section) => {
          const IconComponent = section.icon;
          return (
            <div key={section.key}>
              <div className="flex items-center gap-1.5 mb-2">
                <IconComponent className="w-3.5 h-3.5 text-muted" />
                <h4 className="text-xs font-medium text-muted">{section.label}</h4>
              </div>
              <div className="flex flex-wrap gap-2">
                {section.items.map((item) => (
                  <span
                    key={item}
                    className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-medium bg-background-muted text-foreground border border-default"
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
    </div>
  );
}
