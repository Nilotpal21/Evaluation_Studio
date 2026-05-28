/**
 * ProjectCard Component
 *
 * Card for project dashboard showing name, agent count, last activity, color theme.
 */

import { Folder, Bot } from 'lucide-react';
import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import type { Project } from '../../store/project-store';

// Color themes for projects (consistent based on id hash)
const projectColors = [
  { bg: 'bg-accent-subtle', ring: 'ring-1 ring-accent/20', icon: 'text-accent' },
  { bg: 'bg-info-subtle', ring: 'ring-1 ring-info/20', icon: 'text-info' },
  { bg: 'bg-success-subtle', ring: 'ring-1 ring-success/20', icon: 'text-success' },
  { bg: 'bg-warning-subtle', ring: 'ring-1 ring-warning/20', icon: 'text-warning' },
  { bg: 'bg-error-subtle', ring: 'ring-1 ring-error/20', icon: 'text-error' },
  { bg: 'bg-info-subtle', ring: 'ring-1 ring-info/20', icon: 'text-info' },
];

function getProjectColor(id: string) {
  const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return projectColors[hash % projectColors.length];
}

interface ProjectCardProps {
  project: Project;
  onClick: () => void;
}

export function ProjectCard({ project, onClick }: ProjectCardProps) {
  const t = useTranslations('projects.card');
  const color = getProjectColor(project.id);

  const timeAgo = (date: string): string => {
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return t('time_just_now');
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('time_minutes_ago', { minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('time_hours_ago', { hours });
    const days = Math.floor(hours / 24);
    if (days < 30) return t('time_days_ago', { days });
    return new Date(date).toLocaleDateString();
  };

  return (
    <button
      onClick={onClick}
      className="w-full h-full text-left rounded-xl border border-default bg-background-elevated p-4 card-hover group flex flex-col"
    >
      {/* Header */}
      <div className="flex items-start gap-3 flex-1">
        <div
          className={clsx(
            'w-10 h-10 rounded-lg flex items-center justify-center shrink-0',
            color.bg,
          )}
        >
          <Folder className={clsx('w-5 h-5', color.icon)} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground truncate">{project.name}</h3>
          {project.description && (
            <p className="text-xs text-muted mt-0.5 line-clamp-2">{project.description}</p>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-muted mt-3">
        <span className="flex items-center gap-1">
          <Bot className="w-3.5 h-3.5" />
          {t('agents', { count: project.agentCount })}
        </span>
        <span>{timeAgo(project.updatedAt)}</span>
      </div>
    </button>
  );
}
