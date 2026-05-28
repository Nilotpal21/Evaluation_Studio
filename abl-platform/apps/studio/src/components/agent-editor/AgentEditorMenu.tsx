/**
 * AgentEditorMenu Component
 *
 * Left sidebar navigation for the unified agent editor.
 * Mirrors the ProjectSidebar visual tokens, spacing, and animation patterns.
 */

import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { usePortalDropdown } from '../../hooks/usePortalDropdown';
import { useNavigationStore } from '../../store/navigation-store';
import {
  Sparkles,
  Settings2,
  Wrench,
  ClipboardList,
  Brain,
  GitBranch,
  ShieldCheck,
  Shield,
  UserCog,
  ArrowRightLeft,
  RefreshCw,
  ArrowUpFromLine,
  Play,
  AlertTriangle,
  CheckCircle2,
  FileText,
  Code,
  ChevronsUpDown,
  Bot,
} from 'lucide-react';
import { clsx } from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { AGENT_EDITOR_CONFIG } from './agent-editor-config';
import type { EditorSection, MenuGroup, MenuItemDef, SectionDataMap } from './types';
import {
  SidebarContainer,
  SidebarCollapseButton,
  SidebarBackIconButton,
  SidebarBackButton,
  SidebarNav,
  SidebarGroup,
  SidebarNavItem,
} from '../navigation/sidebar-primitives';

// =============================================================================
// MENU GROUPS DEFINITION
// =============================================================================

export const menuGroups: MenuGroup[] = [
  {
    id: 'identity',
    label: 'identity',
    items: [
      { section: 'identity', label: 'goal_persona', Icon: Sparkles },
      { section: 'execution', label: 'execution', Icon: Settings2 },
    ],
  },
  {
    id: 'capabilities',
    label: 'capabilities',
    items: [
      {
        section: 'tools',
        label: 'tools',
        Icon: Wrench,
        countFn: (data) => data.tools.length,
      },
      {
        section: 'gather',
        label: 'gather_fields',
        Icon: ClipboardList,
        countFn: (data) => data.gather.length,
      },
      { section: 'memory', label: 'memory', Icon: Brain },
    ],
  },
  {
    id: 'behavior',
    label: 'behavior',
    items: [
      {
        section: 'flow',
        label: 'flow_steps',
        Icon: GitBranch,
        countFn: (data) => data.flow?.steps.length ?? 0,
      },
      {
        section: 'constraints',
        label: 'constraints',
        Icon: ShieldCheck,
        countFn: (data) => data.constraints.length,
      },
      {
        section: 'guardrails',
        label: 'guardrails',
        Icon: Shield,
        countFn: (data) => data.guardrails.length,
      },
      {
        section: 'behavior',
        label: 'behavior_profiles',
        Icon: UserCog,
        countFn: (data) =>
          data.behavior.profiles.length + (data.behavior.conversationBehavior ? 1 : 0),
      },
    ],
  },
  {
    id: 'coordination',
    label: 'coordination',
    items: [
      {
        section: 'handoffs',
        label: 'handoffs',
        Icon: ArrowRightLeft,
        countFn: (data) => data.handoffs.length,
      },
      {
        section: 'delegates',
        label: 'delegates',
        Icon: RefreshCw,
        countFn: (data) => data.delegates.length,
      },
      {
        section: 'escalation',
        label: 'escalation',
        Icon: ArrowUpFromLine,
        countFn: (data) => data.escalation.triggers.length,
      },
    ],
  },
  {
    id: 'lifecycle',
    label: 'lifecycle',
    items: [
      { section: 'onStart', label: 'on_start', Icon: Play },
      {
        section: 'errorHandling',
        label: 'error_handling',
        Icon: AlertTriangle,
        countFn: (data) => data.errorHandling.length,
      },
      {
        section: 'completion',
        label: 'completion',
        Icon: CheckCircle2,
        countFn: (data) => data.completion.length,
      },
      {
        section: 'templates',
        label: 'templates_messages',
        Icon: FileText,
        countFn: (data) => data.templates.length,
      },
    ],
  },
];

export const bottomItem: MenuItemDef = {
  section: 'definition',
  label: 'definition',
  Icon: Code,
};

// =============================================================================
// COMPONENT
// =============================================================================

