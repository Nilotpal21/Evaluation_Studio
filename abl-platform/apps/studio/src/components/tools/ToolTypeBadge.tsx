/**
 * ToolTypeBadge Component
 *
 * Colored badge for tool type display.
 */

import { useTranslations } from 'next-intl';
import { Badge } from '../ui/Badge';
import { Globe, Server, Code2, BookOpen, Workflow } from 'lucide-react';
import type { ToolType } from '../../store/tool-store';
import type { BadgeVariant } from '../ui/Badge';

const TYPE_VARIANTS: Record<ToolType, BadgeVariant> = {
  http: 'info',
  mcp: 'purple',
  sandbox: 'warning',
  searchai: 'success',
  workflow: 'accent',
};

const TYPE_ICONS: Record<ToolType, React.ReactNode> = {
  http: <Globe className="w-3 h-3" />,
  mcp: <Server className="w-3 h-3" />,
  sandbox: <Code2 className="w-3 h-3" />,
  searchai: <BookOpen className="w-3 h-3" />,
  workflow: <Workflow className="w-3 h-3" />,
};

const TYPE_KEYS: Record<ToolType, string> = {
  http: 'http',
  mcp: 'mcp',
  sandbox: 'code',
  searchai: 'knowledge_base',
  workflow: 'workflow',
};

interface ToolTypeBadgeProps {
  type: ToolType;
  protocol?: string;
  className?: string;
}

export function ToolTypeBadge({ type, protocol, className }: ToolTypeBadgeProps) {
  const t = useTranslations('tools.type_badge');
  const variant = TYPE_VARIANTS[type];
  const icon = TYPE_ICONS[type];
  const key = TYPE_KEYS[type];
  if (!variant || !key) return null;

  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge
        variant={variant}
        className={className}
        testid={type === 'workflow' ? 'tool-type-badge-workflow' : undefined}
      >
        <span className="flex items-center gap-1">
          {icon}
          {t(key)}
        </span>
      </Badge>
      {type === 'http' && protocol === 'soap' && (
        <Badge variant="info" testid="tool-type-badge-soap">
          {t('soap_protocol')}
        </Badge>
      )}
    </span>
  );
}
