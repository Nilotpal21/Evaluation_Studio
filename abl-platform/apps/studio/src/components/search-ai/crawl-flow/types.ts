/**
 * Crawl Flow V5 — Shared types
 *
 * State machine, section model, analysis steps, and component props.
 */

import type { ProfileResponse, GroupStrategy } from '@/api/crawl';
import type { UnifiedTreeNode } from './discovery/unified-tree-types';

/** State machine for the crawl flow */
export type CrawlFlowState =
  | 'url-entry'
  | 'analyzing'
  | 'configure'
  | 'submitting'
  | 'crawling'
  | 'done';

/** A content section discovered by URL clustering */
export interface CrawlSection {
  /** Stable identifier for draft bucket persistence (e.g. "sec-0"). Assigned once at creation. */
  sectionId?: string;
  pattern: string;
  name: string;
  pageCount: number;
  examples: string[];
  included: boolean;
  estimatedTime: string;
  warnings: string[];
  depth: number;
  /** Where this section was discovered */
  source?: 'sitemap' | 'explored' | 'auto' | 'direct';
  /** Individual pages (available for explored sections; expandable in UI) */
  pages?: Array<{ url: string; title: string }>;
  /** Per-section rendering strategy (D12) */
  strategy?: 'http' | 'browser';
  /** O7: File type breakdown for this section */
  fileTypeCounts?: Record<string, number>;
  /** Sitemap file this section came from (for grouping and transparency) */
  sitemapFile?: string;
  /** How the sitemap was discovered */
  sitemapOrigin?: 'default' | 'robots.txt' | 'index' | 'user-provided';
}

/** Robots.txt analysis result (mirrors backend RobotsTxtAnalysis) */
export interface RobotsTxtAnalysis {
  found: boolean;
  crawlDelay: number | null;
  disallowedPaths: string[];
  sitemapUrls: string[];
  userAgent: string;
  rawContent?: string;
}

/** A streaming analysis step shown in the UI */
export interface AnalysisStep {
  id: string;
  label: string;
  status: 'pending' | 'active' | 'complete' | 'error';
  result?: string;
}

/** Props for the main CrawlFlowV5 component */
export interface CrawlFlowV5Props {
  indexId: string;
  projectId?: string;
  /** Resume from a configuring source instead of starting fresh */
  sourceId?: string;
  /** Whether this source has been crawled before (affects close dialog behaviour) */
  hasCrawledBefore?: boolean;
  onComplete: (jobId: string, sourceId: string, url: string) => void;
  onCancel: () => void;
}

/** Imperative handle for CrawlFlowV5 — allows parent to trigger close confirmation */
export interface CrawlFlowHandle {
  requestClose: () => void;
}

// ─── Authentication ─────────────────────────────────────────────────

/** Authentication method for crawling protected sites */
export type AuthMethod = 'none' | 'basic' | 'bearer' | 'headers' | 'cookies';

/** Key-value pair for custom headers */
export interface HeaderEntry {
  key: string;
  value: string;
}

/** Authentication configuration — applied to both discovery and crawl requests */
export interface AuthConfig {
  method: AuthMethod;
  /** Basic auth */
  basicUsername?: string;
  basicPassword?: string;
  /** Bearer token */
  bearerToken?: string;
  /** Custom headers (key-value pairs) */
  customHeaders?: HeaderEntry[];
  /** Raw cookie string (from browser DevTools) */
  cookieString?: string;
}

/** Props for State1UrlEntry */
export interface State1UrlEntryProps {
  onSubmit: (url: string) => void;
  isLoading?: boolean;
  /** Pre-fill URL when navigating back from analysis */
  initialUrl?: string;
  /** Project ID for loading configuring sources */
  projectId?: string;
  /** Index (KB) ID — scopes configuring sources to the current knowledge base */
  indexId?: string;
  /** Called when user clicks a configuring source to resume */
  onResumeSource?: (sourceId: string) => void;
  /** Authentication config — shared with crawl flow */
  authConfig: AuthConfig;
  onAuthConfigChange: (config: AuthConfig) => void;
}

