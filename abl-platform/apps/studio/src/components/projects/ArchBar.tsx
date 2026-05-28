/**
 * ArchBar Component
 *
 * Replaces the plain search input on the home page.
 * Two states: collapsed (resting bar) and expanded (cmdk dropdown).
 *
 * - Collapsed: full-width button with animated placeholder cycling
 * - Expanded: cmdk-powered dropdown with recent projects, search, and Arch suggestions
 * - Cmd+K toggles, Escape closes
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Command } from 'cmdk';
import { motion, AnimatePresence } from 'framer-motion';
import { Folder, Clock, Sparkles, FileText, Search } from 'lucide-react';
import { ArchIcon } from '@/components/arch-shared/ArchIcon';
import { useProjectStore, type Project } from '../../store/project-store';
import { useNavigationStore } from '../../store/navigation-store';
import { useArchAIStore } from '../../lib/arch-ai/store/arch-ai-store';
import { springs, transitions } from '../../lib/animation';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Number of recent projects to show */
const RECENT_PROJECT_COUNT = 3;

/** Interval between placeholder text cycling (ms) */
const PLACEHOLDER_CYCLE_MS = 3500;

// =============================================================================
// TYPES
// =============================================================================

interface ArchBarProps {
  onArchExpand?: () => void; // Future: hook for full-screen Arch chat overlay
  onCreateFromScratch?: () => void; // Opens non-Arc create project modal
}

