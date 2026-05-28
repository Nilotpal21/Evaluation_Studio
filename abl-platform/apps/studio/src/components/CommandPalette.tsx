/**
 * Command Palette Component
 *
 * ⌘K / Ctrl+K to open. Provides quick access to:
 * - Navigation between views
 * - Loading apps and agents
 * - Actions like reset, clear, etc.
 *
 * Inspired by Linear, Vercel, and Raycast.
 */

import { useEffect, useState, useCallback } from 'react';
import { Command } from 'cmdk';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search,
  GitBranch,
  MessageSquare,
  Columns,
  Layers,
  Bot,
  FolderOpen,
  Trash2,
  Keyboard,
  Database,
  History,
  Code2,
  Activity,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useObservatoryStore } from '../store/observatory-store';
import { useOptionalWebSocketContext } from '../contexts/WebSocketContext';
import { useAvailableApps } from '../hooks/useAvailableApps';
import { useSessionStore } from '../store/session-store';
import { useNavigationStore } from '../store/navigation-store';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const [search, setSearch] = useState('');
  const t = useTranslations('command_palette');

  // Store actions
  const setCanvasViewMode = useObservatoryStore((s) => s.setCanvasViewMode);
  const setDebugPanelTab = useObservatoryStore((s) => s.setDebugPanelTab);
  const clearEvents = useObservatoryStore((s) => s.clearEvents);
  const { availableApps, fetchApps, loadApp } = useAvailableApps();
  const wsContext = useOptionalWebSocketContext();
  const agent = useSessionStore((s) => s.agent);

  // Fetch apps when palette opens
  useEffect(() => {
    if (open && availableApps.length === 0) {
      fetchApps();
    }
  }, [open, availableApps.length, fetchApps]);

  // Reset search when closing
  useEffect(() => {
    if (!open) {
      setSearch('');
    }
  }, [open]);

  const runCommand = useCallback(
    (command: () => void) => {
      command();
      onOpenChange(false);
    },
    [onOpenChange],
  );

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 bg-overlay backdrop-blur-sm z-50"
            onClick={() => onOpenChange(false)}
          />

          {/* Command palette */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -20 }}
            transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
            className="fixed top-[20%] left-1/2 -translate-x-1/2 w-full max-w-xl z-50"
          >
            <Command
              className="bg-background-elevated border border-default rounded-xl shadow-xl overflow-hidden bg-noise"
              loop
            >
              {/* Search input */}
              <div className="flex items-center gap-3 px-4 border-b border-default">
                <Search className="w-4 h-4 text-muted shrink-0" />
                <Command.Input
                  value={search}
                  onValueChange={setSearch}
                  placeholder={t('placeholder')}
                  className="flex-1 py-4 bg-transparent text-foreground outline-none placeholder:text-subtle"
                />
                <kbd className="hidden sm:inline-flex items-center gap-1 px-2 py-1 text-xs text-subtle bg-background-muted rounded border border-default">
                  ESC
                </kbd>
              </div>

              {/* Results */}
              <Command.List className="max-h-[400px] overflow-y-auto p-2">
                <Command.Empty className="py-8 text-center text-muted text-sm">
                  {t('no_results')}
                </Command.Empty>

                {/* View Modes */}
                <Command.Group heading={t('group_view_mode')}>
                  <CommandItem
                    icon={GitBranch}
                    label={t('graph_view')}
                    shortcut="⌘1"
                    onSelect={() => runCommand(() => setCanvasViewMode('graph'))}
                  />
                  <CommandItem
                    icon={MessageSquare}
                    label={t('chat_view')}
                    shortcut="⌘2"
                    onSelect={() => runCommand(() => setCanvasViewMode('chat'))}
                  />
                  <CommandItem
                    icon={Columns}
                    label={t('split_view')}
                    shortcut="⌘3"
                    onSelect={() => runCommand(() => setCanvasViewMode('split'))}
                  />
                  <CommandItem
                    icon={Layers}
                    label={t('app_view')}
                    shortcut="⌘4"
                    onSelect={() => runCommand(() => setCanvasViewMode('app'))}
                  />
                </Command.Group>

                {/* Debug Tabs */}
                <Command.Group heading={t('group_debug_panel')}>
                  <CommandItem
                    icon={Database}
                    label={t('data_tab')}
                    onSelect={() => runCommand(() => setDebugPanelTab('data'))}
                  />
                  <CommandItem
                    icon={History}
                    label={t('conversation_tab')}
                    onSelect={() => runCommand(() => setDebugPanelTab('conversation'))}
                  />
                  <CommandItem
                    icon={Code2}
                    label={t('ir_tab')}
                    onSelect={() => runCommand(() => setDebugPanelTab('ir'))}
                  />
                  <CommandItem
                    icon={Activity}
                    label={t('performance_tab')}
                    onSelect={() => runCommand(() => setDebugPanelTab('performance'))}
                  />
                </Command.Group>

                {/* Apps */}
                {availableApps.length > 0 && (
                  <Command.Group heading={t('group_load_app')}>
                    {availableApps.map((app) => (
                      <CommandItem
                        key={app.domain}
                        icon={FolderOpen}
                        label={app.name}
                        description={t('agents_count', { count: app.agentCount })}
                        onSelect={() => runCommand(() => void loadApp(app.domain))}
                      />
                    ))}
                  </Command.Group>
                )}

                {/* Actions */}
                <Command.Group heading={t('group_actions')}>
                  <CommandItem
                    icon={Trash2}
                    label={t('clear_events')}
                    description={t('clear_events_description')}
                    onSelect={() => runCommand(() => clearEvents())}
                  />
                </Command.Group>

                {/* Help */}
                <Command.Group heading={t('group_help')}>
                  <CommandItem
                    icon={Keyboard}
                    label={t('keyboard_shortcuts')}
                    description={t('keyboard_shortcuts_description')}
                    onSelect={() =>
                      runCommand(() => {
                        // TODO: Show keyboard shortcuts modal
                      })
                    }
                  />
                </Command.Group>
              </Command.List>

              {/* Footer */}
              <div className="flex items-center justify-between px-4 py-2 border-t border-default bg-background-muted/50">
                <div className="flex items-center gap-4 text-xs text-subtle">
                  <span className="flex items-center gap-1">
                    <kbd className="px-1.5 py-0.5 bg-background-muted rounded text-xs">↑↓</kbd>
                    {t('footer_navigate')}
                  </span>
                  <span className="flex items-center gap-1">
                    <kbd className="px-1.5 py-0.5 bg-background-muted rounded text-xs">↵</kbd>
                    {t('footer_select')}
                  </span>
                  <span className="flex items-center gap-1">
                    <kbd className="px-1.5 py-0.5 bg-background-muted rounded text-xs">esc</kbd>
                    {t('footer_close')}
                  </span>
                </div>
                {agent && (
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <Bot className="w-3 h-3" />
                    <span>{agent.name}</span>
                  </div>
                )}
              </div>
            </Command>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// Command item component
interface CommandItemProps {
  icon: React.ElementType;
  label: string;
  description?: string;
  shortcut?: string;
  onSelect: () => void;
}

function CommandItem({ icon: Icon, label, description, shortcut, onSelect }: CommandItemProps) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-muted data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground transition-colors"
    >
      <Icon className="w-4 h-4 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {description && <div className="text-xs text-subtle truncate">{description}</div>}
      </div>
      {shortcut && (
        <kbd className="px-1.5 py-0.5 text-xs bg-background-muted rounded border border-default text-subtle">
          {shortcut}
        </kbd>
      )}
    </Command.Item>
  );
}

/**
 * Hook to manage command palette state with keyboard shortcuts.
 * Disabled on the projects home page where the ArchBar handles ⌘K.
 */
export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  const area = useNavigationStore((s) => s.area);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // ⌘K or Ctrl+K to toggle — skip on projects page (ArchBar handles it)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        if (area === 'projects') return;
        e.preventDefault();
        setOpen((prev) => !prev);
      }

      // Escape to close
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, area]);

  return { open, setOpen };
}

export default CommandPalette;