/** Pipeline phase from the discovery state machine */
export type PipelinePhase = 'idle' | 'browser-running' | 'http-running' | 'running' | 'complete';

// ─── Unified Discovery Panel (auto-chain architecture) ───────────────

/** Activity log entry for the unified discovery panel */
export interface ActivityEntry {
  id: string;
  timestamp: number;
  /** milestone+warning shown by default, detail on "Show details" */
  level: 'milestone' | 'detail' | 'warning';
  /** i18n key */
  message: string;
  messageParams?: Record<string, string>;
}

/** Props for the UnifiedDiscoveryPanel component */
export interface UnifiedDiscoveryPanelProps {
  /** Primary URL for discovery */
  primaryUrl: string;
  /** Sample URLs from user input */
  sampleUrls: string[];
  /** Seeds (nav sections + target URLs) */
  seeds: Array<{ type: 'nav-section' | 'target-url'; url: string; label?: string }>;
  /** Called when discovery produces sections for crawl */
  onSectionsReady: (sections: CrawlSection[]) => void;
  /** Callback to update lifted tree state */
  onTreeChange: (tree: UnifiedTreeNode[]) => void;
  /** Current tree state (lifted to State2Analysis) */
  tree: UnifiedTreeNode[];
  /** Max depth for BFS */
  maxDepth?: number;
  /** Source ID for tenant discovery association */
  sourceId?: string;
  /** Whether sitemap is available for this domain */
  hasSitemap?: boolean;
  /** Sitemap URLs for the "Add from Sitemap" dialog */
  sitemapUrls?: string[];
}

/** Crawl scope selection */
export type CrawlScope = 'limited' | 'full' | 'custom';

/** Rendering strategy */
export type RenderingMode = 'hybrid' | 'http' | 'browser';

/** Content cleanup level */
export type CleanupLevel = 'standard' | 'aggressive' | 'none';

/** Crawl configuration resolved from analysis + user overrides */
export interface CrawlConfig {
  scope: CrawlScope;
  customPageLimit?: number;
  rendering: RenderingMode;
  learnedPatterns: 'keep' | 'reset';
  requestDelay: number; // ms between requests
  maxPages: number;
  maxDepth: number; // link-hops from seed URLs (1-20)
  respectRobotsTxt: boolean;
  cleanup: CleanupLevel;
  deduplicate: boolean;
  cookieConsent: boolean;
}

/** Props for State3Configure */
export interface State3ConfigureProps {
  sections: CrawlSection[];
  totalPages: number;
  config: CrawlConfig;
  onConfigChange: (config: CrawlConfig) => void;
  onStartCrawl: () => void;
  onBack: () => void;
  isStarting?: boolean;
  /** Base URL of the crawl target — used for extraction preview */
  baseUrl?: string;
  /** Whether discovery is still running in the background */
  discoveryRunning?: boolean;
  /** Stats from the running discovery */
  discoveryStats?: { urlCount: number; sectionCount: number };
}

/** Props for State2Analysis */
export interface State2AnalysisProps {
  url: string;
  indexId: string;
  profile: ProfileResponse | null;
  sections: CrawlSection[];
  onSectionsChange: (sections: CrawlSection[]) => void;
  onContinue: () => void;
  /** Direct crawl: skip Configure, use defaults */
  onDirectCrawl?: () => void;
  isAnalyzing: boolean;
  analysisSteps: AnalysisStep[];
  groupStrategies: GroupStrategy[];
  /** Source ID for persisting strategy and discovery state */
  sourceId?: string;
  /** Config version for optimistic concurrency on save */
  configVersion?: number;
  /** Restored discovery state for resume flow */
  initialDiscoveryState?: SourceDiscoveryState | null;
  /** Whether background clustering (Phase B) is still running */
  clusteringInProgress?: boolean;
  /** Direct URLs: raw text for strategy-switch preservation */
  directUrlsText?: string;
  /** Direct URLs: called when raw text changes */
  onDirectUrlsTextChange?: (text: string) => void;
  /** Direct URLs: called when valid URLs change */
  onDirectUrlsValidChange?: (urls: string[]) => void;
  /** Direct URLs: called when user clicks "Configure Crawl" from DirectUrlsPanel */
  onDirectUrlsConfigure?: () => void;
  /** Direct URLs: skip Configure, use defaults */
  onDirectUrlsDirectCrawl?: () => void;
  /** Restore strategy on remount (back-navigation, resume) */
  initialStrategy?: DiscoveryStrategy | null;
  /** Notify parent when user selects a strategy (for remount restoration) */
  onStrategyChange?: (strategy: DiscoveryStrategy | null) => void;
  /** Called when user validates a custom sitemap URL — parent re-clusters with it */
  onCustomSitemapValidated?: (sitemapUrl: string, urlCount: number) => void;
}