// =============================================================================
// HELPERS
// =============================================================================

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return date.toLocaleDateString();
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ArchBar({ onArchExpand, onCreateFromScratch }: ArchBarProps) {
  const t = useTranslations('arch_bar');
  const [isExpanded, setIsExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Stores
  const projects = useProjectStore((s) => s.projects);
  const navigate = useNavigationStore((s) => s.navigate);
  const area = useNavigationStore((s) => s.area);
  // Placeholder texts that cycle
  const placeholders = [
    t('placeholder_search'),
    t('placeholder_ask'),
    t('placeholder_create'),
    t('placeholder_find'),
  ];

  // Cycle placeholder text
  useEffect(() => {
    if (isExpanded) return;

    const interval = setInterval(() => {
      setPlaceholderIndex((prev) => (prev + 1) % placeholders.length);
    }, PLACEHOLDER_CYCLE_MS);

    return () => clearInterval(interval);
  }, [isExpanded, placeholders.length]);

  // Cmd+K handler — only on home page
  useEffect(() => {
    if (area !== 'projects') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsExpanded((prev) => !prev);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [area]);

  // Focus input when expanded
  useEffect(() => {
    if (isExpanded) {
      // Allow animation to start before focusing
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
    setSearch('');
  }, [isExpanded]);

  // Recent projects (top 3 by updatedAt, deduplicated by name — keep most recent)
  const recentProjects = [...projects]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .filter((project, i, arr) => arr.findIndex((p) => p.name === project.name) === i)
    .slice(0, RECENT_PROJECT_COUNT);

  // Check if search has matching projects
  const hasSearchResults =
    search.trim() !== '' &&
    projects.some((p) => p.name.toLowerCase().includes(search.toLowerCase()));

  const handleOpen = useCallback(() => {
    setIsExpanded(true);
    onArchExpand?.();
  }, [onArchExpand]);

  const handleClose = useCallback(() => {
    setIsExpanded(false);
  }, []);

  const handleSelectProject = useCallback(
    (project: Project) => {
      navigate(`/projects/${project.id}`);
      setIsExpanded(false);
    },
    [navigate],
  );

  const handleCreateWithArch = useCallback(
    (query?: string) => {
      useArchAIStore.getState().reset();
      if (query) {
        const message = `help me create ${query}`;
        useArchAIStore.getState().setPrefillMessage(message);
      }
      navigate('/arch');
      setIsExpanded(false);
    },
    [navigate],
  );

  const handleCreateFromScratch = useCallback(() => {
    setIsExpanded(false);
    onCreateFromScratch?.();
  }, [onCreateFromScratch]);

  return (
    <div className="relative w-full">
      {/* Collapsed bar */}
      <motion.button
        type="button"
        onClick={handleOpen}
        className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-background-elevated/80 backdrop-blur-xl border border-border-muted hover:border-accent/40 hover:scale-[1.005] hover:shadow-lg hover:shadow-accent/5 transition-all duration-200 cursor-pointer group"
      >
        <Search className="w-4 h-4 text-muted shrink-0 group-hover:text-foreground transition-colors" />

        {/* Animated placeholder */}
        <div className="flex-1 text-left overflow-hidden">
          <AnimatePresence mode="wait">
            <motion.span
              key={placeholderIndex}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="block text-sm text-muted"
            >
              {placeholders[placeholderIndex]}
            </motion.span>
          </AnimatePresence>
        </div>

        {/* Cmd+K badge */}
        <kbd className="hidden sm:inline-flex items-center gap-1 px-2 py-1 text-xs text-subtle bg-background-muted rounded border border-default shrink-0">
          <span className="text-[10px]">&#8984;</span>K
        </kbd>
      </motion.button>

      {/* Expanded state — cmdk dropdown */}
      <AnimatePresence>
        {isExpanded && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={transitions.backdrop}
              className="fixed inset-0 bg-overlay backdrop-blur-sm z-40"
              onClick={handleClose}
            />

            {/* Command dropdown */}
            <motion.div
              initial={{ opacity: 0, scale: 0.98, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: -4 }}
              transition={springs.default}
              className="absolute top-0 left-0 right-0 z-50"
            >
              <Command
                className="bg-background-elevated border border-default rounded-xl shadow-xl overflow-hidden bg-noise"
                loop
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    handleClose();
                  }
                }}
              >
                {/* Search input */}
                <div className="flex items-center gap-3 px-4 border-b border-default">
                  <Search className="w-4 h-4 text-muted shrink-0" />
                  <Command.Input
                    ref={inputRef}
                    value={search}
                    onValueChange={setSearch}
                    placeholder={t('placeholder_search')}
                    className="flex-1 py-4 bg-transparent text-foreground outline-none placeholder:text-subtle"
                  />
                  <kbd className="hidden sm:inline-flex items-center gap-1 px-2 py-1 text-xs text-subtle bg-background-muted rounded border border-default">
                    ESC
                  </kbd>
                </div>

                {/* Results */}
                <Command.List className="max-h-[320px] overflow-y-auto p-2">
                  {/* Recent Projects — shown when no search query */}
                  {!search && recentProjects.length > 0 && (
                    <Command.Group heading={t('recent_projects')}>
                      {recentProjects.map((project) => (
                        <Command.Item
                          key={project.id}
                          value={project.name}
                          onSelect={() => handleSelectProject(project)}
                          className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-muted data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground transition-colors"
                        >
                          <Folder className="w-4 h-4 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">{project.name}</div>
                          </div>
                          <div className="flex items-center gap-1 text-xs text-subtle shrink-0">
                            <Clock className="w-3 h-3" />
                            <span>{formatRelativeDate(project.updatedAt)}</span>
                          </div>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}

                  {/* All Projects — shown when search query exists */}
                  {search && (
                    <Command.Group heading={t('all_projects')}>
                      {projects.map((project) => (
                        <Command.Item
                          key={project.id}
                          value={project.name}
                          onSelect={() => handleSelectProject(project)}
                          className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-muted data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground transition-colors"
                        >
                          <Folder className="w-4 h-4 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">{project.name}</div>
                          </div>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}

                  {/* Create with Arch — shown when search has no matching projects */}
                  {search.trim() && !hasSearchResults && (
                    <Command.Group forceMount>
                      <Command.Item
                        value={`create-with-arch-${search}`}
                        onSelect={() => handleCreateWithArch(search.trim())}
                        forceMount
                        className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-muted data-[selected=true]:bg-purple-subtle data-[selected=true]:text-purple transition-colors"
                      >
                        <Sparkles className="w-4 h-4 shrink-0 text-purple" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium">
                            Create with Arch{' '}
                            <span className="text-purple">&ldquo;{search.trim()}&rdquo;</span>
                          </div>
                        </div>
                      </Command.Item>
                    </Command.Group>
                  )}

                  {/* Start with Arch AI — always visible */}
                  <Command.Group forceMount>
                    <Command.Item
                      value="start-with-arch-ai"
                      onSelect={() => handleCreateWithArch()}
                      forceMount
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-muted data-[selected=true]:bg-purple-subtle data-[selected=true]:text-purple transition-colors"
                    >
                      <ArchIcon size={16} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium flex items-center gap-2">
                          Start with Arch
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple/20 text-purple tracking-wide">
                            BETA
                          </span>
                        </div>
                      </div>
                    </Command.Item>
                  </Command.Group>

                  {/* Create from scratch — always visible */}
                  <Command.Group forceMount>
                    <Command.Item
                      value="create-from-scratch"
                      onSelect={handleCreateFromScratch}
                      forceMount
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-muted data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground transition-colors"
                    >
                      <FileText className="w-4 h-4 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium">{t('create_from_scratch')}</div>
                      </div>
                    </Command.Item>
                  </Command.Group>
                </Command.List>

                {/* Footer */}
                <div className="flex items-center gap-4 px-4 py-2 border-t border-default bg-background-muted/50 text-xs text-subtle">
                  <span className="flex items-center gap-1">
                    <kbd className="px-1.5 py-0.5 bg-background-muted rounded text-xs">
                      &#8593;&#8595;
                    </kbd>
                    {t('footer_navigate')}
                  </span>
                  <span className="flex items-center gap-1">
                    <kbd className="px-1.5 py-0.5 bg-background-muted rounded text-xs">&#8629;</kbd>
                    {t('footer_select')}
                  </span>
                  <span className="flex items-center gap-1">
                    <kbd className="px-1.5 py-0.5 bg-background-muted rounded text-xs">esc</kbd>
                    {t('footer_close')}
                  </span>
                </div>
              </Command>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
