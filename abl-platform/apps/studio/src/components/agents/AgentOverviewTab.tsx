/**
 * AgentOverviewTab Component
 *
 * Agent metadata, active version, quick actions.
 */

import { useTranslations } from 'next-intl';
import { Bot, Play, Tag, Clock, Hash, FileCode } from 'lucide-react';
import { parseActiveVersions, type RuntimeAgent } from '../../api/runtime-agents';
import { useNavigationStore } from '../../store/navigation-store';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { CodeBlock } from '../ui/CodeBlock';

interface AgentOverviewTabProps {
  agent: RuntimeAgent;
}

export function AgentOverviewTab({ agent }: AgentOverviewTabProps) {
  const t = useTranslations('agents.overview');
  const { projectId, navigate } = useNavigationStore();

  const handleChat = () => {
    navigate(`/projects/${projectId}/agents/${agent.name}/chat`);
  };

  const activeVersions = Object.entries(parseActiveVersions(agent.activeVersions));

  return (
    <div className="space-y-6 py-4">
      {/* Quick actions */}
      <div className="flex items-center gap-3">
        <Button variant="primary" icon={<Play className="w-4 h-4" />} onClick={handleChat}>
          {t('chat_with_agent')}
        </Button>
      </div>

      {/* Metadata */}
      <div className="grid grid-cols-2 gap-4">
        <MetaCard
          icon={<Tag className="w-4 h-4" />}
          label={t('path_label')}
          value={agent.agentPath || '—'}
        />
        <MetaCard
          icon={<Hash className="w-4 h-4" />}
          label={t('versions_label')}
          value={String(agent.versionCount ?? '—')}
        />
        <MetaCard
          icon={<Clock className="w-4 h-4" />}
          label={t('created_label')}
          value={new Date(agent.createdAt).toLocaleDateString()}
        />
        <MetaCard
          icon={<Clock className="w-4 h-4" />}
          label={t('updated_label')}
          value={new Date(agent.updatedAt).toLocaleDateString()}
        />
      </div>

      {/* Active Versions */}
      {activeVersions.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-foreground mb-2">{t('active_versions_title')}</h3>
          <div className="space-y-2">
            {activeVersions.map(([env, version]) => (
              <div
                key={env}
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-background-muted border border-default"
              >
                <span className="text-sm text-foreground capitalize">{env}</span>
                <Badge variant="success">v{version}</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Description */}
      {agent.description && (
        <div>
          <h3 className="text-sm font-medium text-foreground mb-2">{t('description_title')}</h3>
          <p className="text-sm text-muted">{agent.description}</p>
        </div>
      )}

      {/* DSL Preview */}
      {agent.dslContent && (
        <div>
          <h3 className="text-sm font-medium text-foreground mb-2 flex items-center gap-2">
            <FileCode className="w-4 h-4" />
            {t('working_copy_title')}
          </h3>
          <CodeBlock
            code={
              agent.dslContent.slice(0, 2000) +
              (agent.dslContent.length > 2000 ? `\n${t('truncated')}` : '')
            }
            language="abl"
            maxHeight="300px"
          />
        </div>
      )}
    </div>
  );
}

function MetaCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg bg-background-muted border border-default">
      <span className="text-muted">{icon}</span>
      <div>
        <p className="text-xs text-muted">{label}</p>
        <p className="text-sm font-medium text-foreground">{value}</p>
      </div>
    </div>
  );
}