// ─── Explore (sample-guided discovery) ──────────────────────────────

/** Discovery source badge for each section */
export type DiscoverySource = 'sitemap' | 'explored' | 'auto';

/** Status of the explore crawl */
export type ExploreStatus = 'idle' | 'learning' | 'exploring' | 'stopping' | 'done' | 'error';

/** Pattern learned from sample URLs */
export interface LearnedPattern {
  /** URL template with placeholders, e.g. "/Support/Printers/{}/{}/{}/s/{}" */
  urlTemplate: string;
  /** Common path prefix, e.g. "/Support/Printers/" */
  pathPrefix: string;
  /** Number of sample URLs analyzed */
  sampleCount: number;
}

/** Live progress from the explore crawl */
export interface ExploreProgress {
  /** Total URLs discovered so far */
  found: number;
  /** URLs matching the learned pattern (score ≥ 80, "hot") */
  matched: number;
  /** URLs with partial match (score 40-79, "warm") — candidates for deeper exploration */
  warm: number;
  /** URLs visited (fetched) */
  visited: number;
  /** URLs in the queue */
  queued: number;
  /** Breakdown by depth level */
  byDepth: Record<number, number>;
  /** Currently visiting URL (for display) */
  currentUrl?: string;
}

/** Status of browser discovery within the explore panel */
export type BrowserDiscoveryStatus = 'idle' | 'running' | 'done' | 'error';

// ─── Discovery Summary ──────────────────────────────────────────────

/** Stats from a single discovery layer (sitemap, explore, or browser) */
export interface DiscoveryLayerStats {
  /** Which discovery method produced these stats */
  method: 'sitemap' | 'explore' | 'browser';
  /** Total pages or links discovered */
  pagesFound: number;
  /** Pages matching the learned pattern (explore: score >= 80, browser: passed linkFilter) */
  pagesMatched: number;
  /** Sections created from this layer */
  sectionsCreated: number;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
  /** URLs actually fetched (explore only) */
  pagesVisited?: number;
  /** Depth breakdown (explore only) */
  byDepth?: Record<number, number>;
  /** Expandable elements clicked (browser only) */
  clicksMade?: number;
}

/** Quality breakdown — exported for consumers that need terminal stats */
export interface QualityBreakdown {
  good: number;
  thin: number;
  empty: number;
  unknown: number;
}

/** Terminal result passed from CrawlProgressView to consumers via onComplete */
export interface CrawlProgressResult {
  state: 'done' | 'failed';
  completedCount: number;
  failedCount: number;
  totalCount: number;
  quality: QualityBreakdown;
  thinCount: number;
}

/** Live progress stats — fired on each progress change for parents that need live counts */
export interface CrawlProgressStats {
  completedCount: number;
  failedCount: number;
  totalCount: number;
}

