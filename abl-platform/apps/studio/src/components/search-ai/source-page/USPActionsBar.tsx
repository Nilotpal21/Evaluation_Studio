'use client';

/**
 * USPActionsBar — Zone 4: Context-sensitive action buttons per display state.
 *
 * Uses DS Button component for all actions. Actions matrix:
 * - configuring: [Configure]
 * - pending:     [Cancel]
 * - crawling:    [Run in Background] [Cancel Crawl]
 * - completed:   [View Documents] [Edit Settings] [Recrawl]
 * - completed_with_issues: [View Documents] [Edit Settings] [Recrawl]
 * - failed:      [Edit Settings] [Recrawl]
 * - cancelled:   [Edit Settings] [Recrawl]
 * - idle:        [Start Crawl]
 *
 * Historical mode override: only [Recrawl] shown.
 *
 * "Run in Background" prompts the user to name the source before navigating.
 */

import { useState, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  Play,
  XCircle,
  RefreshCw,
  ExternalLink,
  Minimize2,
  SlidersHorizontal,
  ChevronDown,
} from 'lucide-react';
import { cancelCrawlJob } from '@/api/crawl';
import { renameSource } from '@/api/search-ai';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Dialog } from '@/components/ui/Dialog';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DropdownMenu, DropdownMenuItem } from '@/components/ui/DropdownMenu';
import { useNavigationStore } from '@/store/navigation-store';
import type { SearchAISource } from '@/api/search-ai';
import type { CrawlJob } from '@/api/crawl';
import type { DisplayState } from './types';

interface USPActionsBarProps {
  displayState: DisplayState;
  source: SearchAISource;
  displayJob: CrawlJob | null;
  activeJobId: string | null;
  projectId: string;
  kbId: string;
  indexId: string;
  isViewingHistory: boolean;
  /** Quick recrawl: same URLs, same config, submit immediately. Pass { force: true } to skip deduplication. */
  onRecrawl: (options?: { force?: boolean }) => void | Promise<void>;
  /** Edit settings: go to wizard to change sections/settings */
  onReconfigure: () => void;
  onCancel: () => void;
  /** Called after a successful rename so parent can refresh */
  onSourceRenamed?: () => void;
}

// ── Split button (Recrawl + Force Recrawl dropdown) ─────────────────────────

function RecrawlSplitButton({
  onRecrawl,
  loading,
  t,
}: {
  onRecrawl: (options?: { force?: boolean }) => void;
  loading?: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div
      className={`inline-flex items-stretch rounded-lg bg-accent text-accent-foreground shadow-sm ${loading ? 'opacity-70 pointer-events-none' : ''}`}
      data-testid="usp-recrawl-split"
    >
      <button
        type="button"
        onClick={() => onRecrawl()}
        disabled={loading}
        className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium rounded-l-lg hover:opacity-90 transition-default focus-ring disabled:cursor-not-allowed"
        data-testid="usp-action-recrawl"
      >
        <RefreshCw className={`w-4 h-4 shrink-0 ${loading ? 'animate-spin' : ''}`} />
        {t('menu_recrawl')}
      </button>
      <DropdownMenu
        trigger={
          <button
            type="button"
            disabled={loading}
            className="inline-flex items-center px-2 py-2 border-l border-l-white/20 rounded-r-lg hover:opacity-90 transition-default focus-ring disabled:cursor-not-allowed"
            aria-label={t('aria_recrawl_options')}
            data-testid="usp-recrawl-dropdown"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        }
      >
        <DropdownMenuItem
          onSelect={() => onRecrawl({ force: true })}
          icon={<RefreshCw className="h-4 w-4" />}
        >
          {t('action_force_recrawl')}
        </DropdownMenuItem>
      </DropdownMenu>
    </div>
  );
}