interface AgentEditorMenuProps {
  activeSection: EditorSection;
  onSectionChange: (section: EditorSection) => void;
  sectionData: SectionDataMap;
  visibleSections: EditorSection[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  dirtySections: Set<EditorSection>;
  /** Agent header — shown at top of nav in page mode */
  agentName?: string;
  agents?: Array<{ name: string }>;
  onAgentSwitch?: (name: string) => void;
  onBack?: () => void;
}

export function AgentEditorMenu({
  activeSection,
  onSectionChange,
  sectionData,
  visibleSections,
  collapsed,
  onToggleCollapse,
  dirtySections,
  agentName,
  agents,
  onAgentSwitch,
  onBack,
}: AgentEditorMenuProps) {
  const t = useTranslations('agent_editor.menu');
  const visibleSet = useMemo(() => new Set(visibleSections), [visibleSections]);
  const hasMultipleAgents = Boolean(agents && agents.length > 1);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [agentSearch, setAgentSearch] = useState('');
  const switcherTriggerRef = useRef<HTMLButtonElement>(null);
  const switcherDropdownRef = useRef<HTMLDivElement>(null);
  const { coords: switcherCoords, updateCoords: updateSwitcherCoords } = usePortalDropdown(
    switcherTriggerRef,
    { align: 'left', gap: 4 },
  );
  const navigate = useNavigationStore((s) => s.navigate);
  const projectId = useNavigationStore((s) => s.projectId);

  // Close switcher on click outside — listener only attached while open.
  useEffect(() => {
    if (!switcherOpen) return;
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (
        !switcherTriggerRef.current?.contains(target) &&
        !switcherDropdownRef.current?.contains(target)
      ) {
        setSwitcherOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [switcherOpen]);

  const renderMenuItem = (item: MenuItemDef) => {
    if (!visibleSet.has(item.section)) return null;

    const isActive = activeSection === item.section;
    const count = item.countFn ? item.countFn(sectionData) : 0;
    const isDirty = dirtySections.has(item.section);
    const label = t(`item.${item.label}`);

    return (
      <SidebarNavItem
        key={item.section}
        section={item.section}
        label={label}
        Icon={item.Icon}
        isActive={isActive}
        collapsed={collapsed}
        onClick={() => onSectionChange(item.section)}
        surface="agent"
        isDirty={isDirty}
        count={count > 0 ? count : undefined}
      />
    );
  };

  const renderGroup = (group: MenuGroup) => {
    const visibleItems = group.items.filter((item) => visibleSet.has(item.section));
    if (visibleItems.length === 0) return null;

    return (
      <SidebarGroup
        key={group.id}
        label={t(`group.${group.label}`)}
        collapsed={collapsed}
        surface="agent"
        groupId={group.id}
      >
        {visibleItems.map(renderMenuItem)}
      </SidebarGroup>
    );
  };

  return (
    <>
      <SidebarContainer
        surface="agent"
        collapsed={collapsed}
        width={AGENT_EDITOR_CONFIG.menu.width}
        collapsedWidth={AGENT_EDITOR_CONFIG.menu.collapsedWidth}
        ariaLabel="Agent editor menu"
      >
        {/* Back row — only rendered when onBack is provided */}
        {onBack && (
          <div
            className={clsx(
              'flex items-center shrink-0 h-12 border-b border-default',
              collapsed ? 'justify-center px-0' : 'px-[var(--sidebar-gutter)]',
            )}
          >
            {collapsed ? (
              <SidebarBackIconButton
                onClick={onBack}
                surface="agent"
                ariaLabel="Back"
                title="Back"
              />
            ) : (
              <SidebarBackButton onClick={onBack} surface="agent" label="Back" />
            )}
          </div>
        )}

        {/* Agent switcher row + collapse toggle */}
        {collapsed ? (
          <>
            {agentName && (
              <div className="h-12 flex items-center justify-center shrink-0">
                <button
                  ref={switcherTriggerRef}
                  onClick={
                    hasMultipleAgents
                      ? () => {
                          if (!switcherOpen) updateSwitcherCoords();
                          setSwitcherOpen(!switcherOpen);
                        }
                      : undefined
                  }
                  aria-label={t('switch_agent')}
                  aria-expanded={switcherOpen}
                  aria-haspopup="listbox"
                  title={agentName}
                  className={clsx(
                    'w-6 h-6 rounded bg-accent flex items-center justify-center text-accent-foreground',
                    hasMultipleAgents
                      ? 'hover:opacity-80 cursor-pointer transition-default'
                      : 'cursor-default',
                  )}
                >
                  <Bot className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            <div className="h-12 flex items-center justify-center shrink-0">
              <SidebarCollapseButton
                collapsed={collapsed}
                onToggle={onToggleCollapse}
                surface="agent"
                data-testid="agent-editor-menu-expand"
                ariaLabel={t('expand')}
                title={t('expand')}
              />
            </div>
          </>
        ) : (
          <div className="h-12 flex items-center gap-1 px-[var(--sidebar-gutter)] shrink-0">
            {agentName ? (
              <button
                ref={switcherTriggerRef}
                onClick={
                  hasMultipleAgents
                    ? () => {
                        if (!switcherOpen) updateSwitcherCoords();
                        setSwitcherOpen(!switcherOpen);
                      }
                    : undefined
                }
                aria-label={t('switch_agent')}
                aria-expanded={switcherOpen}
                aria-haspopup="listbox"
                title={agentName}
                className={clsx(
                  'flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded text-left transition-default',
                  hasMultipleAgents
                    ? 'hover:bg-[hsl(var(--sidebar-hover))] cursor-pointer'
                    : 'cursor-default',
                )}
              >
                <div className="w-5 h-5 rounded bg-accent flex items-center justify-center text-accent-foreground text-xs font-bold shrink-0">
                  <Bot className="w-3.5 h-3.5" />
                </div>
                <span className="text-sm font-normal text-foreground truncate flex-1 min-w-0">
                  {agentName}
                </span>
                {hasMultipleAgents && (
                  <ChevronsUpDown className="w-3.5 h-3.5 text-subtle shrink-0" />
                )}
              </button>
            ) : (
              <div className="flex-1" />
            )}
            <SidebarCollapseButton
              collapsed={collapsed}
              onToggle={onToggleCollapse}
              surface="agent"
              data-testid="agent-editor-menu-collapse"
              ariaLabel={t('collapse')}
              title={t('collapse')}
            />
          </div>
        )}

        {/* Scrollable navigation */}
        <SidebarNav collapsed={collapsed}>
          {collapsed && (
            <div className="my-2 h-px bg-[hsl(var(--border))] mx-1" aria-hidden="true" />
          )}
          {menuGroups.map(renderGroup)}
        </SidebarNav>
      </SidebarContainer>

      {/* Agent switcher dropdown — portalled to body to escape sidebar stacking context */}
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {switcherOpen && agents && switcherCoords && (
              <motion.div
                ref={switcherDropdownRef}
                style={switcherCoords}
                initial={{ opacity: 0, y: 4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.98 }}
                transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
                role="listbox"
                className="w-56 bg-[hsl(var(--background-elevated))] border border-default rounded-xl shadow-xl z-portal-dropdown overflow-hidden"
              >
                <div className="px-2 pt-2 pb-1">
                  <input
                    type="text"
                    value={agentSearch}
                    onChange={(e) => setAgentSearch(e.target.value)}
                    placeholder={t('search_agents_placeholder')}
                    className="w-full px-2 py-1 text-xs bg-background border border-default rounded text-foreground placeholder:text-foreground-subtle focus:outline-none focus:border-[hsl(var(--border-focus))]"
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
                <div className="max-h-48 overflow-y-auto py-1">
                  {agents
                    .filter((a) => a.name.toLowerCase().includes(agentSearch.toLowerCase()))
                    .map((a) => (
                      <button
                        key={a.name}
                        role="option"
                        aria-selected={a.name === agentName}
                        title={a.name}
                        onClick={() => {
                          onAgentSwitch?.(a.name);
                          setSwitcherOpen(false);
                        }}
                        className={clsx(
                          'w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-default',
                          a.name === agentName
                            ? 'bg-accent-subtle text-accent'
                            : 'text-muted hover:text-foreground hover:bg-background-muted',
                        )}
                      >
                        <div className="w-5 h-5 rounded bg-background-muted flex items-center justify-center shrink-0">
                          <Bot className="w-3 h-3" />
                        </div>
                        <span className="truncate">{a.name}</span>
                      </button>
                    ))}
                </div>
                <div className="border-t border-default">
                  <button
                    onClick={() => {
                      if (projectId) navigate(`/projects/${projectId}/agents`);
                      setSwitcherOpen(false);
                    }}
                    className="w-full px-3 py-2 text-xs text-left text-muted hover:text-foreground hover:bg-background-muted transition-default"
                  >
                    {t('view_all_agents')}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}
