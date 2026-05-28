/**
 * Crawl Flow Store
 *
 * Lightweight store to open/close the crawl flow at the page level.
 * Any component (AddSourceButton in Home tab, Data tab, or resume source)
 * can call `open()` to activate the full-page crawl flow view.
 */

import { create } from 'zustand';

interface CrawlFlowOpenOptions {
  sourceId?: string;
  returnUrl?: string;
  /** Display name of the source (shown in breadcrumb when reconfiguring) */
  sourceName?: string;
  /** Whether the source has been crawled before (affects close dialog behaviour) */
  hasCrawledBefore?: boolean;
}

interface CrawlFlowStore {
  /** Whether the crawl flow is currently active */
  active: boolean;
  /** Optional source ID to resume (configuring source) */
  sourceId: string | undefined;
  /** Optional URL to navigate back to when the wizard is closed (e.g. USP) */
  returnUrl: string | undefined;
  /** Source display name (for breadcrumb) */
  sourceName: string | undefined;
  /** Whether the source has been crawled before (affects close dialog) */
  hasCrawledBefore: boolean;
  /** Open the crawl flow, optionally resuming a configuring source */
  open: (opts?: CrawlFlowOpenOptions) => void;
  /** Close the crawl flow and reset state */
  close: () => void;
}

export const useCrawlFlowStore = create<CrawlFlowStore>((set) => ({
  active: false,
  sourceId: undefined,
  returnUrl: undefined,
  sourceName: undefined,
  hasCrawledBefore: false,
  open: (opts?: CrawlFlowOpenOptions) =>
    set({
      active: true,
      sourceId: opts?.sourceId,
      returnUrl: opts?.returnUrl,
      sourceName: opts?.sourceName,
      hasCrawledBefore: opts?.hasCrawledBefore ?? false,
    }),
  close: () =>
    set({
      active: false,
      sourceId: undefined,
      returnUrl: undefined,
      sourceName: undefined,
      hasCrawledBefore: false,
    }),
}));
