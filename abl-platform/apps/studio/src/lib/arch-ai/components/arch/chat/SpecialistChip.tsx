'use client';

/**
 * SpecialistChip — compact ~24px-tall variant of SpecialistBadge.
 *
 * Used in ArchHeroStrip to show the currently active specialist next to the
 * project name and phase pill. Imports ICON_MAP / ROLE_STYLES from
 * specialist-style.ts so it never drifts from SpecialistBadge.
 *
 * Props mirror SpecialistBadge: { name, icon } where `icon` is a key into
 * ICON_MAP (clipboard, network, code, shield, phone, database, plug,
 * activity, flask, bot — NOT a specialist id).
 */

import { clsx } from 'clsx';
import { Bot } from 'lucide-react';
import { ICON_MAP, ROLE_STYLES, FALLBACK_STYLE } from './specialist-style';

interface SpecialistChipProps {
  name: string;
  icon: string;
}

export function SpecialistChip({ name, icon }: SpecialistChipProps) {
  const IconComponent = ICON_MAP[icon] ?? Bot;
  const styles = ROLE_STYLES[icon] ?? FALLBACK_STYLE;

  return (
    <span
      className={clsx(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-border bg-background px-2 text-[11px] font-medium',
        styles.label,
      )}
      title={`Active specialist: ${name}`}
    >
      <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', styles.dot)} />
      <IconComponent className="h-3 w-3 shrink-0" />
      <span className="truncate lowercase">{name}</span>
    </span>
  );
}
