'use client';

/**
 * CrawlFlowV5 — Main state-machine component
 *
 * Manages shared state and transitions between:
 *   State 1 (url-entry) → State 2 (analyzing → review) → State 3 (configure)
 *
 * Auto-saves crawl config on the source via PATCH /crawl-config on every
 * state transition so users can resume later (Draft Elimination T-6).
 */

import { useState, useCallback, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { Cloud, CloudOff, Loader2 } from 'lucide-react';
import { sanitizeError } from '@/lib/sanitize-error';
import {
  profileSite,
  clusterUrls,
  sampleGroups,
  submitBatchCrawl,
  updateCrawlConfig,
  getDiscoveryState,
  updateDiscoveryState,
  putSourceSectionUrls,
  getSourceSectionUrls,
} from '@/api/crawl';
import { addSource, fetchSources, deleteSource } from '@/api/search-ai';
import type { SearchAISource } from '@/api/search-ai';
import type { ProfileResponse, GroupStrategy, UrlGroup, CrawlDraftSection } from '@/api/crawl';
import { transitions } from '@/lib/animation';
import { useNavigationStore } from '@/store/navigation-store';
import { useAuthStore } from '@/store/auth-store';
import { State1UrlEntry } from './State1UrlEntry';
import { State2Analysis } from './State2Analysis';
import { State3Configure } from './State3Configure';
import { State4Crawl } from './State4Crawl';
import { FlowStepper } from './FlowStepper';
import { Dialog } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import type {
  CrawlFlowV5Props,
  CrawlFlowHandle,
  CrawlFlowState,
  CrawlSection,
  CrawlConfig,
  AuthConfig,
  AnalysisStep,
  ResumeDiscoveryBanner,
  SourceDiscoveryState,
} from './types';
import { DIRECT_URLS_MAX } from './types';
import { deriveNameFromPattern, estimateTime } from './utils';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Map UrlGroups to CrawlSections */
function mapGroupsToSections(
  groups: UrlGroup[],
  strategies: GroupStrategy[],
  urlPath: string,
): CrawlSection[] {
  const strategyMap = new Map(strategies.map((s) => [s.pattern, s]));
  return groups.map((g, i) => {
    const strategy = strategyMap.get(g.pattern);
    const warnings: string[] = [];
    if (strategy?.method === 'playwright') {
      warnings.push('tabs, accordions');
    }
    const pathSegments = urlPath.split('/').filter(Boolean);
    const isShallowPath = pathSegments.length <= 1;

    // Smart default selection (F25)
    const patternClean = g.pattern
      .replace(/\{[^}]+\}/g, '')
      .replace(/\*/g, '')
      .replace(/\/+$/, '');
    const excludePatterns = [
      '/page/',
      '/search',
      '/tag/',
      '/category/',
      '/author/',
      '/filter',
      '/sort',
      '/login',
      '/register',
      '/cart',
      '/checkout',
      '/api/',
    ];
    const isExcluded = excludePatterns.some((ep) => patternClean.toLowerCase().includes(ep));

    let included: boolean;
    if (isExcluded) {
      included = false;
    } else if (isShallowPath) {
      included = g.depth <= 2 || g.count >= 50;
    } else {
      included =
        g.pattern.startsWith(urlPath) ||
        urlPath.startsWith(patternClean) ||
        g.depth <= 1 ||
        g.count >= 100;
    }
    // Derive source from group properties (fix: was hardcoded to 'sitemap')
    const source: CrawlSection['source'] = g.sitemapFile ? 'sitemap' : 'auto';

    return {
      sectionId: `sec-${i}`,
      pattern: g.pattern,
      name: deriveNameFromPattern(g.pattern),
      pageCount: g.count,
      examples: g.examples,
      included,
      estimatedTime: estimateTime(g.count),
      warnings,
      depth: g.depth,
      source,
      pages: g.examples.map((url) => ({ url, title: '' })),
      strategy: strategy?.method === 'playwright' ? 'browser' : 'http',
      sitemapFile: g.sitemapFile,
      sitemapOrigin: g.sitemapOrigin,
    };
  });
}

/** Convert CrawlSections to API-saveable section records */
function sectionsToRecords(sections: CrawlSection[]): Array<Record<string, unknown>> {
  return sectionsToDraftSections(sections) as unknown as Array<Record<string, unknown>>;
}

/** Convert CrawlSections to draft-saveable section format */
function sectionsToDraftSections(sections: CrawlSection[]): CrawlDraftSection[] {
  return sections.map((s, i) => ({
    sectionId: s.sectionId ?? `sec-${i}`,
    pattern: s.pattern,
    name: s.name,
    source: s.source ?? 'sitemap',
    depth: s.depth,
    pageCount: s.pageCount,
    included: s.included,
    estimatedTime: parseInt(s.estimatedTime, 10) || 0,
    warnings: s.warnings,
    strategy: s.strategy,
    sitemapFile: s.sitemapFile,
    sitemapOrigin: s.sitemapOrigin,
  }));
}

/** Convert draft sections back to CrawlSections */
function draftSectionsToSections(
  draftSections: CrawlDraftSection[],
  existingPages?: Map<string, Array<{ url: string; title: string }>>,
): CrawlSection[] {
  return draftSections.map((ds) => ({
    sectionId: ds.sectionId,
    pattern: ds.pattern,
    name: ds.name,
    pageCount: ds.pageCount,
    examples: [],
    included: ds.included,
    estimatedTime: estimateTime(ds.pageCount),
    warnings: ds.warnings,
    depth: ds.depth,
    source: ds.source,
    pages: existingPages?.get(ds.sectionId) ?? [],
    strategy: ds.strategy,
    sitemapFile: ds.sitemapFile,
    sitemapOrigin: ds.sitemapOrigin,
  }));
}

type ConfigSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

// ─── Component ──────────────────────────────────────────────────────────────

