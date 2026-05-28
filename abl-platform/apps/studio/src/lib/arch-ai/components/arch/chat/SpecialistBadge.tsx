'use client';

import { Bot } from 'lucide-react';
import { ICON_MAP, ROLE_STYLES, FALLBACK_STYLE } from './specialist-style';

interface SpecialistBadgeProps {
  name: string;
  icon: string;
}

export function SpecialistBadge({ name, icon }: SpecialistBadgeProps) {
  const IconComponent = ICON_MAP[icon] ?? Bot;
  const styles = ROLE_STYLES[icon] ?? FALLBACK_STYLE;

  return (
    <div className="mb-2 flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${styles.dot}`} />
      <IconComponent className={`h-3 w-3 shrink-0 ${styles.label}`} />
      <span className={`font-mono text-xs font-medium uppercase tracking-wider ${styles.label}`}>
        {name}
      </span>
    </div>
  );
}
