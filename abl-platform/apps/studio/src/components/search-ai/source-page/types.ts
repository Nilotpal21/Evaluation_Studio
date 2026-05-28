/**
 * Unified Source Page — Type definitions
 *
 * DisplayState is the single source of truth for all UI rendering decisions.
 * Derived from source.status + active job status via deriveDisplayState().
 */

import type { SearchAISource } from '@/api/search-ai';
import type { CrawlJob } from '@/api/crawl';

// ─── Display State ──────────────────────────────────────────────────────────

/**
 * 8-state enum derived from source + job status.
 * Job status takes priority over source status when a job exists.
 * Source status only used for pre-job states (configuring/pending).
 */
export type DisplayState =
  | 'configuring'
  | 'pending'
  | 'crawling'
  | 'completed'
  | 'completed_with_issues'
  | 'failed'
  | 'cancelled'
  | 'idle';

// ─── Tab State ──────────────────────────────────────────────────────────────

export type USPTab = 'pages' | 'history' | 'settings';

export const USP_TABS: USPTab[] = ['pages', 'history', 'settings'];

export const DEFAULT_TAB: USPTab = 'pages';

// ─── Component Props ────────────────────────────────────────────────────────

export interface UnifiedSourcePageProps {
  projectId: string;
  kbId: string;
  sourceId: string;
}

export interface USPHeaderProps {
  source: SearchAISource;
  displayState: DisplayState;
  kbId: string;
  onRecrawl: () => void;
  onDeleteSource: () => void;
}

export interface USPStatusStripProps {
  source: SearchAISource;
  displayJob: CrawlJob | null;
  displayState: DisplayState;
  activeJobId: string | null;
  /** When viewing a historical job (not the anchored one) */
  isViewingHistory: boolean;
  onBackToLatest: () => void;
}

export interface USPActionsBarProps {
  displayState: DisplayState;
  source: SearchAISource;
  onRecrawl: () => void;
  onCancel: () => void;
  onDeleteSource: () => void;
}

export interface USPSettingsTabProps {
  source: SearchAISource;
  onDeleteSource: () => void;
}

export interface ErrorGroupingPanelProps {
  jobId: string;
  indexId: string;
  sourceId: string;
}
