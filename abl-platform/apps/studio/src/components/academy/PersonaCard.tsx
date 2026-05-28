'use client';

import { useTranslations } from 'next-intl';
import { motion } from 'framer-motion';
import { Hammer, Building2, BarChart3, type LucideIcon } from 'lucide-react';
import { ProgressBar } from './ProgressBar';

export interface PersonaCardData {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  icon: string;
  level: string;
  badge: string;
}

interface PersonaCardProps {
  persona: PersonaCardData;
  selected: boolean;
  onSelect: (id: string) => void;
  courseCount?: number;
  estimatedHours?: number;
  progressPercent?: number;
}

/** Map persona icon key to a lucide icon component */
const personaIcons: Record<string, LucideIcon> = {
  builder: Hammer,
  architect: Building2,
  analyst: BarChart3,
};

export function PersonaCard({
  persona,
  selected,
  onSelect,
  courseCount,
  estimatedHours,
  progressPercent,
}: PersonaCardProps) {
  const t = useTranslations('academy');
  const Icon = personaIcons[persona.icon] ?? Hammer;

  return (
    <motion.button
      type="button"
      onClick={() => onSelect(persona.id)}
      aria-label={t('select_persona_aria', { name: persona.title })}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 200, damping: 20 }}
      className={`focus-ring flex w-full flex-col gap-1.5 rounded-xl border p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-lg ${
        selected
          ? 'border-accent bg-accent-subtle shadow-sm'
          : 'border-border bg-background-elevated hover:border-foreground-subtle hover:bg-background-muted'
      }`}
    >
      <div className="flex items-center gap-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
            selected ? 'bg-accent/15' : 'bg-background-muted'
          }`}
        >
          <Icon className={`h-4.5 w-4.5 ${selected ? 'text-accent' : 'text-foreground-muted'}`} />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{persona.title}</h3>
          <p className="truncate text-xs text-foreground-muted">{persona.subtitle}</p>
        </div>
      </div>

      <p className="line-clamp-2 text-xs leading-relaxed text-foreground-subtle">
        {persona.description}
      </p>

      {/* Meta stats row */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full bg-accent-subtle px-2 py-0.5 text-[10px] font-medium text-accent">
          {persona.level}
        </span>
        {courseCount !== undefined && (
          <span className="text-[11px] text-foreground-muted">
            {t('course_count', { count: courseCount })}
          </span>
        )}
        {estimatedHours !== undefined && (
          <span className="text-[11px] text-foreground-muted">
            {t('course_time_hours', { hours: estimatedHours })}
          </span>
        )}
      </div>

      {/* Progress bar — only shown if progress > 0 */}
      {progressPercent !== undefined && progressPercent > 0 && (
        <ProgressBar value={progressPercent} label={`${progressPercent}%`} />
      )}
    </motion.button>
  );
}
