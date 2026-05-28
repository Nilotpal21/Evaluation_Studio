/**
 * UniversalSearch Component
 *
 * Search through all navigation items and quickly jump to them.
 * Appears as an icon button in the header that opens a search dropdown.
 * Dynamically includes tools, workflows, and knowledge bases from the project.
 */

import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X } from 'lucide-react';
import { clsx } from 'clsx';
import {
  Bot,
  Workflow,
  LayoutDashboard,
  Wrench,
  BookOpen,
  Plug,
  FlaskConical,
  MessageSquare,
  Rocket,
  Inbox,
  Bell,
  TrendingUp,
  Activity,
  Eye,
  Sparkles,
  ShieldAlert,
  Landmark,
  Settings,
  Key,
  Cpu,
  Variable,
  GitBranch,
  Cog,
  LineChart,
  Phone,
  Shield,
  PhoneForwarded,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useNavigationStore, type ProjectPage } from '../../store/navigation-store';
import { fetchTools } from '../../api/tools';
import { listWorkflows } from '../../api/workflows';
import { fetchKnowledgeBases } from '../../api/search-ai';
import { menuGroups } from '../agent-editor/AgentEditorMenu';
import { useAgentEditorStore } from '../agent-editor/hooks/useAgentEditorStore';
import { getAllNavItems } from '../../config/navigation';
import type { EditorSection } from '../agent-editor/types';
import { usePortalDropdown } from '../../hooks/usePortalDropdown';
import { useFeatures } from '../../hooks/use-features';

interface SearchableItem {
  id: string;
  label: string;
  Icon: LucideIcon;
  group?: string;
  path: string;
  type: 'nav' | 'tool' | 'workflow' | 'knowledge-base' | 'agent-section';
}

interface UniversalSearchProps {
  className?: string;
  /** When true, renders a full-width "Search…" bar (for expanded sidebar). */
  sidebarExpanded?: boolean;
}