export const CrawlFlowV5 = forwardRef<CrawlFlowHandle, CrawlFlowV5Props>(function CrawlFlowV5(
  {
    indexId,
    projectId: projectIdProp,
    sourceId: initialSourceId,
    hasCrawledBefore = false,
    onComplete,
    onCancel,
  },
  ref,
) {
  const t = useTranslations('search_ai.crawl_flow');
  const storeProjectId = useNavigationStore((s) => s.projectId);
  const projectId = projectIdProp ?? storeProjectId ?? indexId;
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);

  // ─── State machine ──────────────────────────────────────────────────
  const [flowState, setFlowState] = useState<CrawlFlowState>('url-entry');
  const [url, setUrl] = useState('');
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [sections, setSections] = useState<CrawlSection[]>([]);
  const [groupStrategies, setGroupStrategies] = useState<GroupStrategy[]>([]);
  const [analysisSteps, setAnalysisSteps] = useState<AnalysisStep[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  /** Phase B (clustering + sampling) is running in background */
  const [clusteringInProgress, setClusteringInProgress] = useState(false);
  /** Direct URLs: raw text preserved across strategy switches */
  const [directUrlsText, setDirectUrlsText] = useState('');
  /** Direct URLs: validated URL list (set by DirectUrlsPanel) */
  const [directValidUrls, setDirectValidUrls] = useState<string[]>([]);
  /** Selected strategy — tracked for State2 remount restoration */
  const [selectedStrategy, setSelectedStrategy] = useState<
    import('./types').DiscoveryStrategy | null
  >(null);
  const [crawlConfig, setCrawlConfig] = useState<CrawlConfig>({
    scope: 'limited',
    rendering: 'hybrid',
    learnedPatterns: 'keep',
    requestDelay: 200,
    maxPages: 1000,
    maxDepth: 5,
    respectRobotsTxt: true,
    cleanup: 'standard',
    deduplicate: true,
    cookieConsent: true,
  });
  const [authConfig, setAuthConfig] = useState<AuthConfig>({ method: 'none' });

  // ─── Source persistence (Draft Elimination: config saved on source) ──
  const [sourceId, setSourceIdState] = useState<string | null>(initialSourceId ?? null);
  const sourceIdRef = useRef<string | null>(sourceId);
  const setSourceId = useCallback((id: string | null) => {
    sourceIdRef.current = id;
    setSourceIdState(id);
  }, []);
  // configVersion as ref (not state) to avoid closure staleness during rapid saves.
  // React batching can cause intermediate state updates to be lost between rapid
  // async save calls, leading to stale configVersion in the closure → 409 VERSION_CONFLICT.
  const configVersionRef = useRef(1);
  const [saveStatus, setSaveStatus] = useState<ConfigSaveStatus>('idle');
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // ─── Resume discovery state ──────────────────────────────────────
  const [resumeBanner, setResumeBanner] = useState<ResumeDiscoveryBanner | null>(null);
  const [savedDiscoveryState, setSavedDiscoveryState] = useState<SourceDiscoveryState | null>(null);

  // ─── Step 4: crawl progress state ──────────────────────────────────
  const [crawlJobId, setCrawlJobId] = useState<string | null>(null);
  const [crawlSourceId, setCrawlSourceId] = useState<string | null>(null);
  /** Tracks which step of submission we're on — drives the submitting UI message */
  const [submitStep, setSubmitStep] = useState<'saving-config' | 'creating-job' | null>(null);

  // Prevent double-submit
  const analyzingRef = useRef(false);

  // ─── Close confirmation dialog ──────────────────────────────────────
  const [showCloseDialog, setShowCloseDialog] = useState(false);

  // ─── Duplicate domain check ───────────────────────────────────────
  interface DomainWarning {
    draftId: string;
    domain: string;
    isOwner: boolean;
    discoveryStatus: string;
  }
  const [domainWarning, setDomainWarning] = useState<DomainWarning[] | null>(null);
  const pendingUrlRef = useRef<string | null>(null);

  // ─── Source persistence helpers (Draft Elimination) ─────────────────

  /** Create a new source with status=configuring (replaces createCrawlDraft) */
  const createSource = useCallback(
    async (siteUrl: string): Promise<SearchAISource | null> => {
      try {
        setSaveStatus('saving');
        const domain = new URL(siteUrl).hostname;
        const { source } = await addSource(indexId, {
          name: domain,
          sourceType: 'web',
          sourceConfig: { url: siteUrl },
        });
        setSourceId(source._id);
        configVersionRef.current = source.crawlConfig?.configVersion ?? 1;
        setSaveStatus('saved');
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
        return source;
      } catch {
        setSaveStatus('error');
        return null;
      }
    },
    [indexId],
  );

  /** Save crawl config on the source (replaces updateCrawlDraft).
   *  Uses configVersionRef (not state) to avoid closure staleness during rapid saves.
   *  Retries once on 409 VERSION_CONFLICT by fetching the latest version from the error. */
  const saveCrawlConfig = useCallback(
    async (patch: {
      wizardStep?: string | null;
      strategy?: string | null;
      profile?: Record<string, unknown> | null;
      sections?: Array<Record<string, unknown>>;
      settings?: Record<string, unknown> | null;
      auth?: Record<string, unknown> | null;
      groupStrategies?: Array<Record<string, unknown>>;
      crawlJobId?: string | null;
    }) => {
      const currentSourceId = sourceIdRef.current;
      if (!currentSourceId) return;

      const attemptSave = async (version: number) => {
        const result = await updateCrawlConfig(indexId, currentSourceId, {
          ...patch,
          configVersion: version,
        });
        const updatedSource = result.source as unknown as SearchAISource;
        configVersionRef.current = updatedSource.crawlConfig?.configVersion ?? version + 1;
        return result;
      };

      try {
        setSaveStatus('saving');
        await attemptSave(configVersionRef.current);
        setSaveStatus('saved');
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
      } catch (err: unknown) {
        // Retry once on 409 VERSION_CONFLICT — fetch latest version and try again
        const isVersionConflict =
          err instanceof Error &&
          (err.message.includes('409') || err.message.includes('VERSION_CONFLICT'));
        if (isVersionConflict) {
          try {
            // Increment version optimistically and retry
            configVersionRef.current += 1;
            await attemptSave(configVersionRef.current);
            setSaveStatus('saved');
            clearTimeout(saveTimeoutRef.current);
            saveTimeoutRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
            return;
          } catch {
            // Retry also failed — fall through to error
          }
        }
        setSaveStatus('error');
      }
    },
    [indexId],
  );

  /** Persist section URLs to source URL buckets (fire-and-forget) */
  const persistSectionUrls = useCallback(
    (currentSourceId: string, currentSections: CrawlSection[]) => {
      for (let i = 0; i < currentSections.length; i++) {
        const section = currentSections[i];
        if (!section.pages || section.pages.length === 0) continue;
        const sid = section.sectionId ?? `sec-${i}`;
        const urls = section.pages.map((p) => ({
          url: p.url,
          title: p.title || null,
          score: null,
          depth: section.depth,
        }));
        // Fire and forget — don't block the UI
        putSourceSectionUrls(indexId, currentSourceId, sid, urls).catch(() => {
          // URL bucket save failed — non-critical, sections still saved on source
        });
      }
    },
    [indexId],
  );

  // ─── Step helpers ───────────────────────────────────────────────────
  const updateStep = useCallback((id: string, patch: Partial<AnalysisStep>) => {
    setAnalysisSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  // ─── Analysis pipeline (split into Phase A + Phase B) ───────────────
  //
  // Phase A (blocking): profileSite → setProfile → show strategy cards (~2-3s)
  // Phase B (fire-and-forget): clusterUrls → sampleGroups → setSections (~5-12s)
  //
  // Cards show immediately after Phase A. Sitemap card shows "Analyzing sitemap..."
  // until Phase B completes with real section data.

  /** Phase B: cluster + sample + map sections. Runs as detached promise. */
  const runClusteringPhase = useCallback(
    async (siteUrl: string, profileResp: ProfileResponse, currentSourceId: string | null) => {
      // Extract path for section matching
      let urlPath = '/';
      try {
        urlPath = new URL(siteUrl).pathname;
      } catch {
        // ignore
      }

      const CLUSTERING_TIMEOUT_MS = 30_000;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Sitemap analysis timed out')), CLUSTERING_TIMEOUT_MS),
      );

      try {
        const clusterResp = await Promise.race([
          clusterUrls(siteUrl, {
            platform: profileResp.platform,
            apiEndpoints: profileResp.apiEndpoints,
            sourceId: currentSourceId ?? undefined,
            // Pass profile's sitemap URLs directly — avoids re-fetching sitemaps
            // which is non-deterministic and loses URLs due to timeouts
            urls: profileResp.sitemapDiscovery?.allUrls,
          }),
          timeoutPromise,
        ]);

        const ungroupedCount = clusterResp.ungrouped?.length ?? 0;
        // Use stats.totalUrls for accurate total — the sum of group counts + ungrouped
        // only reflects URLs in the top-100 groups, not the full sitemap
        const groupedPages = clusterResp.groups.reduce((sum, g) => sum + g.count, 0);
        const totalPages = clusterResp.stats?.totalUrls ?? groupedPages + ungroupedCount;
        // Ungrouped bucket holds all URLs not in the top-100 groups
        const ungroupedBucketCount = totalPages - groupedPages;
        const sectionCount = clusterResp.groups.length + (ungroupedBucketCount > 0 ? 1 : 0);

        updateStep('discover', {
          status: 'complete',
          result: t('discovering_result', {
            total: totalPages.toLocaleString(),
            sections: sectionCount.toString(),
          }),
        });
        updateStep('sections', { status: 'active' });

        // Sample groups for strategies
        const sampleResp = await sampleGroups(clusterResp.groups);
        setGroupStrategies(sampleResp.strategies);

        // Map to sections
        const mappedSections = mapGroupsToSections(
          clusterResp.groups,
          sampleResp.strategies,
          urlPath,
        );

        // Append ungrouped URLs as an "Other Pages" section
        // This includes both the clusterer's ungrouped AND overflow from maxGroups cap
        if (ungroupedBucketCount > 0) {
          mappedSections.push({
            sectionId: 'sec-ungrouped',
            pattern: '(other)',
            name: t('discovery_group_other_pages'),
            pageCount: ungroupedBucketCount,
            examples: (clusterResp.ungrouped ?? []).slice(0, 10),
            included: false,
            estimatedTime: estimateTime((clusterResp.ungrouped ?? []).length),
            warnings: [],
            depth: 0,
            source: 'auto',
            pages: (clusterResp.ungrouped ?? []).slice(0, 10).map((u) => ({ url: u, title: '' })),
          });
        }

        setSections(mappedSections);

        // Auto-save sections to draft
        if (currentSourceId) {
          saveCrawlConfig({
            wizardStep: 'sections_ready',
            sections: sectionsToRecords(mappedSections),
          });
          // DO NOT call persistSectionUrls here.
          // ALL sections from clustering (sitemap, auto, and ungrouped) already
          // have full URL lists stored server-side by storeBucketUrlsForGroups()
          // during the cluster-urls API call. Persisting from the frontend would
          // OVERWRITE those full lists with only ~10 example URLs held locally.
        }

        updateStep('sections', {
          status: 'complete',
          result: t('sections_found', { count: mappedSections.length.toString() }),
        });
        updateStep('complete', { status: 'complete' });
      } catch (err: unknown) {
        const message = sanitizeError(err, t('analysis_failed'));
        toast.error(message);

        // Mark clustering steps as error — profile step stays complete
        updateStep('discover', { status: 'error', result: message });
        updateStep('sections', { status: 'error' });
      } finally {
        setClusteringInProgress(false);
        setIsAnalyzing(false);
        analyzingRef.current = false;
      }
    },
    [t, updateStep, saveCrawlConfig],
  );

  /**
   * Handle custom sitemap validation — re-run clustering with the user-provided URL.
   * Called from StrategySelector when user enters a custom sitemap and it validates.
   */
  const handleCustomSitemapValidated = useCallback(
    async (sitemapUrl: string, _urlCount: number) => {
      if (!profile || !url) return;

      setClusteringInProgress(true);

      let urlPath = '/';
      try {
        urlPath = new URL(url).pathname;
      } catch {
        // ignore
      }

      try {
        const clusterResp = await clusterUrls(url, {
          platform: profile.platform,
          apiEndpoints: profile.apiEndpoints,
          customSitemapUrl: sitemapUrl,
          sourceId: sourceId ?? undefined,
        });

        const ungroupedCount = clusterResp.ungrouped?.length ?? 0;
        const groupedPages = clusterResp.groups.reduce((sum, g) => sum + g.count, 0);
        const totalPages = clusterResp.stats?.totalUrls ?? groupedPages + ungroupedCount;
        const ungroupedBucketCount = totalPages - groupedPages;

        updateStep('discover', {
          status: 'complete',
          result: t('discovering_result', {
            total: totalPages.toLocaleString(),
            sections: (clusterResp.groups.length + (ungroupedBucketCount > 0 ? 1 : 0)).toString(),
          }),
        });

        const sampleResp = await sampleGroups(clusterResp.groups);
        setGroupStrategies(sampleResp.strategies);

        const mappedSections = mapGroupsToSections(
          clusterResp.groups,
          sampleResp.strategies,
          urlPath,
        );

        // Append ungrouped URLs as an "Other Pages" section
        // This includes both the clusterer's ungrouped AND overflow from maxGroups cap
        if (ungroupedBucketCount > 0) {
          mappedSections.push({
            sectionId: 'sec-ungrouped',
            pattern: '(other)',
            name: t('discovery_group_other_pages'),
            pageCount: ungroupedBucketCount,
            examples: (clusterResp.ungrouped ?? []).slice(0, 10),
            included: false,
            estimatedTime: estimateTime((clusterResp.ungrouped ?? []).length),
            warnings: [],
            depth: 0,
            source: 'auto',
            pages: (clusterResp.ungrouped ?? []).slice(0, 10).map((u) => ({ url: u, title: '' })),
          });
        }

        setSections(mappedSections);

        if (sourceId) {
          saveCrawlConfig({
            wizardStep: 'sections_ready',
            sections: sectionsToRecords(mappedSections),
          });
          // DO NOT call persistSectionUrls here — same reason as runClusteringPhase.
          // ALL sections from clustering have full URL lists stored server-side
          // by storeBucketUrlsForGroups(). Frontend-persisting would overwrite.
        }
      } catch (err: unknown) {
        const message = sanitizeError(err, t('analysis_failed'));
        toast.error(message);
      } finally {
        setClusteringInProgress(false);
      }
    },
    [profile, url, sourceId, t, updateStep, saveCrawlConfig],
  );

  /** Full analysis: Phase A (blocking) then Phase B (fire-and-forget). */
  const runAnalysis = useCallback(
    async (siteUrl: string) => {
      if (analyzingRef.current) return;
      analyzingRef.current = true;
      setIsAnalyzing(true);
      setClusteringInProgress(false);

      // Initialize steps
      const initialSteps: AnalysisStep[] = [
        { id: 'discover', label: t('discovering_pages'), status: 'active' },
        { id: 'sections', label: t('finding_sections'), status: 'pending' },
        { id: 'complete', label: t('analysis_complete'), status: 'pending' },
      ];
      setAnalysisSteps(initialSteps);

      // Create source on analysis start (use ref to get latest value after state reset)
      let currentSourceId = sourceIdRef.current;
      if (!currentSourceId) {
        const src = await createSource(siteUrl);
        if (src) currentSourceId = src._id;
      }

      try {
        // ── Phase A (blocking): Profile site → show strategy cards ──
        const profileResp = await profileSite(siteUrl);
        setProfile(profileResp);

        // Set default rendering mode based on site type (separate from discovery strategy)
        if (profileResp.jsRequired || profileResp.siteType === 'spa') {
          setCrawlConfig((prev) => ({ ...prev, rendering: 'browser' }));
        } else if (profileResp.siteType === 'static') {
          setCrawlConfig((prev) => ({ ...prev, rendering: 'http' }));
        }
        // else keep default 'hybrid'

        // Auto-save profile to source crawl config
        if (currentSourceId) {
          saveCrawlConfig({
            profile: {
              domain: profileResp.domain,
              siteType: profileResp.siteType,
              hasSitemap: profileResp.hasSitemap,
              jsRequired: profileResp.jsRequired,
              estimatedSize: profileResp.estimatedSize,
              avgResponseTime: profileResp.avgResponseTime,
              platform: profileResp.platform ?? null,
            },
          });
        }

        // ── Phase B (fire-and-forget): Cluster + sample ──
        // Skip clustering entirely if site has no sitemap (nothing to cluster)
        if (!profileResp.hasSitemap) {
          // No sitemap → mark steps as complete immediately, no clustering needed
          updateStep('discover', {
            status: 'complete',
            result: t('no_sitemap_found'),
          });
          updateStep('sections', { status: 'complete' });
          updateStep('complete', { status: 'complete' });
          setIsAnalyzing(false);
          analyzingRef.current = false;
          return;
        }

        // Sitemap exists → run clustering in background
        setClusteringInProgress(true);

        // Fire-and-forget: don't await — cards are already showing
        // runClusteringPhase handles its own errors and cleanup
        runClusteringPhase(siteUrl, profileResp, currentSourceId);
      } catch (err: unknown) {
        // Phase A error — profile failed, no cards shown
        const message = sanitizeError(err, t('analysis_failed'));
        toast.error(message);

        // Mark current active step as error
        setAnalysisSteps((prev) =>
          prev.map((s) => (s.status === 'active' ? { ...s, status: 'error', result: message } : s)),
        );
        setIsAnalyzing(false);
        setClusteringInProgress(false);
        analyzingRef.current = false;
      }
    },
    [t, updateStep, createSource, saveCrawlConfig, runClusteringPhase],
  );

  // ─── Resume from source (must be after runAnalysis definition) ──────

  const runAnalysisRef = useRef(runAnalysis);
  runAnalysisRef.current = runAnalysis;

  /** Restore wizard state from a source's crawlConfig + discovery state */
  const restoreFromSource = useCallback(
    async (src: SearchAISource) => {
      const cc = src.crawlConfig;

      // Old draft-status sources have no crawlConfig — can't resume
      if (!cc && src.status === 'draft') {
        toast.error(t('source_legacy_draft'));
        return;
      }

      setSourceId(src._id);
      configVersionRef.current = cc?.configVersion ?? 1;
      const sourceUrl = (src.sourceConfig as { url?: string })?.url ?? '';
      setUrl(sourceUrl);

      if (cc?.profile) {
        setProfile({
          success: true,
          domain: cc.profile.domain,
          siteType: cc.profile.siteType,
          estimatedSize: cc.profile.estimatedSize,
          hasSitemap: cc.profile.hasSitemap,
          jsRequired: cc.profile.jsRequired,
          avgResponseTime: cc.profile.avgResponseTime,
          metadata: { title: '', description: '', favicon: '' },
          platform: cc.profile.platform ?? undefined,
        });
      }

      if (cc?.sections && cc.sections.length > 0) {
        setSections(draftSectionsToSections(cc.sections as unknown as CrawlDraftSection[]));
      }

      // Restore selected strategy
      if (cc?.strategy) {
        setSelectedStrategy(cc.strategy as import('./types').DiscoveryStrategy);
      }

      // Restore crawl settings (fixes: settings always reset to defaults on resume/recrawl)
      if (cc?.settings) {
        setCrawlConfig((prev) => ({
          ...prev,
          scope: (cc.settings!.scope as CrawlConfig['scope']) ?? prev.scope,
          rendering: (cc.settings!.rendering as CrawlConfig['rendering']) ?? prev.rendering,
          maxPages: cc.settings!.maxPages ?? prev.maxPages,
          maxDepth: cc.settings!.maxDepth ?? prev.maxDepth,
          respectRobotsTxt: cc.settings!.respectRobotsTxt ?? prev.respectRobotsTxt,
        }));
      }

      // Restore auth config (fixes: auth never persisted — data loss bug)
      if (cc?.auth && cc.auth.method) {
        const restored: AuthConfig = { method: cc.auth.method as AuthConfig['method'] };
        if (cc.auth.bearerToken) restored.bearerToken = cc.auth.bearerToken;
        if (cc.auth.cookieString) restored.cookieString = cc.auth.cookieString;
        if (cc.auth.customHeaders && cc.auth.customHeaders.length > 0) {
          restored.customHeaders = cc.auth.customHeaders;
        }
        if (cc.auth.basicUsername) restored.basicUsername = cc.auth.basicUsername;
        if (cc.auth.basicPassword) restored.basicPassword = cc.auth.basicPassword;
        setAuthConfig(restored);
      }

      // Restore group strategies
      if (cc?.groupStrategies && cc.groupStrategies.length > 0) {
        setGroupStrategies(cc.groupStrategies as unknown as GroupStrategy[]);
      }

      // Helper: mark analysis as complete (sections already restored from draft)
      const markAnalysisComplete = () => {
        setAnalysisSteps([
          { id: 'discover', label: t('discovering_pages'), status: 'complete' },
          { id: 'sections', label: t('finding_sections'), status: 'complete' },
          { id: 'complete', label: t('analysis_complete'), status: 'complete' },
        ]);
      };

      // Check for saved discovery state → show resume banner
      try {
        const dsResp = await getDiscoveryState(indexId, src._id);
        const ds = dsResp.data.discoveryState as SourceDiscoveryState | null;
        if (ds?.savedAt && cc?.wizardStep !== 'submitted') {
          setSavedDiscoveryState(ds);
          const discoveredCount =
            (ds as { discoveredUrls?: Array<unknown> }).discoveredUrls?.length ?? 0;
          const sectionCount = cc?.sections?.length ?? 0;
          const includedCount =
            cc?.sections?.filter((s: { included?: boolean }) => s.included !== false).length ?? 0;
          setResumeBanner({
            show: true,
            discoveredCount,
            sectionCount,
            includedCount,
            savedAt: ds.savedAt,
          });
          setFlowState('analyzing');
          markAnalysisComplete();
          return;
        }
      } catch {
        // Discovery state fetch failed — proceed without banner
      }

      // Restore to appropriate flow state
      const wizardStep = cc?.wizardStep ?? 'profiling';
      if (wizardStep === 'configured' || wizardStep === 'submitted') {
        setFlowState('configure');
        // Sections already restored — mark analysis complete so action bar shows
        // immediately if user navigates back to analysis view
        markAnalysisComplete();
      } else if (wizardStep === 'sections_ready') {
        setFlowState('analyzing');
        markAnalysisComplete();
      } else {
        // Profiling state — re-run analysis from where it left off
        setFlowState('analyzing');
        if (sourceUrl) runAnalysisRef.current(sourceUrl);
      }

      toast.success(t('draft_resumed'));
    },
    [indexId, t],
  );

  useEffect(() => {
    if (!initialSourceId) return;
    let cancelled = false;

    async function loadSource() {
      try {
        // Fetch the source to get crawlConfig
        const { sources } = await fetchSources(indexId);
        const src = sources.find((s) => s._id === initialSourceId);
        if (cancelled || !src) return;
        await restoreFromSource(src);

        // Restore direct-urls text from bucket (same logic as handleResumeSource)
        const cc = src.crawlConfig;
        if (!cancelled && cc?.strategy === 'direct-urls' && cc.sections.length > 0) {
          const directSection = cc.sections[0];
          if (directSection?.sectionId) {
            try {
              const result = await getSourceSectionUrls(
                indexId,
                initialSourceId!,
                directSection.sectionId,
                { limit: DIRECT_URLS_MAX },
              );
              if (!cancelled) {
                const urls = result.data.urls.map((u) => u.url);
                setDirectUrlsText(urls.join('\n'));
                setDirectValidUrls(urls);
              }
            } catch {
              // Best-effort — user can re-paste if bucket read fails
            }
          }
        }
      } catch {
        // Source load failed — start fresh
      }
    }

    loadSource();
    return () => {
      cancelled = true;
    };
    // Mount-only: initialSourceId doesn't change after mount (component remounts for new sources)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSourceId]);

  // ─── Transitions ────────────────────────────────────────────────────

  /** Proceed with URL analysis (called directly or after domain check dismissal) */
  const proceedWithUrl = useCallback(
    (siteUrl: string) => {
      setDomainWarning(null);
      pendingUrlRef.current = null;
      setFlowState('analyzing');

      // If returning from Step 1 with existing sections for the same URL,
      // skip re-analysis — just restore the existing state
      if (sections.length > 0 && siteUrl === url && profile) {
        // Mark analysis steps as complete so UI shows restored state
        setAnalysisSteps([
          { id: 'discover', label: t('discovering_pages'), status: 'complete' },
          { id: 'sections', label: t('finding_sections'), status: 'complete' },
          { id: 'complete', label: t('analysis_complete'), status: 'complete' },
        ]);
        return;
      }

      // Different URL — clear old state so stale sections don't persist
      if (siteUrl !== url) {
        setSections([]);
        setProfile(null);
        setGroupStrategies([]);
        setAnalysisSteps([]);
        // New URL gets a new draft — don't pollute the old one
        setSourceId(null);
        configVersionRef.current = 1;
        setSaveStatus('idle');
      }

      setUrl(siteUrl);
      runAnalysis(siteUrl);
    },
    [runAnalysis, sections.length, url, profile, t],
  );

  const handleUrlSubmit = useCallback(
    async (siteUrl: string) => {
      // Check for duplicate domain before starting analysis (uses source list)
      try {
        const domain = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`)
          .hostname;
        const { sources: allSources } = await fetchSources(indexId);
        const existing = allSources
          .filter((s) => {
            if (s.sourceType !== 'web' || s.status !== 'configuring') return false;
            try {
              const cfg = s.sourceConfig as Record<string, unknown> | undefined;
              return new URL(String(cfg?.url ?? '')).hostname === domain;
            } catch {
              return false;
            }
          })
          .map((s) => ({
            draftId: s._id,
            domain,
            isOwner: !s.createdBy || s.createdBy === currentUserId,
            discoveryStatus: 'configuring',
          }));
        if (existing.length > 0) {
          setDomainWarning(existing);
          pendingUrlRef.current = siteUrl;
          return;
        }
      } catch {
        // Domain check failed — proceed anyway
      }
      proceedWithUrl(siteUrl);
    },
    [indexId, proceedWithUrl],
  );

  const handleBackToUrlEntry = useCallback(() => {
    // Non-destructive back: preserve sections, profile, and discovery state
    // so re-entering Step 2 restores existing data without re-running analysis
    setFlowState('url-entry');
    setIsAnalyzing(false);
    analyzingRef.current = false;
  }, []);

  /** Wrap setSections so every change auto-saves to draft */
  const handleSectionsChange = useCallback(
    (updated: CrawlSection[]) => {
      setSections(updated);
      if (sourceId) {
        saveCrawlConfig({
          wizardStep: 'sections_ready',
          sections: sectionsToRecords(updated),
        });
      }
    },
    [sourceId, saveCrawlConfig],
  );

  const handleContinue = useCallback(() => {
    setFlowState('configure');
    // Auto-save transition to configured + mark discovery as complete
    if (sourceId) {
      saveCrawlConfig({
        wizardStep: 'configured',
        sections: sectionsToRecords(sections),
        settings: crawlConfig as unknown as Record<string, unknown>,
        auth:
          authConfig.method !== 'none' ? (authConfig as unknown as Record<string, unknown>) : null,
        groupStrategies: groupStrategies as unknown as Array<Record<string, unknown>>,
      });
      // Mark discovery as complete in the separate discovery-state store
      updateDiscoveryState(indexId, sourceId, {
        discoveryState: { completedAt: Date.now() },
        discoveryStatus: 'complete',
      }).catch(() => {
        // Best-effort — non-critical
      });
      // Only persist 'direct'-sourced section URLs to source URL buckets.
      // ALL clustering-originated sections (sitemap, auto, ungrouped) already
      // have full URL lists stored server-side by storeBucketUrlsForGroups()
      // during the cluster-urls API call. Persisting those from the frontend
      // would OVERWRITE full lists with only ~10 local example URLs.
      const directSections = sections.filter(
        (s) => s.pages && s.pages.length > 0 && s.source === 'direct',
      );
      if (directSections.length > 0) {
        persistSectionUrls(sourceId, directSections);
      }
    }
  }, [
    sourceId,
    indexId,
    saveCrawlConfig,
    sections,
    persistSectionUrls,
    authConfig,
    crawlConfig,
    groupStrategies,
  ]);

  /** Direct URLs: create a single section from validated URLs and transition to configure */
  const handleDirectUrlsConfigure = useCallback(() => {
    if (directValidUrls.length === 0) return;

    const renderingStrategy: 'http' | 'browser' =
      profile?.jsRequired || profile?.siteType === 'spa' ? 'browser' : 'http';

    const section: CrawlSection = {
      sectionId: `sec-direct-${Date.now()}`,
      pattern: '/*',
      name: 'Direct URLs',
      pageCount: directValidUrls.length,
      pages: directValidUrls.map((u) => ({ url: u, title: '' })),
      source: 'direct',
      included: true,
      strategy: renderingStrategy,
      estimatedTime: estimateTime(directValidUrls.length),
      examples: directValidUrls.slice(0, 5),
      warnings: [],
      depth: 0,
    };

    setSections([section]);
    setFlowState('configure');

    if (sourceId) {
      saveCrawlConfig({
        strategy: 'direct-urls',
        wizardStep: 'configured',
        sections: sectionsToRecords([section]),
      });
      persistSectionUrls(sourceId, [section]);
    }
  }, [directValidUrls, profile, sourceId, saveCrawlConfig, persistSectionUrls]);

  const handleBackToAnalysis = useCallback(() => {
    setFlowState('analyzing');
    // Restore analysis steps as complete when going back with existing sections
    if (sections.length > 0) {
      setAnalysisSteps([
        { id: 'discover', label: t('discovering_pages'), status: 'complete' },
        { id: 'sections', label: t('finding_sections'), status: 'complete' },
        { id: 'complete', label: t('analysis_complete'), status: 'complete' },
      ]);
    }
  }, [sections.length, t]);

  const [isStarting, setIsStarting] = useState(false);
  /** Ref flag: triggers handleStartCrawl on next render after setSections commits */
  const pendingDirectCrawlRef = useRef(false);

  const handleStartCrawl = useCallback(async () => {
    if (isStarting) return;
    if (!sourceId) {
      toast.error(t('crawl_failed'));
      return;
    }
    setIsStarting(true);
    setFlowState('submitting');

    try {
      // 1. Collect URLs from included sections
      const includedSections = sections.filter((s) => s.included);
      if (includedSections.length === 0) {
        toast.error(t('no_sections_selected'));
        setFlowState('analyzing');
        return;
      }

      // Gather URLs: bucket-first (full URL list), fall back to section pages/examples
      let allUrls: string[] = [];
      const perSectionUrls: string[][] = [];
      for (let i = 0; i < includedSections.length; i++) {
        const section = includedSections[i];
        const sid = section.sectionId ?? `sec-${i}`;
        const sectionUrls: string[] = [];

        // Try source URL buckets first — contains full URL list from clustering
        try {
          const BUCKET_PAGE_SIZE = 100;
          let offset = 0;
          let hasMore = true;
          while (hasMore) {
            const bucketResult = await getSourceSectionUrls(indexId, sourceId, sid, {
              offset,
              limit: BUCKET_PAGE_SIZE,
            });
            if (bucketResult.data.urls.length > 0) {
              sectionUrls.push(...bucketResult.data.urls.map((u) => u.url));
            }
            offset += bucketResult.data.urls.length;
            hasMore =
              bucketResult.data.urls.length === BUCKET_PAGE_SIZE &&
              offset < bucketResult.data.pagination.total;
          }
        } catch {
          // Bucket read failed — fall through to local state
        }

        // Fallback: use locally available pages or examples (~10 URLs max)
        if (sectionUrls.length === 0) {
          if (section.pages && section.pages.length > 0) {
            sectionUrls.push(...section.pages.map((p) => p.url));
          } else if (section.examples && section.examples.length > 0) {
            sectionUrls.push(...section.examples);
          }
        }

        perSectionUrls.push(sectionUrls);
        allUrls.push(...sectionUrls);
      }

      // Last resort: use the base URL itself
      if (allUrls.length === 0) {
        allUrls = [url];
      }

      // Deduplicate
      allUrls = [...new Set(allUrls)];

      // 2. Source already exists (created at Step 1) — use existing sourceId
      // No addSource call needed.

      // 3. Map rendering config to strategy
      const strategyMap: Record<string, string> = {
        http: 'bulk',
        browser: 'playwright',
        hybrid: 'smart',
      };

      // 4. Build section mapping for per-section progress tracking
      const sectionMapping = includedSections.map((s, i) => ({
        sectionId: s.sectionId ?? `sec-${i}`,
        pattern: s.pattern,
        name: s.name,
        urls: perSectionUrls[i] ?? [],
        strategy: s.strategy,
      }));

      // 5. Build the submission payload
      const submissionPayload = {
        urls: allUrls,
        indexId,
        sourceId,
        strategy: strategyMap[crawlConfig.rendering] ?? 'smart',
        limits: {
          maxPages: crawlConfig.maxPages,
          maxDepth: crawlConfig.scope === 'limited' ? 3 : 10,
        },
        filters: {},
        sectionMapping,
        options: { skipPrompts: true },
        crawlSettings: {
          crawlDelay: crawlConfig.requestDelay,
          respectRobotsTxt: crawlConfig.respectRobotsTxt,
          cleanupLevel: crawlConfig.cleanup,
          deduplicate: crawlConfig.deduplicate,
          cookieConsent: crawlConfig.cookieConsent,
          reuseHandlers: crawlConfig.learnedPatterns === 'keep',
        },
      };

      // 6. Save config + submit job sequentially, showing step progress.
      //    Navigate to USP only after both succeed — avoids "Source not found"
      //    caused by stale SWR cache when navigating before the job exists.

      // Step 6a: Save crawl configuration
      setSubmitStep('saving-config');
      try {
        await saveCrawlConfig({
          wizardStep: 'submitted',
          sections: sectionsToRecords(sections),
          settings: {
            scope: crawlConfig.scope,
            rendering: crawlConfig.rendering,
            maxPages: crawlConfig.maxPages,
            maxDepth: crawlConfig.scope === 'limited' ? 3 : 10,
            respectRobotsTxt: crawlConfig.respectRobotsTxt,
            includePaths: [],
            excludePaths: [],
          },
        });
      } catch (configErr: unknown) {
        const message = sanitizeError(configErr, t('submit_config_failed'));
        toast.error(message);
        setSubmitStep(null);
        setFlowState('configure');
        return;
      }

      // Step 6b: Submit crawl job
      setSubmitStep('creating-job');
      const result = await submitBatchCrawl(submissionPayload);

      if (!result.success || result.needsUserInput) {
        toast.error(t('crawl_failed'));
        setSubmitStep(null);
        setFlowState('configure');
        return;
      }

      if (!result.jobId) {
        toast.error(t('crawl_failed'));
        setSubmitStep(null);
        setFlowState('configure');
        return;
      }

      // Step 6c: Save jobId back to config (non-critical — best-effort)
      try {
        await saveCrawlConfig({ crawlJobId: result.jobId });
      } catch {
        // Non-critical — crawl is already running
      }

      setSubmitStep(null);
      setIsStarting(false);
      toast.success(t('crawl_submitted'));

      // Navigate to USP if onComplete provided, otherwise show crawl panel.
      // IMPORTANT: reset all state BEFORE onComplete — it triggers navigation
      // which unmounts CrawlFlowV5. Setting state after unmount causes the
      // React warning "Can't perform state update on unmounted component".
      if (onComplete) {
        onComplete(result.jobId, sourceId, url);
      } else {
        setCrawlJobId(result.jobId);
        setCrawlSourceId(sourceId);
        setFlowState('crawling');
      }
    } catch (err: unknown) {
      const message = sanitizeError(err, t('crawl_failed'));
      toast.error(message);
      setSubmitStep(null);
      setFlowState('configure');
      setIsStarting(false);
    }
  }, [isStarting, sections, sourceId, url, indexId, crawlConfig, saveCrawlConfig, onComplete, t]);

  /** Direct crawl: skip Configure, use defaults, go straight to crawling */
  const handleDirectCrawl = useCallback(() => {
    // Persist section URLs to source URL buckets (same as handleContinue)
    if (sourceId) {
      saveCrawlConfig({
        wizardStep: 'configured',
        sections: sectionsToRecords(sections),
      });
      // Only persist 'direct'-sourced sections — ALL clustering-originated
      // sections already have full URL lists stored server-side
      const directSections = sections.filter(
        (s) => s.pages && s.pages.length > 0 && s.source === 'direct',
      );
      if (directSections.length > 0) {
        persistSectionUrls(sourceId, directSections);
      }
    }
    // Go directly to crawl with default config
    handleStartCrawl();
  }, [sourceId, saveCrawlConfig, sections, persistSectionUrls, handleStartCrawl]);

  /** Direct URLs: skip Configure, use defaults, go straight to crawling.
   *  Sets sections then signals via ref — an effect fires handleStartCrawl
   *  after React commits the new sections, avoiding a stale-closure race. */
  const handleDirectUrlsDirectCrawl = useCallback(() => {
    if (directValidUrls.length === 0) return;

    const renderingStrategy: 'http' | 'browser' =
      profile?.jsRequired || profile?.siteType === 'spa' ? 'browser' : 'http';

    const section: CrawlSection = {
      sectionId: `sec-direct-${Date.now()}`,
      pattern: '/*',
      name: 'Direct URLs',
      pageCount: directValidUrls.length,
      pages: directValidUrls.map((u) => ({ url: u, title: '' })),
      source: 'direct',
      included: true,
      strategy: renderingStrategy,
      estimatedTime: estimateTime(directValidUrls.length),
      examples: directValidUrls.slice(0, 5),
      warnings: [],
      depth: 0,
    };

    setSections([section]);

    if (sourceId) {
      saveCrawlConfig({
        strategy: 'direct-urls',
        wizardStep: 'configured',
        sections: sectionsToRecords([section]),
      });
      persistSectionUrls(sourceId, [section]);
    }

    // Signal: fire handleStartCrawl on next render after sections commit
    pendingDirectCrawlRef.current = true;
  }, [directValidUrls, profile, sourceId, saveCrawlConfig, persistSectionUrls]);

  // Effect: triggers handleStartCrawl after setSections commits for direct-URL crawl
  useEffect(() => {
    if (pendingDirectCrawlRef.current && sections.length > 0 && sections[0]?.source === 'direct') {
      pendingDirectCrawlRef.current = false;
      handleStartCrawl();
    }
  }, [sections, handleStartCrawl]);

  const handleResumeSource = useCallback(
    async (resumeSourceId: string) => {
      try {
        // Fetch the source to get crawlConfig
        const { sources } = await fetchSources(indexId);
        const src = sources.find((s) => s._id === resumeSourceId);
        if (!src) {
          toast.error(t('draft_load_failed'));
          return;
        }

        await restoreFromSource(src);

        // Restore direct-urls text from bucket if strategy was direct-urls
        const cc = src.crawlConfig;
        if (cc?.strategy === 'direct-urls' && cc.sections.length > 0) {
          const directSection = cc.sections[0];
          if (directSection?.sectionId) {
            getSourceSectionUrls(indexId, resumeSourceId, directSection.sectionId, {
              limit: DIRECT_URLS_MAX,
            })
              .then((result) => {
                const urls = result.data.urls.map((u) => u.url);
                setDirectUrlsText(urls.join('\n'));
                setDirectValidUrls(urls);
              })
              .catch(() => {
                // Best-effort — user can re-paste if bucket read fails
              });
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(msg);
      }
    },
    [indexId, t, restoreFromSource],
  );

  // ─── Close confirmation ──────────────────────────────────────────────

  /** Request close — behaviour depends on source lifecycle:
   * - Already crawled (reconfigure): just close — config is auto-saved, no draft to delete
   * - New source (first setup): show confirmation with Save/Delete options
   * - Crawling/submitting: just close (can't interrupt)
   */
  const handleRequestClose = useCallback(() => {
    if (flowState === 'crawling' || flowState === 'submitting') {
      // During active crawl/submit — just close (no confirmation needed)
      onCancel();
      return;
    }
    if (hasCrawledBefore) {
      // Reconfigure flow: source already has data — no need for Save/Delete dialog.
      // Config changes are auto-saved, so just navigate back.
      onCancel();
      return;
    }
    if (sourceId) {
      // First-time setup: source exists as draft — offer Save or Delete
      setShowCloseDialog(true);
    } else {
      onCancel();
    }
  }, [sourceId, flowState, hasCrawledBefore, onCancel]);

  // Expose requestClose to parent via ref
  useImperativeHandle(ref, () => ({ requestClose: handleRequestClose }), [handleRequestClose]);

  /** Delete source and close wizard */
  const handleDeleteAndClose = useCallback(async () => {
    if (sourceId) {
      try {
        await deleteSource(indexId, sourceId);
        toast.success(t('draft_deleted'));
      } catch {
        // Best-effort — close anyway
      }
    }
    setShowCloseDialog(false);
    onCancel();
  }, [sourceId, indexId, t, onCancel]);

  /** Save and close — just close (config is already auto-saved) */
  const handleSaveAndClose = useCallback(() => {
    setShowCloseDialog(false);
    onCancel();
  }, [onCancel]);

  // ─── Step 4 handlers ────────────────────────────────────────────────
  const handleViewResults = useCallback(
    (resultSourceId: string, filter?: string) => {
      // When filter is provided (e.g. 'thin'), append as query param for downstream navigation
      const targetUrl = filter ? `${url}?docFilter=${filter}` : url;
      onComplete?.(crawlJobId ?? '', resultSourceId, targetUrl);
    },
    [crawlJobId, url, onComplete],
  );

  const handleCrawlComplete = useCallback(() => {
    setFlowState('done');
  }, []);

  const handleBackToConfigure = useCallback(() => {
    setFlowState('configure');
  }, []);

  // ─── Flow stepper navigation (F27) ─────────────────────────────────
  const handleStepClick = useCallback(
    (step: CrawlFlowState) => {
      // Block navigation while submitting or crawling — async work is in progress
      if (flowState === 'submitting' || flowState === 'crawling') return;
      if (step === 'url-entry') handleBackToUrlEntry();
      else if (step === 'analyzing') handleBackToAnalysis();
    },
    [flowState, handleBackToUrlEntry, handleBackToAnalysis],
  );

  // ─── Save status indicator ────────────────────────────────────────
  const renderSaveStatus = () => {
    if (saveStatus === 'idle' && !sourceId) return null;

    return (
      <div className="flex items-center gap-1.5 text-xs text-muted ml-auto">
        {saveStatus === 'saving' && (
          <>
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>{t('draft_saving')}</span>
          </>
        )}
        {saveStatus === 'saved' && (
          <motion.div
            className="flex items-center gap-1 text-success"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <Cloud className="w-3 h-3" />
            <span>{t('draft_saved')}</span>
          </motion.div>
        )}
        {saveStatus === 'error' && (
          <div className="flex items-center gap-1 text-danger">
            <CloudOff className="w-3 h-3" />
            <span>{t('draft_save_failed')}</span>
          </div>
        )}
        {saveStatus === 'idle' && sourceId && (
          <div className="flex items-center gap-1 opacity-50">
            <Cloud className="w-3 h-3" />
          </div>
        )}
      </div>
    );
  };

  // ─── Render ─────────────────────────────────────────────────────────
  return (
    <div className="w-full">
      {/* Flow stepper — only shown after url-entry */}
      {flowState !== 'url-entry' && (
        <div className="flex items-center gap-3 mb-4">
          <FlowStepper currentStep={flowState} onStepClick={handleStepClick} />
          {renderSaveStatus()}
        </div>
      )}

      <AnimatePresence mode="wait">
        {flowState === 'url-entry' && (
          <motion.div
            key="url-entry"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={transitions.stageSlide}
          >
            <State1UrlEntry
              onSubmit={handleUrlSubmit}
              isLoading={isAnalyzing}
              initialUrl={url}
              projectId={projectId}
              indexId={indexId}
              onResumeSource={handleResumeSource}
              authConfig={authConfig}
              onAuthConfigChange={setAuthConfig}
            />
          </motion.div>
        )}

        {flowState === 'analyzing' && (
          <motion.div
            key="analyzing"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={transitions.stageSlide}
          >
            {/* Resume banner — shown when draft has saved discovery state */}
            {resumeBanner?.show && (
              <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 mb-4 space-y-2">
                <p className="text-sm font-medium text-foreground">
                  {t('resume_title', {
                    count: resumeBanner.discoveredCount.toString(),
                    sections: resumeBanner.sectionCount.toString(),
                    included: resumeBanner.includedCount.toString(),
                  })}
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => {
                      setResumeBanner(null);
                    }}
                    className="rounded-lg bg-accent text-accent-foreground text-xs font-medium px-3 py-1.5 hover:bg-accent/90 transition-default"
                  >
                    {t('resume_review_sections')}
                  </button>
                  <button
                    onClick={() => {
                      setResumeBanner(null);
                      setSavedDiscoveryState(null);
                      if (sourceId) {
                        updateDiscoveryState(indexId, sourceId, {
                          discoveryState: {},
                          discoveryStatus: 'idle',
                        }).catch(() => {
                          // Intentional: best-effort clear, failure is non-fatal
                        });
                      }
                      setFlowState('url-entry');
                    }}
                    className="rounded-lg border border-default text-xs font-medium px-3 py-1.5 hover:bg-muted/10 transition-default"
                  >
                    {t('resume_fresh')}
                  </button>
                  <button
                    onClick={() => {
                      setResumeBanner(null);
                      setFlowState('configure');
                    }}
                    className="rounded-lg border border-default text-xs font-medium px-3 py-1.5 hover:bg-muted/10 transition-default"
                  >
                    {t('resume_proceed')}
                  </button>
                </div>
              </div>
            )}

            <State2Analysis
              url={url}
              indexId={indexId}
              profile={profile}
              sections={sections}
              onSectionsChange={handleSectionsChange}
              onContinue={handleContinue}
              onDirectCrawl={handleDirectCrawl}
              isAnalyzing={isAnalyzing}
              analysisSteps={analysisSteps}
              groupStrategies={groupStrategies}
              sourceId={sourceId ?? undefined}
              configVersion={configVersionRef.current}
              initialDiscoveryState={savedDiscoveryState}
              clusteringInProgress={clusteringInProgress}
              directUrlsText={directUrlsText}
              onDirectUrlsTextChange={setDirectUrlsText}
              onDirectUrlsValidChange={setDirectValidUrls}
              onDirectUrlsConfigure={handleDirectUrlsConfigure}
              onDirectUrlsDirectCrawl={handleDirectUrlsDirectCrawl}
              initialStrategy={selectedStrategy}
              onStrategyChange={setSelectedStrategy}
              onCustomSitemapValidated={handleCustomSitemapValidated}
            />
          </motion.div>
        )}

        {flowState === 'configure' && (
          <motion.div
            key="configure"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={transitions.stageSlide}
          >
            <State3Configure
              sections={sections}
              totalPages={sections
                .filter((s) => s.included)
                .reduce((sum, s) => sum + s.pageCount, 0)}
              config={crawlConfig}
              onConfigChange={setCrawlConfig}
              onStartCrawl={handleStartCrawl}
              onBack={handleBackToAnalysis}
              isStarting={isStarting}
              baseUrl={url}
            />
          </motion.div>
        )}

        {flowState === 'submitting' && (
          <motion.div
            key="submitting"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={transitions.stageSlide}
          >
            <div className="flex flex-col items-center justify-center py-24 gap-4">
              <Loader2 className="w-8 h-8 animate-spin text-accent" />
              <p className="text-sm text-muted">
                {submitStep === 'saving-config'
                  ? t('submit_saving_config')
                  : submitStep === 'creating-job'
                    ? t('submit_creating_job')
                    : t('crawl_submitting')}
              </p>
            </div>
          </motion.div>
        )}

        {(flowState === 'crawling' || flowState === 'done') && crawlJobId && crawlSourceId && (
          <motion.div
            key="crawling"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={transitions.stageSlide}
          >
            <State4Crawl
              jobId={crawlJobId}
              sourceId={crawlSourceId}
              url={url}
              sections={sections}
              totalPages={sections
                .filter((s) => s.included)
                .reduce((sum, s) => sum + s.pageCount, 0)}
              onViewResults={handleViewResults}
              onBack={handleBackToConfigure}
              onCrawlComplete={handleCrawlComplete}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Close confirmation dialog — Save & Close or Delete Source */}
      <Dialog
        open={showCloseDialog}
        onClose={() => setShowCloseDialog(false)}
        title={t('panel_title')}
        maxWidth="sm"
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">
            {url
              ? `Configuration for ${url} will be saved. You can resume later from the sources table.`
              : 'Your progress will be saved. You can resume later from the sources table.'}
          </p>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" onClick={handleSaveAndClose}>
              {t('wizard_save_close')}
            </Button>
            <Button size="sm" variant="danger" onClick={handleDeleteAndClose}>
              {t('wizard_delete_source')}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Duplicate domain warning dialog */}
      <Dialog
        open={domainWarning !== null && domainWarning.length > 0}
        onClose={() => {
          setDomainWarning(null);
          pendingUrlRef.current = null;
        }}
        title={t('domain_warning_title')}
        maxWidth="sm"
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">{t('domain_warning_description')}</p>
          {domainWarning?.map((d) => (
            <div
              key={d.draftId}
              className="flex items-center gap-2 text-xs text-foreground bg-background-subtle rounded-lg px-3 py-2"
            >
              <span className="font-medium">{d.domain}</span>
              <span className="text-muted">
                {d.isOwner ? t('domain_warning_yours') : t('domain_warning_other_user')}
              </span>
              <span className="text-accent">{d.discoveryStatus}</span>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={() => {
                if (pendingUrlRef.current) {
                  proceedWithUrl(pendingUrlRef.current);
                }
              }}
            >
              {t('domain_warning_start_anyway')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setDomainWarning(null);
                pendingUrlRef.current = null;
              }}
            >
              {t('domain_warning_cancel')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
});