/** Props for reusable CrawlProgressView — pure progress display, no actions */
export interface CrawlProgressViewProps {
  jobId: string;
  sourceId: string;
  url: string;
  /** Optional sections for fill-rate fallback (wizard has these, USP doesn't).
   *  Defaults to [] — all section iteration is guarded against empty array. */
  sections?: CrawlSection[];
  /** Fallback total when WS hasn't reported yet (default: 0) */
  totalPages?: number;
  /** Called once when crawl reaches terminal state (done or failed).
   *  Passes a snapshot of progress stats at terminal time. */
  onComplete?: (result: CrawlProgressResult) => void;
  /** Called on each progress update with current stats.
   *  Used by State4Crawl's backgrounding dialog which needs live counts during active crawl.
   *  USP does not use this (ActionsBar gets stats from its own SWR/dashboard polling). */
  onProgressUpdate?: (stats: CrawlProgressStats) => void;
  /** When crawl-as-you-discover is active — dual progress bars */
  discoveryProgress?: {
    discoveredUrls: number;
    pagesVisited: number;
    isRunning: boolean;
  };
  /** Per-category crawl status from crawl-as-you-discover */
  categoryCrawlStatus?: CategoryCrawlStatus[];
}

/** Props for State4Crawl — Step 4 crawl progress in-panel */
export interface State4CrawlProps {
  jobId: string;
  sourceId: string;
  url: string;
  sections: CrawlSection[];
  totalPages: number;
  onViewResults: (sourceId: string, filter?: string) => void;
  onBack: () => void;
  /** Called when crawl completes — parent transitions to 'done' */
  onCrawlComplete?: () => void;
  /** When crawl-as-you-discover is active, show dual progress bars */
  discoveryProgress?: {
    discoveredUrls: number;
    pagesVisited: number;
    isRunning: boolean;
  };
  /** Per-category crawl status from crawl-as-you-discover */
  categoryCrawlStatus?: CategoryCrawlStatus[];
}

