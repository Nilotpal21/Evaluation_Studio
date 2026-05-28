'use client';

/**
 * USPHeader — Zone 1: Breadcrumb + Status Badge + Actions Menu
 *
 * Renders the page header with:
 * - Breadcrumb navigation (KB name → Source name, inline-editable)
 * - Status badge (8-state display state)
 * - Overflow menu with Rename, Recrawl, Edit Settings, Delete actions
 */

import { useCallback, useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { MoreVertical, RefreshCw, SlidersHorizontal, Trash2, Pencil } from 'lucide-react';
import { renameSource } from '@/api/search-ai';
import type { SearchAISource, KnowledgeBaseDetail } from '@/api/search-ai';
import type { DisplayState } from './types';
import { getBadgeConfig } from './utils';
import { useNavigationStore } from '@/store/navigation-store';
import { PageBreadcrumb } from '@/components/ui/PageBreadcrumb';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/DropdownMenu';

interface USPHeaderProps {
  source: SearchAISource;
  knowledgeBase: KnowledgeBaseDetail;
  displayState: DisplayState;
  projectId: string;
  kbId: string;
  indexId: string;
  /** Quick recrawl: same URLs, same config. Pass { force: true } to skip deduplication. */
  onRecrawl: (options?: { force?: boolean }) => void;
  /** Edit settings: go to wizard to change sections/settings */
  onReconfigure: () => void;
  onDeleteSource: () => void;
  /** Called after a successful rename so parent can refresh */
  onSourceRenamed?: () => void;
}

export function USPHeader({
  source,
  knowledgeBase,
  displayState,
  projectId,
  kbId,
  indexId,
  onRecrawl,
  onReconfigure,
  onDeleteSource,
  onSourceRenamed,
}: USPHeaderProps) {
  const navigate = useNavigationStore((s) => s.navigate);
  const t = useTranslations('search_ai.source_page');
  const badgeConfig = getBadgeConfig(displayState);
  const isCrawling = displayState === 'crawling';

  // ── Inline rename state ──────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      // Focus and select after render
      const timer = setTimeout(() => inputRef.current?.select(), 0);
      return () => clearTimeout(timer);
    }
  }, [editing]);

  const startEditing = useCallback(() => {
    setEditValue(source.name || '');
    setEditing(true);
  }, [source.name]);

  const cancelEditing = useCallback(() => {
    setEditing(false);
    setEditValue('');
  }, []);

  const saveRename = useCallback(async () => {
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === source.name) {
      cancelEditing();
      return;
    }

    setSaving(true);
    try {
      await renameSource(indexId, source._id, { name: trimmed });
      toast.success(t('rename_saved'));
      onSourceRenamed?.();
    } catch (err) {
      toast.error(t('rename_failed') + ': ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }, [editValue, source.name, source._id, indexId, t, onSourceRenamed, cancelEditing]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveRename();
      } else if (e.key === 'Escape') {
        cancelEditing();
      }
    },
    [saveRename, cancelEditing],
  );

  const handleNavigate = useCallback(
    (href: string) => {
      navigate(href);
    },
    [navigate],
  );

  const crumbs = [
    {
      label: knowledgeBase.name || t('kb_fallback'),
      href: `/projects/${projectId}/search-ai/${kbId}`,
    },
    { label: source.name || t('source_fallback') },
  ];

  const menuTrigger = (
    <Button
      variant="ghost"
      size="icon"
      icon={<MoreVertical className="h-4 w-4" />}
      data-testid="usp-menu-trigger"
      aria-label={t('aria_source_actions')}
    />
  );

  return (
    <div className="flex items-center justify-between" data-testid="usp-header">
      <div className="flex items-center gap-3">
        {editing ? (
          /* Inline rename input replaces breadcrumb while editing */
          <div className="flex items-center gap-2" data-testid="usp-rename-inline">
            <input
              ref={inputRef}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={saveRename}
              disabled={saving}
              className="text-sm font-semibold text-foreground bg-background-subtle border border-default rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:border-border-focus focus:ring-border-focus min-w-[180px] max-w-[300px]"
              data-testid="usp-rename-inline-input"
            />
            {saving && <span className="text-xs text-muted animate-pulse">Saving…</span>}
          </div>
        ) : (
          /* Normal breadcrumb — source name is clickable for rename */
          <div className="flex items-center gap-1 group">
            <PageBreadcrumb crumbs={crumbs} onNavigate={handleNavigate} />
            <button
              onClick={startEditing}
              className="p-1 text-transparent group-hover:text-muted hover:!text-foreground rounded transition-colors"
              aria-label={t('menu_rename')}
              data-testid="usp-rename-trigger"
            >
              <Pencil className="w-3 h-3" />
            </button>
          </div>
        )}
        <Badge
          variant={badgeConfig.variant}
          dot={badgeConfig.dot}
          pulse={badgeConfig.pulse}
          testid="usp-status-badge"
        >
          {t(badgeConfig.labelKey)}
        </Badge>
      </div>

      <DropdownMenu trigger={menuTrigger}>
        <DropdownMenuItem onSelect={startEditing} icon={<Pencil className="h-4 w-4" />}>
          {t('menu_rename')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => onRecrawl()}
          disabled={isCrawling}
          icon={<RefreshCw className="h-4 w-4" />}
        >
          {isCrawling ? t('menu_crawling') : t('menu_recrawl')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => onRecrawl({ force: true })}
          disabled={isCrawling}
          icon={<RefreshCw className="h-4 w-4" />}
        >
          {t('menu_force_recrawl')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onReconfigure}
          disabled={isCrawling}
          icon={<SlidersHorizontal className="h-4 w-4" />}
        >
          {t('menu_reconfigure')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={onDeleteSource}
          disabled={isCrawling}
          variant="danger"
          icon={<Trash2 className="h-4 w-4" />}
        >
          {t('menu_delete')}
        </DropdownMenuItem>
      </DropdownMenu>
    </div>
  );
}
