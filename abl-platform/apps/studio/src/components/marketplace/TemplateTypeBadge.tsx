/**
 * TemplateTypeBadge Component
 *
 * Colored badge for template type display (Agent, Project, etc.).
 */

import { clsx } from 'clsx';
import { Bot, FolderOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '../ui/Badge';
import type { BadgeVariant } from '../ui/Badge';

type TemplateType = 'agent' | 'project';

const TYPE_VARIANTS: Record<TemplateType, BadgeVariant> = {
  agent: 'info',
  project: 'purple',
};

const ICON_SIZE: Record<'sm' | 'md', string> = {
  sm: 'w-3 h-3',
  md: 'w-3.5 h-3.5',
};

const TYPE_ICONS: Record<TemplateType, (size: string) => React.ReactNode> = {
  agent: (size) => <Bot className={size} />,
  project: (size) => <FolderOpen className={size} />,
};

interface TemplateTypeBadgeProps {
  type: string;
  size?: 'sm' | 'md';
  className?: string;
}

export function TemplateTypeBadge({ type, size = 'sm', className }: TemplateTypeBadgeProps) {
  const t = useTranslations('marketplace');
  const normalized = type.toLowerCase() as TemplateType;
  const variant = TYPE_VARIANTS[normalized] ?? 'default';
  const iconFactory = TYPE_ICONS[normalized];
  const iconSize = ICON_SIZE[size];
  const label = normalized in TYPE_VARIANTS ? t(`type.${normalized}` as any) : type;

  return (
    <Badge variant={variant} className={clsx(size === 'md' && 'text-sm px-2.5 py-1', className)}>
      <span className="flex items-center gap-1">
        {iconFactory?.(iconSize)}
        {label}
      </span>
    </Badge>
  );
}