/** Props for the ExplorePanel component */
export interface ExplorePanelProps {
  /** The base domain being crawled */
  domain: string;
  /** The full base URL entered by the user (e.g. https://epson.com/Support/sl/s) */
  baseUrl: string;
  /** Existing sections from sitemap (to show context) */
  sitemapSectionCount: number;
  /** Total pages found via sitemap */
  sitemapPageCount: number;
  /** Called when explore discovers new sections to merge */
  onSectionsDiscovered: (sections: CrawlSection[]) => void;
  /** Called when a discovery layer completes with stats */
  onLayerComplete: (stats: DiscoveryLayerStats) => void;
  /** Called when user cancels / closes the explore panel */
  onClose: () => void;
  /** API endpoint URLs discovered by browser interception (used as additional fan-out seeds) */
  apiUrls?: string[];
  /** Skip HTTP explore and start browser discovery directly */
  startWithBrowser?: boolean;
  /** Pre-filled sample URLs from the parent — skips input phase and auto-starts */
  initialSampleUrls?: string[];
  /** Called when HTTP explore suggests browser discovery (TC1 escalation) */
  onEscalateToBrowser?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════
// Discovery Panel Types (D1-D6 design decisions)
// ═══════════════════════════════════════════════════════════════════════

// ─── Discovery Tree (D1, D4) ─────────────────────────────────────────

/** Discovery tree node — maps URL hierarchy */
export interface DiscoveryTreeNode {
  /** UI display name (title-cased, spaces) */
  displayName: string;
  /** Raw path segment for tree lookup */
  pathSegment: string;
  /** Full URL */
  url: string;
  /** How this node was discovered */
  source: 'breadcrumb' | 'visited-hub' | 'sibling' | 'projected' | 'seed' | 'nav-extracted';
  /** Current node state */
  state: 'visited' | 'discovered' | 'visiting' | 'queued' | 'skipped' | 'failed';
  /** Number of links found on this page (if visited) */
  linkCount?: number;
  /** Child nodes */
  children: DiscoveryTreeNode[];
  /** Depth in the tree */
  depth: number;
  /** Whether this URL has been verified by visiting */
  confidence: 'verified' | 'projected';
  /** Page role classification */
  role?: 'hub' | 'leaf' | 'mixed';
  /** Page title (if discovered) */
  title?: string;
}

/** Tree view mode */
export type TreeViewMode = 'auto' | 'expanded' | 'collapsed-2';

/** Tree render config for computeVisibleNodes */
export interface TreeRenderConfig {
  /** Max visible nodes before auto-collapse (default 30) */
  threshold: number;
  /** Current view mode */
  mode: TreeViewMode;
  /** Manually expanded node URLs */
  manuallyExpanded: Set<string>;
  /** Manually collapsed node URLs */
  manuallyCollapsed: Set<string>;
}

/** Breadcrumb in the tree navigation trail */
export interface TreeBreadcrumb {
  label: string;
  url: string;
  depth: number;
}

/**
 * When a node action is available relative to the discovery lifecycle.
 * - `running`  — only while the prober is active (backend-dependent)
 * - `always`   — during AND after discovery (scope/skip management)
 * - `post`     — only after discovery completes (review-phase actions)
 */
export type ActionAvailability = 'running' | 'always' | 'post';

/** Action available on a tree node */
export interface NodeAction {
  label: string;
  icon: string;
  action: InterventionType | 'add-to-scope' | 'add-children-to-scope';
  variant: 'primary' | 'secondary' | 'danger';
  /** When this action is visible. Defaults to 'running' for backward compat. */
  availability: ActionAvailability;
}

// ─── Discovery Console (D2) ─────────────────────────────────────────

/** Console entry types */
export type ConsoleEntryType =
  | 'action'
  | 'result'
  | 'decision'
  | 'auto-add'
  | 'yield'
  | 'warning'
  | 'milestone'
  | 'nav'
  | 'suggestion';

/** Console entry — timestamped log line */
export interface ConsoleEntry {
  id: string;
  timestamp: number;
  type: ConsoleEntryType;
  /** i18n key for the message (translated at render time) */
  message: string;
  /** Interpolation params for the i18n message key */
  messageParams?: Record<string, string | number>;
  data?: {
    url?: string;
    linkCount?: number;
    yieldRate?: number;
    sectionName?: string;
    urlCount?: number;
    /** i18n key for structured reason (flat key, e.g., reason_auto_add) */
    reasonKey?: string;
    /** Interpolation params for the reason i18n key */
    reasonParams?: Record<string, string | number>;
  };
}

// ─── Decision Cards (D3) ────────────────────────────────────────────

/** Objective match mode */
export type ObjectiveMatchMode = 'title' | 'url-path' | 'by-example' | 'content-tag';

/** Decision Card — context-aware action suggestion */
export interface DecisionCard {
  id: string;
  /** i18n key for the card label (translated at render time) */
  label: string;
  /** Interpolation params for the label i18n key */
  labelParams?: Record<string, string | number>;
  /** i18n key for the card reason (translated at render time) */
  reason: string;
  /** Interpolation params for the reason i18n key */
  reasonParams?: Record<string, string | number>;
  action: DecisionAction;
  priority: number;
  category: 'explore' | 'add' | 'skip' | 'objective' | 'crawl';
  meta?: {
    urlCount?: number;
    sectionName?: string;
    matchedPattern?: string;
    confidence?: number;
  };
}

/** Action attached to a Decision Card */
export interface DecisionAction {
  type:
    | 'explore-branch'
    | 'explore-all-nav'
    | 'add-category'
    | 'skip-category'
    | 'set-objective'
    | 'find-similar'
    | 'proceed-to-crawl'
    | 'browse-titles';
  payload: {
    url?: string;
    urls?: string[];
    category?: string;
    objectiveQuery?: string;
    objectiveMode?: ObjectiveMatchMode;
  };
}

/** Console action — from chips or Decision Cards */
export type ConsoleAction =
  | { type: 'intervention'; intervention: Intervention }
  | { type: 'decision-card'; card: DecisionCard }
  | { type: 'browse-titles' }
  | { type: 'set-crawl-mode'; config: CrawlAsYouDiscoverConfig };

// ─── Interventions (D7) ─────────────────────────────────────────────

/** Intervention types for POST-alongside-SSE */
export type InterventionType =
  | 'stop'
  | 'add-sample'
  | 'explore-branch'
  | 'skip-branch'
  | 'explore-all'
  | 'undo-skip'
  | 'add-to-scope'
  | 'add-children-to-scope';

/**
 * Backend command types — sent via POST to intervention endpoint.
 * Frontend-only operations (scope changes, UI state) never POST to backend.
 */
export type BackendInterventionType =
  | 'stop'
  | 'skip-branch'
  | 'explore-branch'
  | 'add-sample'
  | 'explore-all'
  | 'undo-skip';

/** Intervention command sent to backend */
export interface Intervention {
  type: InterventionType;
  payload?: { url?: string; urls?: string[]; maxDepth?: number };
}

// ─── Auto-Add Sections (D5) ─────────────────────────────────────────

/** Section display state — tracks auto-add origin */
export interface SectionDisplayState {
  origin: 'user-created' | 'auto-discovered' | 'sitemap';
  confirmed: boolean;
  dismissed: boolean;
}

// ─── Crawl-as-you-Discover (D6) ─────────────────────────────────────

/** Crawl-as-you-discover config */
export interface CrawlAsYouDiscoverConfig {
  mode: 'disabled' | 'crawl-all' | 'crawl-matched' | 'review-first';
  matchCriteria?: {
    objectives?: string[];
    contentTags?: string[];
    urlPrefixes?: string[];
    patterns?: string[];
    minConfidence: 'verified' | 'projected';
    minScoreTier?: 'hot' | 'warm';
  };
  crawlDefaults: { strategy: 'http' | 'browser' | 'auto'; concurrency: number };
}

/** Per-category crawl status */
export interface CategoryCrawlStatus {
  category: string;
  total: number;
  crawled: number;
  failed: number;
  queued: number;
  status: 'queued' | 'crawling' | 'complete' | 'failed';
}

// ─── Discovery Loop State ───────────────────────────────────────────

/** Discovery loop state machine */
export type DiscoveryLoopState =
  | 'nav-extracting'
  | 'auto-discovering'
  | 'reviewing'
  | 'setting-objectives'
  | 'targeted-discovering'
  | 'ready-for-crawl';

/** Discovery loop context */
export interface DiscoveryLoopContext {
  loopState: DiscoveryLoopState;
  iterationCount: number;
  totalDiscoveredUrls: number;
  totalPagesVisited: number;
}

// ─── Coverage Analysis ──────────────────────────────────────────────

/** Category discovered during analysis */
export interface DiscoveredCategory {
  label: string;
  pattern: string;
  urlCount: number;
  confidence: number;
  explored: boolean;
  matchedObjectives: string[];
}

/** Coverage analysis result */
export interface CoverageAnalysis {
  categories: DiscoveredCategory[];
  unexploredNavCategories: string[];
  totalDiscovered: number;
  totalVerified: number;
  totalProjected: number;
  navCoverageRatio: number;
}

// ─── Objectives ─────────────────────────────────────────────────────

/** Discovery objective */
export interface DiscoveryObjective {
  id: string;
  query: string;
  mode: ObjectiveMatchMode;
  matchCount: number;
  estimatedTotal: number;
  matchers: ObjectiveMatcher[];
}

/** Matcher derived from an objective */
export interface ObjectiveMatcher {
  type: 'title-keyword' | 'url-prefix' | 'url-pattern' | 'content-tag';
  value: string;
  weight: number;
}

// ─── Browse Titles ──────────────────────────────────────────────────

/** Browse Titles dropdown state */
export interface BrowseTitlesState {
  open: boolean;
  searchQuery: string;
  selectedGroup: string | null;
}

/** Item in the Browse Titles dropdown */
export interface BrowseItem {
  url: string;
  title: string;
  category: string;
  confidence: 'verified' | 'projected';
}

/** Group in the Browse Titles dropdown */
export interface BrowseGroup {
  label: string;
  count: number;
  items: BrowseItem[];
}

// ─── Nav Extraction ─────────────────────────────────────────────────

/** Navigation tree node from nav extraction */
export interface NavNode {
  label: string;
  href?: string;
  depth: number;
  children: NavNode[];
  source: 'header' | 'footer' | 'mega-menu' | 'sitemap-page';
  estimatedChildren?: number;
}

/** Nav extraction result */
export interface NavExtractionResult {
  nodes: NavNode[];
  source: string;
  extractionTimeMs: number;
}

// ─── Discovery Iteration ────────────────────────────────────────────

/** Record of a single discovery iteration */
export interface DiscoveryIteration {
  id: string;
  seedUrl: string;
  sampleUrls: string[];
  newUrlsDiscovered: number;
  pagesVisited: number;
  durationMs: number;
  timestamp: number;
  trigger?: 'initial' | 'explore-branch' | 'explore-all' | 'add-sample' | 'explore-all-nav';
}

/** Context for resuming a discovery run from a prior iteration */
export interface DiscoveryResumeContext {
  visitedUrls: string[];
  exploredBranches: string[];
  iterationCount: number;
}

/** Summary of selected vs available items */
export interface SelectionSummary {
  selectedCount: number;
  availableCount: number;
}

/** Metadata for a discovery run */
export interface DiscoveryRunMeta {
  startedAt: number;
  completedAt?: number;
  baseUrl: string;
  iterations: DiscoveryIteration[];
}

// ─── Yield Status ───────────────────────────────────────────────────

/** Yield status for console display */
export interface YieldStatus {
  trend: 'productive' | 'declining' | 'stalled';
  rate: number;
  peakRate: number;
  reason: string;
}

// ─── Strategy Selection (D7) ────────────────────────────────────────

/** Discovery strategy — chosen after profiling */
export type DiscoveryStrategy = 'crawl-sitemap' | 'guided-discovery' | 'direct-urls';

/** Maximum number of URLs allowed in Direct URLs mode */
export const DIRECT_URLS_MAX = 2_000;

/** Strategy selection UI state */
export interface StrategySelectionState {
  selected: boolean;
  strategy: DiscoveryStrategy | null;
  hasSitemap: boolean;
  sitemapPageCount: number;
}

// ─── Scope Rules (§23) ─────────────────────────────────────────────

/** Scope tracking — scope flows DOWN from sample URLs */
export interface DiscoveryScope {
  /** URLs explicitly provided as samples — their subtrees are auto-included */
  sampleUrls: string[];
  /** URL prefixes that are in scope (derived from sample parent directories) */
  includedPrefixes: string[];
  /** URL prefixes explicitly excluded by user */
  excludedPrefixes: string[];
  /** Sections explicitly included by user (from [NEW] toggle) */
  includedSections: string[];
}

// ─── Override Warning ───────────────────────────────────────────────

/** Override warning data — callbacks defined in component, not state */
export interface OverrideWarningData {
  branch: string;
  discoveryRate: string; // e.g., "2 new in last 15"
}

// ─── Resume Banner ──────────────────────────────────────────────────

/** Resume discovery banner state */
export interface ResumeDiscoveryBanner {
  show: boolean;
  discoveredCount: number;
  sectionCount: number;
  includedCount: number;
  savedAt: number;
}

// ─── Discovery State Persistence ────────────────────────────────────

/** Serializable discovery state for crawl draft persistence */
export interface SourceDiscoveryState {
  tree: DiscoveryTreeNode[];
  discoveredUrls: Array<{ href: string; text: string; confidence: string; depth: number }>;
  objectives: DiscoveryObjective[];
  navStructure: NavExtractionResult | null;
  iterations: DiscoveryIteration[];
  coverage: CoverageAnalysis | null;
  /** Scope tracking state — persisted with discovery state */
  scope?: DiscoveryScope;
  /** Monotonic version counter for unified tree rebuilds */
  _treeVersion?: number;
  savedAt: number;
}

// ─── Multi-User Discovery Tracking ──────────────────────────────────

/** A discovery or crawl that has been backgrounded (minimized) */
export interface BackgroundedDiscovery {
  sourceId: string;
  domain: string;
  discoveredCount: number;
  sectionCount: number;
  status: 'running' | 'complete' | 'stopped';
  ownerName: string;
  ownerId: string;
  /** Whether the current user owns this item (set at hydration time) */
  isOwner: boolean;
  type: 'discovery' | 'crawl';
  jobId?: string;
  crawlProgress?: { crawled: number; total: number; failed: number };
}
