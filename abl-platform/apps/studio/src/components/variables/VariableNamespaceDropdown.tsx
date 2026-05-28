'use client';

/**
 * VariableNamespaceDropdown Component
 *
 * Dropdown selector for filtering variables by variable namespace.
 * Shows "All Variables" at top with total count, then namespaces sorted by order.
 */

import { clsx } from 'clsx';
import { useTranslations } from 'next-intl';
import { ChevronDown, Layers } from 'lucide-react';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '../ui/DropdownMenu';
import { resolveNamespaceColor } from '@agent-platform/design-tokens';
import type { VariableNamespace } from '../../api/variable-namespaces';

interface VariableNamespaceDropdownProps {
  namespaces: VariableNamespace[];
  selected: string | null;
  onSelect: (namespaceId: string | null) => void;
  totalCount: number;
  loading?: boolean;
  className?: string;
}

export function VariableNamespaceDropdown({
  namespaces,
  selected,
  onSelect,
  totalCount,
  loading,
  className,
}: VariableNamespaceDropdownProps) {
  const t = useTranslations('variables.namespace_dropdown');
  const sorted = [...namespaces].sort((a, b) => a.order - b.order);
  const selectedNs = selected ? sorted.find((ns) => ns.id === selected) : null;

  const triggerLabel = selectedNs ? selectedNs.displayName : t('all_variables');
  const triggerCount = selectedNs
    ? selectedNs.memberCounts.env + selectedNs.memberCounts.config
    : totalCount;

  return (
    <DropdownMenu
      align="start"
      trigger={
        <button
          type="button"
          disabled={loading}
          className={clsx(
            'inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-default',
            'bg-background-subtle text-foreground hover:bg-background-muted transition-default',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            className,
          )}
        >
          <Layers className="w-3.5 h-3.5 text-muted" />
          {selectedNs?.color && (
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: resolveNamespaceColor(selectedNs.color) ?? undefined }}
            />
          )}
          <span className="truncate max-w-[140px]">{triggerLabel}</span>
          <span className="text-xs text-muted">({triggerCount})</span>
          <ChevronDown className="w-3.5 h-3.5 text-muted shrink-0" />
        </button>
      }
    >
      <DropdownMenuItem
        onSelect={() => onSelect(null)}
        className={clsx(!selected && 'bg-accent-subtle')}
      >
        <span className="flex items-center gap-2 w-full">
          <Layers className="w-3.5 h-3.5 text-muted shrink-0" />
          <span className="flex-1">{t('all_variables')}</span>
          <span className="text-xs text-muted">{totalCount}</span>
        </span>
      </DropdownMenuItem>

      {sorted.length > 0 && <DropdownMenuSeparator />}

      {sorted.map((ns) => {
        const count = ns.memberCounts.env + ns.memberCounts.config;
        return (
          <DropdownMenuItem
            key={ns.id}
            onSelect={() => onSelect(ns.id)}
            className={clsx(selected === ns.id && 'bg-accent-subtle')}
          >
            <span className="flex items-center gap-2 w-full">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{
                  backgroundColor: resolveNamespaceColor(ns.color) ?? 'var(--color-muted)',
                }}
              />
              <span className="flex-1 truncate">{ns.displayName}</span>
              <span className="text-xs text-muted">{count}</span>
            </span>
          </DropdownMenuItem>
        );
      })}
    </DropdownMenu>
  );
}