export function USPActionsBar({
  displayState,
  source,
  displayJob,
  activeJobId,
  projectId,
  kbId,
  indexId,
  isViewingHistory,
  onRecrawl,
  onReconfigure,
  onCancel,
  onSourceRenamed,
}: USPActionsBarProps) {
  const navigate = useNavigationStore((s) => s.navigate);
  const t = useTranslations('search_ai.source_page');
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [recrawling, setRecrawling] = useState(false);

  // Wrap onRecrawl to track loading state and prevent double-clicks
  const handleRecrawl = async (options?: { force?: boolean }) => {
    if (recrawling) return;
    setRecrawling(true);
    try {
      await onRecrawl(options);
    } finally {
      // Keep spinning briefly so SWR has time to pick up the new job
      setTimeout(() => setRecrawling(false), 2000);
    }
  };

  // ── Naming dialog state ──────────────────────────────────────────────────
  const [namingDialogOpen, setNamingDialogOpen] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Focus input when dialog opens
  useEffect(() => {
    if (namingDialogOpen) {
      // Small delay for dialog animation
      const timer = setTimeout(() => nameInputRef.current?.select(), 100);
      return () => clearTimeout(timer);
    }
  }, [namingDialogOpen]);

  // ── Historical mode: only Recrawl ──────────────────────────────────────
  if (isViewingHistory) {
    return (
      <div
        className="flex items-center justify-end gap-3 pt-4 border-t border-default"
        data-testid="usp-actions-bar"
      >
        <RecrawlSplitButton onRecrawl={handleRecrawl} loading={recrawling} t={t} />
      </div>
    );
  }

  // ── Cancel handler ─────────────────────────────────────────────────────
  const handleCancelConfirm = async () => {
    if (!activeJobId) return;
    setCancelling(true);
    try {
      await cancelCrawlJob(activeJobId);
      toast.success(t('crawl_cancelled'));
      onCancel();
    } catch (err) {
      toast.error(t('cancel_failed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setCancelling(false);
      setCancelDialogOpen(false);
    }
  };

  // ── Run in Background → open naming dialog ──────────────────────────────
  const handleRunInBackground = () => {
    setNameValue(source.name || '');
    setNamingDialogOpen(true);
  };

  const handleNamingSave = async () => {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== source.name) {
      setNameSaving(true);
      try {
        await renameSource(indexId, source._id, { name: trimmed });
        toast.success(t('rename_saved'));
        onSourceRenamed?.();
      } catch (err) {
        toast.error(t('rename_failed') + ': ' + (err instanceof Error ? err.message : String(err)));
      } finally {
        setNameSaving(false);
      }
    }
    setNamingDialogOpen(false);
    navigate(`/projects/${projectId}/search-ai/${kbId}`);
  };

  const handleNamingSkip = () => {
    setNamingDialogOpen(false);
    navigate(`/projects/${projectId}/search-ai/${kbId}`);
  };

  // ── View Documents ────────────────────────────────────────────────────
  const handleViewDocs = () => {
    navigate(`/projects/${projectId}/search-ai/${kbId}?tab=documents`);
  };

  return (
    <>
      <div
        className="flex items-center justify-end gap-3 pt-4 border-t border-default"
        data-testid="usp-actions-bar"
      >
        {/* Configuring */}
        {displayState === 'configuring' && (
          <Button
            variant="primary"
            icon={<Play className="w-4 h-4" />}
            onClick={onReconfigure}
            data-testid="usp-action-configure"
          >
            {t('action_configure')}
          </Button>
        )}

        {/* Pending */}
        {displayState === 'pending' && (
          <Button
            variant="secondary"
            icon={<XCircle className="w-4 h-4" />}
            onClick={() => setCancelDialogOpen(true)}
            data-testid="usp-action-cancel"
          >
            {t('action_cancel')}
          </Button>
        )}

        {/* Crawling */}
        {displayState === 'crawling' && (
          <>
            <Button
              variant="secondary"
              icon={<Minimize2 className="w-4 h-4" />}
              onClick={handleRunInBackground}
              data-testid="usp-action-background"
            >
              {t('action_background')}
            </Button>
            <Button
              variant="danger"
              icon={<XCircle className="w-4 h-4" />}
              onClick={() => setCancelDialogOpen(true)}
              data-testid="usp-action-cancel"
            >
              {t('action_cancel_crawl')}
            </Button>
          </>
        )}

        {/* Completed / Completed with Issues */}
        {(displayState === 'completed' || displayState === 'completed_with_issues') && (
          <>
            <Button
              variant="secondary"
              icon={<ExternalLink className="w-4 h-4" />}
              onClick={handleViewDocs}
              data-testid="usp-action-view-docs"
            >
              {t('action_view_docs')}
            </Button>
            <Button
              variant="secondary"
              icon={<SlidersHorizontal className="w-4 h-4" />}
              onClick={onReconfigure}
              data-testid="usp-action-reconfigure"
            >
              {t('action_reconfigure')}
            </Button>
            <RecrawlSplitButton onRecrawl={handleRecrawl} loading={recrawling} t={t} />
          </>
        )}

        {/* Failed / Cancelled */}
        {(displayState === 'failed' || displayState === 'cancelled') && (
          <>
            <Button
              variant="secondary"
              icon={<SlidersHorizontal className="w-4 h-4" />}
              onClick={onReconfigure}
              data-testid="usp-action-reconfigure"
            >
              {t('action_reconfigure')}
            </Button>
            <RecrawlSplitButton onRecrawl={handleRecrawl} loading={recrawling} t={t} />
          </>
        )}

        {/* Idle */}
        {displayState === 'idle' && (
          <Button
            variant="primary"
            icon={<Play className="w-4 h-4" />}
            onClick={onReconfigure}
            data-testid="usp-action-start"
          >
            {t('action_start')}
          </Button>
        )}
      </div>

      {/* Cancel Dialog */}
      <ConfirmDialog
        open={cancelDialogOpen}
        onClose={() => setCancelDialogOpen(false)}
        onConfirm={handleCancelConfirm}
        title={t('cancel_title')}
        description={t('cancel_description', { count: displayJob?.urls?.crawled ?? 0 })}
        confirmLabel={t('cancel_confirm')}
        variant="danger"
        loading={cancelling}
      />

      {/* Naming Dialog — shown on "Run in Background" */}
      <Dialog
        open={namingDialogOpen}
        onClose={handleNamingSkip}
        title={t('rename_title')}
        description={t('rename_description')}
        maxWidth="sm"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleNamingSave();
          }}
          className="space-y-4"
        >
          <Input
            ref={nameInputRef}
            label={t('rename_label')}
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            placeholder={t('rename_placeholder')}
            data-testid="usp-rename-input"
          />
          <div className="flex items-center justify-end gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={handleNamingSkip}
              data-testid="usp-rename-skip"
            >
              {t('rename_skip')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={nameSaving}
              disabled={!nameValue.trim()}
              data-testid="usp-rename-save"
            >
              {t('rename_save')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