export function UniversalSearch({ className, sidebarExpanded }: UniversalSearchProps) {
  const t = useTranslations('nav');
  const tSearch = useTranslations('universal_search');
  const tAgentMenu = useTranslations('agent_editor.menu');
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoadingDynamic, setIsLoadingDynamic] = useState(false);
  const [dynamicItems, setDynamicItems] = useState<SearchableItem[]>([]);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { coords, updateCoords } = usePortalDropdown(buttonRef, { align: 'right', gap: 8 });
  const projectId = useNavigationStore((s) => s.projectId);
  const page = useNavigationStore((s) => s.page);
  const subPage = useNavigationStore((s) => s.subPage);
  const tab = useNavigationStore((s) => s.tab);
  const navigate = useNavigationStore((s) => s.navigate);
  const { hasGovernance } = useFeatures();

  // Detect if we're inside an agent editor
  const isInsideAgent = page === 'agents' && !!subPage && tab !== 'chat';

  // Get visible sections from agent editor store
  const visibleSections = useAgentEditorStore((s) => s.visibleSections);

  // Build static navigation items with translated labels
  const staticNavItems = useMemo<SearchableItem[]>(() => {
    // If inside agent, show agent editor menu items (filtered by visibleSections)
    if (isInsideAgent && projectId && subPage) {
      const agentItems: SearchableItem[] = [];
      const visibleSet = new Set(visibleSections);

      // Add items from agent menu groups that are visible
      menuGroups.forEach((group) => {
        group.items.forEach((item) => {
          // Only include sections that are visible
          if (visibleSet.has(item.section)) {
            agentItems.push({
              id: item.section,
              label: tAgentMenu(`item.${item.label}`),
              Icon: item.Icon,
              group: tAgentMenu(`group.${group.label}`),
              path: `/projects/${projectId}/agents/${subPage}`, // No hash - we use store method
              type: 'agent-section' as const,
            });
          }
        });
      });

      return agentItems;
    }

    // Otherwise, show project navigation items (from config)
    const navItems = getAllNavItems().filter((item) => item.id !== 'governance' || hasGovernance);
    return navItems.map((item) => ({
      id: item.id,
      label: t(item.key),
      Icon: item.Icon,
      group: item.group,
      path: `/projects/${projectId}/${item.id}`,
      type: 'nav' as const,
    }));
  }, [t, tAgentMenu, projectId, isInsideAgent, subPage, visibleSections, hasGovernance]);

  // Load dynamic items when search opens (tools, workflows, knowledge bases)
  // Only load for project-level context, not when inside agent
  useEffect(() => {
    if (!isOpen || !projectId || isInsideAgent) return;

    const loadDynamicItems = async () => {
      setIsLoadingDynamic(true);
      const items: SearchableItem[] = [];

      try {
        // Fetch tools
        const toolsData = await fetchTools(projectId, { limit: 100 });
        toolsData.data.forEach((tool) => {
          items.push({
            id: tool.id,
            label: tool.name,
            Icon: Wrench,
            group: 'tools',
            path: `/projects/${projectId}/tools/${tool.id}`,
            type: 'tool',
          });
        });
      } catch (err) {
        console.error('Failed to fetch tools:', err);
      }

      try {
        // Fetch workflows
        const workflows = await listWorkflows(projectId);
        workflows.forEach((workflow) => {
          items.push({
            id: workflow.id,
            label: workflow.name,
            Icon: Workflow,
            group: 'workflows',
            path: `/projects/${projectId}/workflows/${workflow.id}`,
            type: 'workflow',
          });
        });
      } catch (err) {
        console.error('Failed to fetch workflows:', err);
      }

      try {
        // Fetch knowledge bases
        const kbData = await fetchKnowledgeBases(projectId);
        kbData.knowledgeBases.forEach((kb) => {
          items.push({
            id: kb._id,
            label: kb.name,
            Icon: BookOpen,
            group: 'knowledge_bases',
            path: `/projects/${projectId}/search-ai/${kb._id}`,
            type: 'knowledge-base',
          });
        });
      } catch (err) {
        console.error('Failed to fetch knowledge bases:', err);
      }

      setDynamicItems(items);
      setIsLoadingDynamic(false);
    };

    loadDynamicItems();
  }, [isOpen, projectId, isInsideAgent]);

  // Combine static and dynamic items
  const allItems = useMemo(() => {
    return [...staticNavItems, ...dynamicItems];
  }, [staticNavItems, dynamicItems]);

  // Filter items based on query
  const filteredItems = useMemo(() => {
    if (!query.trim()) {
      // Show all navigation items + dynamic items
      return [...staticNavItems, ...dynamicItems];
    }

    const lowerQuery = query.toLowerCase();
    return allItems.filter((item) => item.label.toLowerCase().includes(lowerQuery)).slice(0, 15);
  }, [query, allItems, staticNavItems, dynamicItems]);

  // Focus input when dropdown opens
  useEffect(() => {
    if (isOpen) {
      updateCoords();
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      // Reset dynamic items when closing
      setDynamicItems([]);
      setQuery('');
    }
  }, [isOpen, updateCoords]);

  // Escape-to-close while dropdown is open. Cmd/Ctrl+K is owned by App.tsx
  // CommandPalette (and ArchBar on the projects home page); UniversalSearch
  // is click-only via the header icon.
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  // Handle keyboard navigation in results
  useEffect(() => {
    if (!isOpen || filteredItems.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filteredItems[selectedIndex]) {
          handleSelectItem(filteredItems[selectedIndex]);
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, filteredItems, selectedIndex]);

  // Reset selected index when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredItems]);

  // Close dropdown when clicking outside — listener only attached while open.
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleSelectItem = (item: SearchableItem) => {
    if (item.type === 'agent-section') {
      // For agent sections, call store method directly (like AgentEditorMenu does)
      const setActiveSection = useAgentEditorStore.getState().setActiveSection;
      setActiveSection(item.id as EditorSection);
      setIsOpen(false);
      setQuery('');
    } else {
      // For all other items, use URL navigation
      navigate(item.path);
      setIsOpen(false);
      setQuery('');
    }
  };

  // Get group label for display
  const getGroupLabel = (item: SearchableItem): string => {
    if (item.type === 'agent-section' && item.group) {
      return item.group;
    }
    if (item.type === 'nav' && item.group) {
      return t(`section_${item.group}`) || item.group;
    }
    // For dynamic items, use the type as the group
    switch (item.type) {
      case 'tool':
        return t('tools');
      case 'workflow':
        return t('workflows');
      case 'knowledge-base':
        return t('knowledge_bases');
      default:
        return '';
    }
  };

  // Determine if we're on Mac for keyboard shortcut display

  return (
    <div className={clsx('relative', className)}>
      {/* Trigger button — sidebar-expanded variant shows full-width bar */}
      {sidebarExpanded ? (
        <button
          ref={buttonRef}
          onClick={() => setIsOpen(!isOpen)}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded bg-[hsl(var(--sidebar-muted))] border border-[hsl(var(--sidebar-hover))] hover:bg-[hsl(var(--sidebar-hover))] text-sm text-foreground transition-default"
        >
          <Search className="w-4 h-4 shrink-0 text-foreground" />
          <span className="flex-1 text-left">{tSearch('placeholder')}</span>
        </button>
      ) : (
        <button
          ref={buttonRef}
          onClick={() => setIsOpen(!isOpen)}
          className="w-6 h-6 flex items-center justify-center rounded text-subtle hover:text-foreground hover:bg-[hsl(var(--sidebar-muted))] transition-default"
          title={tSearch('placeholder')}
        >
          <Search className="w-4 h-4" />
        </button>
      )}

      {/* Dropdown — portal-rendered to escape sidebar overflow:hidden */}
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {isOpen && coords && (
              <motion.div
                ref={dropdownRef}
                style={coords}
                initial={{ opacity: 0, y: -4, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.98 }}
                transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
                className="w-[480px] bg-background-elevated border border-default rounded-xl shadow-2xl overflow-hidden"
              >
                {/* Search input */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-default">
                  <Search className="w-4 h-4 text-subtle shrink-0" />
                  <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={tSearch('placeholder')}
                    className="flex-1 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-subtle"
                  />
                  {query && (
                    <button
                      onClick={() => setQuery('')}
                      className="p-1 text-muted hover:text-foreground rounded transition-default"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>

                {/* Results */}
                <div className="max-h-[60vh] overflow-y-auto">
                  {isLoadingDynamic && filteredItems.length === 0 ? (
                    <div className="py-8 px-4 text-center">
                      <p className="text-sm text-muted">{tSearch('loading')}</p>
                    </div>
                  ) : filteredItems.length > 0 ? (
                    <div className="py-1">
                      {filteredItems.map((item, index) => {
                        const isSelected = index === selectedIndex;
                        return (
                          <button
                            key={`${item.type}-${item.id}`}
                            onClick={() => handleSelectItem(item)}
                            onMouseEnter={() => setSelectedIndex(index)}
                            className={clsx(
                              'w-full flex items-center gap-3 px-3 py-2.5 text-left transition-default',
                              isSelected
                                ? 'bg-accent-subtle text-accent'
                                : 'text-foreground hover:bg-background-muted',
                            )}
                          >
                            <span
                              className={clsx(
                                'shrink-0 w-8 h-8 flex items-center justify-center rounded-md',
                                isSelected ? 'bg-accent/10' : 'bg-background-muted',
                              )}
                            >
                              <item.Icon
                                className={clsx(
                                  'w-4 h-4',
                                  isSelected ? 'text-accent' : 'text-subtle',
                                )}
                              />
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium truncate">{item.label}</div>
                              <div className="text-[10px] text-subtle uppercase tracking-wider mt-0.5">
                                {getGroupLabel(item)}
                              </div>
                            </div>
                            {isSelected && (
                              <kbd className="px-1.5 py-0.5 text-[10px] font-medium text-accent bg-accent/10 border border-accent/20 rounded">
                                ↵
                              </kbd>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="py-8 px-4 text-center">
                      <p className="text-sm text-muted">{tSearch('no_results')}</p>
                    </div>
                  )}
                </div>

                {/* Footer hint */}
                <div className="px-3 py-2 border-t border-default bg-background-subtle">
                  <div className="flex items-center gap-3 text-[10px] text-subtle">
                    <div className="flex items-center gap-1">
                      <kbd className="px-1 py-0.5 bg-background border border-default rounded">
                        ↑↓
                      </kbd>
                      <span>{tSearch('navigate_hint')}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <kbd className="px-1 py-0.5 bg-background border border-default rounded">
                        ↵
                      </kbd>
                      <span>{tSearch('select_hint')}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <kbd className="px-1 py-0.5 bg-background border border-default rounded">
                        esc
                      </kbd>
                      <span>{tSearch('close_hint')}</span>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </div>
  );
}
