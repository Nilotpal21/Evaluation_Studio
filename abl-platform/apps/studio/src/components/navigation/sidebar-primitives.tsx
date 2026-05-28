/**
 * Sidebar primitives — shared building blocks for project, agent-editor, and admin sidebars.
 *
 * Provides a single source of truth for surface chrome (container, header, nav, group, item,
 * collapse toggle, back button, separator) so all three sidebars stay visually aligned and
 * future tweaks land in one place.
 */

'use client';

import { clsx } from 'clsx';
import { motion } from 'framer-motion';
import { ArrowLeft, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { forwardRef, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { springs } from '../../lib/animation';
import { GrainOverlay } from '../ui/GrainOverlay';
import { Tooltip, TooltipProvider } from '../ui/Tooltip';

export type SidebarSurface = 'project' | 'agent' | 'admin' | 'marketplace';

// ─────────────────────────────────────────────────────────────────────────────
// Spacing tokens — JS mirror of CSS custom properties in globals.css
// ─────────────────────────────────────────────────────────────────────────────

export const SIDEBAR_SPACING = {
  headerHeight: '3.0625rem', // --sidebar-header-height (49px)
  gutter: '0.5rem', // --sidebar-gutter (px-2 = 8px)
  zoneGap: '0.75rem', // --sidebar-zone-gap (pb-3 = 12px)
  zonePy: '0.5rem', // --sidebar-zone-py (pt-2/pb-2 = 8px)
  zoneInnerPy: '0.25rem', // --sidebar-zone-inner-py (4px adjacent-zone edge)
  itemPy: '0.375rem', // --sidebar-item-py (py-1.5 = 6px)
  topChromeHeight: '2.875rem', // --sidebar-top-chrome-height (46px fixed collapse/back row)
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Zone
// ─────────────────────────────────────────────────────────────────────────────

interface SidebarZoneProps {
  children: React.ReactNode;
  collapsed?: boolean;
  /** Center content horizontally when collapsed — removes gutter, adds justify-center */
  center?: boolean;
  className?: string;
}

export const SidebarZone = forwardRef<HTMLDivElement, SidebarZoneProps>(function SidebarZone(
  { children, collapsed, center, className },
  ref,
) {
  return (
    <div
      ref={ref}
      className={clsx(
        'px-[var(--sidebar-gutter)] shrink-0',
        collapsed && center && 'flex justify-center px-0',
        className,
      )}
    >
      {children}
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Container
// ─────────────────────────────────────────────────────────────────────────────

interface SidebarContainerProps {
  surface: SidebarSurface;
  collapsed: boolean;
  width: number;
  collapsedWidth: number;
  children: React.ReactNode;
  ariaLabel?: string;
  className?: string;
}

export function SidebarContainer({
  surface,
  collapsed,
  width,
  collapsedWidth,
  children,
  ariaLabel,
  className,
}: SidebarContainerProps): JSX.Element {
  const surfaceBg =
    surface === 'project' || surface === 'marketplace'
      ? 'bg-gradient-surface-sidebar'
      : surface === 'agent'
        ? 'bg-gradient-surface-agent-sidebar'
        : 'bg-[hsl(var(--admin-sidebar-bg))]';

  const borderClass =
    surface === 'admin' ? 'border-[hsl(var(--admin-sidebar-border))]' : 'border-default';

  const initialWidthRef = useRef(collapsed ? collapsedWidth : width);

  return (
    <motion.aside
      aria-label={ariaLabel}
      initial={{ width: initialWidthRef.current }}
      animate={{ width: collapsed ? collapsedWidth : width }}
      transition={springs.gentle}
      className={clsx(
        'relative h-full flex flex-col border-r overflow-x-clip shrink-0',
        surfaceBg,
        borderClass,
        className,
      )}
    >
      <GrainOverlay opacity={0.06} blendMode="normal" baseFrequency={0.45} />
      <div className="relative z-[1] flex flex-col flex-1 min-h-0">{children}</div>
    </motion.aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────────────────────

interface SidebarHeaderProps {
  collapsed: boolean;
  children?: React.ReactNode;
  noBorder?: boolean;
  surface?: SidebarSurface;
}

export function SidebarHeader({
  collapsed,
  children,
  noBorder,
  surface = 'project',
}: SidebarHeaderProps): JSX.Element {
  const borderClass =
    surface === 'admin' ? 'border-[hsl(var(--admin-sidebar-border))]' : 'border-default';

  return (
    <div
      className={clsx(
        'h-[var(--sidebar-header-height)] flex items-center shrink-0 px-[var(--sidebar-gutter)]',
        !noBorder && 'border-b',
        !noBorder && borderClass,
        collapsed && 'justify-center',
      )}
    >
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Collapse button
// ─────────────────────────────────────────────────────────────────────────────

interface SidebarCollapseButtonProps {
  collapsed: boolean;
  onToggle: () => void;
  surface?: SidebarSurface;
  'data-testid'?: string;
  ariaLabel?: string;
  title?: string;
}

export function SidebarCollapseButton({
  collapsed,
  onToggle,
  surface = 'project',
  ariaLabel,
  title,
  ...rest
}: SidebarCollapseButtonProps): JSX.Element {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const isAdmin = surface === 'admin';
  const hoverClass = isAdmin
    ? 'hover:bg-[hsl(var(--admin-sidebar-hover))]'
    : 'hover:bg-[hsl(var(--sidebar-hover))]';
  const colorClass = isAdmin
    ? 'text-[hsl(var(--admin-sidebar-text))] hover:text-[hsl(var(--admin-sidebar-text-strong))]'
    : 'text-subtle hover:text-foreground';

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={ariaLabel}
      title={title}
      data-testid={rest['data-testid']}
      className={clsx(
        'w-7 h-7 flex items-center justify-center rounded transition-default',
        colorClass,
        hoverClass,
      )}
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Back icon button (collapsed state — icon only, mirrors SidebarCollapseButton)
// ─────────────────────────────────────────────────────────────────────────────

interface SidebarBackIconButtonProps {
  onClick: () => void;
  surface?: SidebarSurface;
  ariaLabel?: string;
  title?: string;
}

export function SidebarBackIconButton({
  onClick,
  surface = 'project',
  ariaLabel,
  title,
}: SidebarBackIconButtonProps): JSX.Element {
  const isAdmin = surface === 'admin';
  const hoverClass = isAdmin
    ? 'hover:bg-[hsl(var(--admin-sidebar-hover))]'
    : 'hover:bg-[hsl(var(--sidebar-hover))]';
  const colorClass = isAdmin
    ? 'text-[hsl(var(--admin-sidebar-text))] hover:text-[hsl(var(--admin-sidebar-text-strong))]'
    : 'text-subtle hover:text-foreground';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      className={clsx(
        'w-6 h-6 flex items-center justify-center rounded transition-default',
        colorClass,
        hoverClass,
      )}
    >
      <ArrowLeft className="w-4 h-4" />
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Back button
// ─────────────────────────────────────────────────────────────────────────────

interface SidebarBackButtonProps {
  onClick: () => void;
  label?: string;
  surface?: SidebarSurface;
}

export function SidebarBackButton({
  onClick,
  label,
  surface = 'project',
}: SidebarBackButtonProps): JSX.Element {
  const isAdmin = surface === 'admin';
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={clsx(
        'flex-1 flex items-center gap-2 px-2 py-1.5 rounded text-sm border border-transparent transition-default',
        isAdmin
          ? 'text-[hsl(var(--admin-sidebar-text))] hover:text-[hsl(var(--admin-sidebar-text-strong))] hover:bg-[hsl(var(--admin-sidebar-hover))]'
          : 'text-subtle hover:text-foreground hover:bg-[hsl(var(--sidebar-hover))]',
      )}
    >
      <ArrowLeft className="w-4 h-4 shrink-0" />
      {label && <span className="truncate">{label}</span>}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Nav container
// ─────────────────────────────────────────────────────────────────────────────

interface SidebarNavProps {
  collapsed: boolean;
  children: React.ReactNode;
  surface?: SidebarSurface;
}

export function SidebarNav({ collapsed, children }: SidebarNavProps): JSX.Element {
  return (
    <nav
      aria-label="Sidebar navigation"
      className={clsx(
        'flex-1 overflow-y-auto px-[var(--sidebar-gutter)] pt-0.5 pb-1',
        collapsed && 'flex flex-col items-stretch',
      )}
    >
      {children}
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Group
// ─────────────────────────────────────────────────────────────────────────────

interface SidebarGroupProps {
  label: string;
  collapsed: boolean;
  children: React.ReactNode;
  surface?: SidebarSurface;
  groupId?: string;
}

export function SidebarGroup({
  label,
  collapsed,
  children,
  surface = 'project',
  groupId,
}: SidebarGroupProps): JSX.Element {
  if (collapsed) {
    const sepClass =
      surface === 'admin'
        ? 'my-2 h-px bg-[hsl(var(--admin-sidebar-muted))] mx-1'
        : 'my-2 h-px bg-[hsl(var(--border))] mx-1';
    return (
      <div data-testid={groupId ? `sidebar-group-${groupId}` : undefined}>
        <div className={sepClass} aria-hidden="true" />
        <div className="space-y-1">{children}</div>
      </div>
    );
  }

  const labelColor = surface === 'admin' ? 'text-[hsl(var(--admin-sidebar-text))]' : 'text-muted';

  return (
    <div data-testid={groupId ? `sidebar-group-${groupId}` : undefined}>
      <div
        className={clsx(
          'text-[10px] font-medium uppercase tracking-[0.07em] px-[var(--sidebar-gutter)] pt-1 pb-0.5',
          labelColor,
        )}
      >
        {label}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Label overflow affordance
// ─────────────────────────────────────────────────────────────────────────────

export function useSidebarLabelOverflow(label: string, enabled: boolean) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [labelOverflows, setLabelOverflows] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setLabelOverflows(false);
      return;
    }

    const element = labelRef.current;
    if (!element) {
      setLabelOverflows(false);
      return;
    }

    const updateOverflow = () => {
      setLabelOverflows(element.scrollWidth > element.clientWidth);
    };

    updateOverflow();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateOverflow);
      return () => window.removeEventListener('resize', updateOverflow);
    }

    const resizeObserver = new ResizeObserver(updateOverflow);
    resizeObserver.observe(element);

    return () => resizeObserver.disconnect();
  }, [enabled, label]);

  return { labelRef, labelOverflows };
}

interface SidebarLabelTooltipProps {
  content: string;
  enabled: boolean;
  children: JSX.Element;
}

export function SidebarLabelTooltip({
  content,
  enabled,
  children,
}: SidebarLabelTooltipProps): JSX.Element {
  if (!enabled) {
    return children;
  }

  return (
    <TooltipProvider>
      <Tooltip content={content} side="right">
        {children}
      </Tooltip>
    </TooltipProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Nav item
// ─────────────────────────────────────────────────────────────────────────────

interface SidebarNavItemProps {
  section: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  isActive: boolean;
  collapsed: boolean;
  onClick: () => void;
  surface?: SidebarSurface;
  isDirty?: boolean;
  count?: number;
  title?: string;
}

export function SidebarNavItem({
  section,
  label,
  Icon,
  isActive,
  collapsed,
  onClick,
  surface = 'project',
  isDirty,
  count,
  title,
}: SidebarNavItemProps): JSX.Element {
  const isAdmin = surface === 'admin';
  const tooltipContent = title ?? label;
  const { labelRef, labelOverflows } = useSidebarLabelOverflow(label, !collapsed);
  const showTooltip = collapsed || labelOverflows;

  const inactiveIcon = isAdmin ? 'text-[hsl(var(--admin-sidebar-text))]' : 'text-foreground';
  const inactiveText = isAdmin
    ? 'text-[hsl(var(--admin-sidebar-text))] font-normal'
    : 'text-foreground font-normal';
  const inactiveHover = isAdmin
    ? 'hover:bg-[hsl(var(--admin-sidebar-hover))]'
    : 'hover:bg-[hsl(var(--sidebar-hover))]';
  const activeBg = isAdmin
    ? 'bg-[hsl(var(--admin-sidebar-active-bg))]'
    : 'bg-[hsl(var(--color-brand-active-bg))]';

  return (
    <SidebarLabelTooltip content={tooltipContent} enabled={showTooltip}>
      <button
        type="button"
        onClick={onClick}
        title={tooltipContent}
        aria-current={isActive ? 'page' : undefined}
        data-testid={`sidebar-nav-${section}`}
        className={clsx(
          'w-full relative flex items-center gap-2 rounded text-sm tracking-[-0.01em] transition-default',
          collapsed
            ? 'justify-center px-0 py-[var(--sidebar-item-py)]'
            : 'px-[var(--sidebar-gutter)] py-[var(--sidebar-item-py)]',
          isActive
            ? clsx(activeBg, 'font-medium border-l-2 border-[hsl(var(--color-brand-primary))]')
            : clsx(inactiveText, inactiveHover),
        )}
      >
        <span className="relative shrink-0 w-4 h-4 flex items-center justify-center">
          <Icon
            className={clsx(
              'w-4 h-4',
              isActive ? 'text-[hsl(var(--color-brand-active-text))]' : inactiveIcon,
            )}
          />
          {isDirty && (
            <span
              aria-hidden="true"
              className="absolute -top-0.5 -right-0.5 w-1 h-1 bg-accent rounded-full"
            />
          )}
        </span>
        {!collapsed && (
          <span
            ref={labelRef}
            className={clsx(
              'truncate flex-1 text-left',
              isActive ? 'text-[hsl(var(--color-brand-active-text))]' : undefined,
            )}
          >
            {label}
          </span>
        )}
        {!collapsed && typeof count === 'number' && (
          <span className="text-xs tabular-nums text-foreground-muted ml-auto bg-background-muted px-1.5 py-0.5 rounded-full">
            {count}
          </span>
        )}
      </button>
    </SidebarLabelTooltip>
  );
}
