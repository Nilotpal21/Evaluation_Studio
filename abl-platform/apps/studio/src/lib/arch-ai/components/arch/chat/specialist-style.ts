'use client';

/**
 * Shared icon and role-style maps for SpecialistBadge / SpecialistChip.
 *
 * Single source of truth — both visual variants of the active-specialist
 * indicator must import from here so they cannot drift. Keys are icon names
 * (NOT specialist IDs): clipboard, network, code, shield, phone, database,
 * plug, activity, flask, bot.
 */

import {
  ClipboardList,
  Network,
  Code,
  Shield,
  Phone,
  Database,
  Plug,
  Activity,
  FlaskConical,
  Bot,
} from 'lucide-react';
import type { ComponentType } from 'react';

export const ICON_MAP: Record<string, ComponentType<{ className?: string }>> = {
  clipboard: ClipboardList,
  network: Network,
  code: Code,
  shield: Shield,
  phone: Phone,
  database: Database,
  plug: Plug,
  activity: Activity,
  flask: FlaskConical,
  bot: Bot,
};

// Each specialist role gets a semantic color token
export const ROLE_STYLES: Record<string, { dot: string; label: string }> = {
  clipboard: {
    dot: 'bg-warning',
    label: 'text-warning',
  },
  network: {
    dot: 'bg-info',
    label: 'text-info',
  },
  code: {
    dot: 'bg-success',
    label: 'text-success',
  },
  shield: {
    dot: 'bg-error',
    label: 'text-error',
  },
  phone: {
    dot: 'bg-purple',
    label: 'text-purple',
  },
  database: {
    dot: 'bg-purple',
    label: 'text-purple',
  },
  plug: {
    dot: 'bg-info',
    label: 'text-info',
  },
  activity: {
    dot: 'bg-orange',
    label: 'text-orange',
  },
  flask: {
    dot: 'bg-info',
    label: 'text-info',
  },
};

export const FALLBACK_STYLE = {
  dot: 'bg-foreground-muted/50',
  label: 'text-foreground-muted',
};
