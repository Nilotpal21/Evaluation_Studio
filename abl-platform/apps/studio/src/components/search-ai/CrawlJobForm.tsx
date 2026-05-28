/**
 * CrawlJobForm Component
 *
 * Progressive disclosure UX for submitting crawl jobs:
 *
 * 1. Enter URL -> auto-profile on blur
 * 2. Show site preview card with metadata
 * 3. Choose scope: single-page or full-site
 * 4. Full-site options: strategy, batch URLs, advanced limits, filters
 * 5. Check for saved preference:
 *    a) Preference with autoDecide -> 3-second countdown, then auto-start
 *    b) Preference without autoDecide -> pre-fill strategy, user clicks Start
 * 6. No preference -> submit to backend:
 *    a) High confidence (backend auto-decides) -> job starts
 *    b) Low confidence (needsUserInput) -> show QuestionPrompt
 * 7. After job starts -> offer to save preference
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { Globe, Bookmark, CheckCircle2, Clock, FileText, Info } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Alert } from '@/components/ui/Alert';
import { profileSite, submitBatchCrawl, respondToQuestions } from '@/api/crawl';
import type { ProfileResponse, BatchSubmitResponse, CrawlFilters } from '@/api/crawl';
import { useCrawlPreferences } from '@/hooks/useCrawlPreferences';
import { QuestionPrompt, type PromptQuestion } from './QuestionPrompt';
import { SavePreferenceDialog } from './SavePreferenceDialog';
import { UrlPreviewDialog } from './UrlPreviewDialog';
import { getFriendlyError, type FriendlyError } from '@/lib/error-messages';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildFilters(
  includePaths?: string,
  excludePaths?: string,
  contentKeywords?: string,
): CrawlFilters | undefined {
  const include = includePaths
    ?.split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const exclude = excludePaths
    ?.split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const keywords = contentKeywords
    ?.split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  if (!include?.length && !exclude?.length && !keywords?.length) return undefined;
  return {
    includePaths: include?.length ? include : undefined,
    excludePaths: exclude?.length ? exclude : undefined,
    contentKeywords: keywords?.length ? keywords : undefined,
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const formSchema = z.object({
  url: z.string().url('Please enter a valid URL'),
  scope: z.enum(['single-page', 'full-site']),
  batchUrls: z.string().optional(),
  strategy: z.enum(['smart', 'sitemap', 'limited', 'full-site']).optional(),
  maxPages: z.coerce.number().min(1).max(50000).optional(),
  maxDepth: z.coerce.number().min(0).max(20).optional(),
  includePaths: z.string().optional(),
  excludePaths: z.string().optional(),
  contentKeywords: z.string().optional(),
});

type FormData = z.infer<typeof formSchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTO_START_SECONDS = 3;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface CrawlJobFormProps {
  indexId: string;
  sourceId: string;
  initialUrl?: string;
  onJobSubmitted: (jobId: string) => void;
}

export function CrawlJobForm({ indexId, sourceId, initialUrl, onJobSubmitted }: CrawlJobFormProps) {
  const t = useTranslations('search_ai.crawl_form');

  // --- Strategy options (depend on t) ---
  const STRATEGY_OPTIONS = useMemo(
    () => [
      { value: 'smart', label: t('strategy_smart') },
      { value: 'sitemap', label: t('strategy_sitemap') },
      { value: 'limited', label: t('strategy_limited') },
      { value: 'full-site', label: t('strategy_full_site') },
    ],
    [t],
  );

  const STRATEGY_DESCRIPTIONS: Record<string, string> = useMemo(
    () => ({
      smart: t('strategy_smart_desc'),
      sitemap: t('strategy_sitemap_desc'),
      limited: t('strategy_limited_desc'),
      'full-site': t('strategy_full_site_desc'),
    }),
    [t],
  );

  // --- Form state ---
  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: { url: '', scope: 'single-page' },
  });
  const watchedUrl = form.watch('url');
  const watchedScope = form.watch('scope');
  const watchedStrategy = form.watch('strategy');

  // Pre-fill URL from initialUrl prop (e.g. re-crawl)
  useEffect(() => {
    if (initialUrl) {
      form.setValue('url', initialUrl);
      // Auto-profile when URL is pre-filled (e.g., from re-crawl)
      handleProfile(initialUrl);
    }
  }, [initialUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Profile ---
  const [profiling, setProfiling] = useState(false);
  const [profile, setProfile] = useState<ProfileResponse | null>(null);

  // --- Submission ---
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);

  // --- Question flow ---
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<PromptQuestion[] | null>(null);

  // --- Countdown (auto-start from preference) ---
  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownRef = useRef<NodeJS.Timeout | null>(null);

  // --- Save preference dialog ---
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [lastSubmittedUrl, setLastSubmittedUrl] = useState('');

  // --- Ref for latest doSubmit (used in countdown effect) ---
  const doSubmitRef = useRef<((data: FormData) => Promise<void>) | null>(null);

  // --- Progressive disclosure toggles ---
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showBatchUrls, setShowBatchUrls] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [selectedPreviewUrls, setSelectedPreviewUrls] = useState<string[]>([]);

  // --- Preferences ---
  const { matchingPreference } = useCrawlPreferences(
    profile ? watchedUrl : null, // Only match after profiling
  );

  // ---------------------------------------------------------------------------
  // Profile handler
  // ---------------------------------------------------------------------------

  const handleProfile = useCallback(async (url: string): Promise<ProfileResponse | null> => {
    setProfiling(true);
    setError(null);
    setQuestions(null);
    setPendingId(null);
    try {
      const response = await profileSite(url);
      setProfile(response);
      return response;
    } catch (err) {
      setError(
        getFriendlyError(err instanceof Error ? err : String(err), {
          code: 'PROFILE_FAILED',
          url,
        }),
      );
      setProfile(null);
      return null;
    } finally {
      setProfiling(false);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Auto-start countdown when autoDecide preference matches
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (matchingPreference?.autoDecide && profile && !submitting && !questions) {
      setCountdown(AUTO_START_SECONDS);
      let remaining = AUTO_START_SECONDS;

      countdownRef.current = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(countdownRef.current!);
          countdownRef.current = null;
          setCountdown(null);
          // Trigger submit
          if (doSubmitRef.current) form.handleSubmit(doSubmitRef.current)();
        } else {
          setCountdown(remaining);
        }
      }, 1000);

      return () => {
        if (countdownRef.current) {
          clearInterval(countdownRef.current);
          countdownRef.current = null;
        }
      };
    }
    // Cancel any running countdown if conditions no longer hold
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
      setCountdown(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchingPreference, profile, submitting, questions]);

  const cancelCountdown = () => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    setCountdown(null);
  };

  // ---------------------------------------------------------------------------
  // Submit handler
  // ---------------------------------------------------------------------------

  const doSubmit = useCallback(
    async (data: FormData) => {
      if (!sourceId) {
        setError({
          title: t('source_not_ready_title'),
          message: t('source_not_ready_message'),
        });
        return;
      }
      setSubmitting(true);
      setError(null);

      try {
        // Profile first if not done
        let currentProfile = profile;
        if (!currentProfile) {
          currentProfile = await handleProfile(data.url);
          if (!currentProfile) {
            setSubmitting(false);
            return;
          }
        }

        // Build URL list
        let allUrls: string[];
        if (selectedPreviewUrls.length > 0) {
          allUrls = selectedPreviewUrls;
        } else {
          allUrls = [data.url];
          if (data.scope === 'full-site' && data.batchUrls) {
            const extraUrls = data.batchUrls
              .split('\n')
              .map((u) => u.trim())
              .filter(Boolean);
            allUrls.push(...extraUrls);
          }
        }

        // Determine strategy
        const effectiveStrategy =
          data.scope === 'single-page'
            ? 'single-page'
            : data.strategy || matchingPreference?.strategy || 'smart';

        // Build filters
        const filters =
          data.scope === 'full-site'
            ? buildFilters(data.includePaths, data.excludePaths, data.contentKeywords)
            : undefined;

        // Build submission
        const response: BatchSubmitResponse = await submitBatchCrawl({
          urls: allUrls,
          indexId,
          sourceId,
          strategy: effectiveStrategy,
          limits:
            data.maxPages || data.maxDepth
              ? { maxPages: data.maxPages, maxDepth: data.maxDepth }
              : undefined,
          filters,
        });

        if (response.needsUserInput && response.questions && response.pendingId) {
          // Low confidence -- show questions
          setPendingId(response.pendingId);
          setQuestions(response.questions as PromptQuestion[]);
        } else if (response.jobId) {
          // Job started successfully
          setLastSubmittedUrl(data.url);
          onJobSubmitted(response.jobId);
          form.reset();
          setProfile(null);
          setQuestions(null);
          setPendingId(null);
          setSelectedPreviewUrls([]);
          // Offer to save preference (if not already saved)
          if (!matchingPreference) {
            setShowSaveDialog(true);
          }
        }
      } catch (err) {
        setError(
          getFriendlyError(err instanceof Error ? err : String(err), {
            operation: 'submit_crawl',
          }),
        );
      } finally {
        setSubmitting(false);
      }
    },
    [
      profile,
      handleProfile,
      indexId,
      sourceId,
      matchingPreference,
      selectedPreviewUrls,
      onJobSubmitted,
      form,
      t,
    ],
  );

  // Keep doSubmitRef in sync with the latest doSubmit
  useEffect(() => {
    doSubmitRef.current = doSubmit;
  }, [doSubmit]);

  // ---------------------------------------------------------------------------
  // Question response handler
  // ---------------------------------------------------------------------------

  const handleQuestionSubmit = async (responses: Array<{ questionId: string; value: string }>) => {
    if (!pendingId) return;
    setSubmitting(true);
    setError(null);

    try {
      const response = await respondToQuestions(pendingId, responses);

      if (response.jobId) {
        setLastSubmittedUrl(watchedUrl);
        onJobSubmitted(response.jobId);

        // Reset all form state immediately
        form.reset();
        setProfile(null);
        setQuestions(null);
        setPendingId(null);
        setError(null);
        setSelectedPreviewUrls([]);

        if (!matchingPreference) {
          setShowSaveDialog(true);
        }
      } else {
        setError(
          getFriendlyError('Unexpected response from server', {
            operation: 'respond_questions',
          }),
        );
      }
    } catch (err) {
      setError(
        getFriendlyError(err instanceof Error ? err : String(err), {
          operation: 'respond_questions',
        }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const cancelQuestions = () => {
    setQuestions(null);
    setPendingId(null);
  };

  // ---------------------------------------------------------------------------
  // Render: Question flow
  // ---------------------------------------------------------------------------

  if (questions && questions.length > 0) {
    return (
      <>
        {error && (
          <Alert variant="error" className="mb-4" title={error.title}>
            <p>{error.message}</p>
            {error.action && (
              <Button variant="secondary" size="sm" onClick={error.action.onClick} className="mt-2">
                {error.action.label}
              </Button>
            )}
            {error.documentation && (
              <a
                href={error.documentation}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-info hover:underline mt-2 block"
              >
                {t('learn_more')}
              </a>
            )}
          </Alert>
        )}
        <QuestionPrompt
          questions={questions}
          onSubmit={handleQuestionSubmit}
          onCancel={cancelQuestions}
          submitting={submitting}
        />
      </>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: Main form
  // ---------------------------------------------------------------------------

  return (
    <>
      <Card padding="lg" hoverable={false}>
        <form onSubmit={form.handleSubmit(doSubmit)} className="space-y-4">
          {/* URL input */}
          <Input
            label={t('url_label')}
            placeholder="https://example.com"
            disabled={profiling || submitting || countdown !== null}
            error={form.formState.errors.url?.message}
            icon={<Globe className="w-4 h-4" />}
            {...form.register('url')}
            onBlur={(e) => {
              form.register('url').onBlur(e); // keep RHF onBlur
              const url = e.target.value;
              if (url && !form.formState.errors.url) {
                handleProfile(url);
              }
            }}
          />

          {/* Public URL notice */}
          <div className="flex items-start gap-2 p-3 rounded-lg bg-background-muted text-xs text-muted">
            <Info className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-foreground">{t('public_urls_only')}</p>
              <p>{t('public_urls_only_desc')}</p>
            </div>
          </div>

          {/* Loading indicator with skeleton */}
          {profiling && (
            <Card padding="md" className="bg-background-muted animate-pulse">
              <div className="space-y-2">
                {/* Title skeleton */}
                <div className="h-4 w-3/4 bg-background rounded mb-2"></div>
                {/* Description skeleton */}
                <div className="h-3 w-full bg-background rounded"></div>
                {/* Metadata grid skeleton */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <div className="h-3 w-full bg-background rounded"></div>
                  <div className="h-3 w-full bg-background rounded"></div>
                  <div className="h-3 w-full bg-background rounded"></div>
                  <div className="h-3 w-full bg-background rounded"></div>
                </div>
              </div>
              {/* Progress indicator */}
              <div className="mt-3 text-xs text-muted flex items-center gap-2">
                <div className="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
                {t('analyzing_site')}
              </div>
            </Card>
          )}

          {/* Matching preference banner */}
          {matchingPreference && profile && (
            <Alert variant="success" title={t('preference_matched_title')}>
              <div className="space-y-2">
                <p className="text-sm">
                  {t('preference_using_strategy', { strategy: matchingPreference.strategy })}
                </p>
                <ul className="text-sm list-disc list-inside space-y-1">
                  <li>
                    {t('domain_pattern_label')}{' '}
                    <code className="text-xs bg-background px-1 py-0.5 rounded">
                      {matchingPreference.domainPattern}
                    </code>
                  </li>
                  {profile.siteType && (
                    <li>
                      {t('site_type_label')} {profile.siteType}
                    </li>
                  )}
                  <li>{t('used_count', { count: matchingPreference.useCount || 0 })}</li>
                  {matchingPreference.autoDecide && (
                    <li className="text-info font-medium">{t('auto_start_enabled')}</li>
                  )}
                </ul>
                <Button
                  variant="ghost"
                  size="xs"
                  type="button"
                  onClick={() => setShowSaveDialog(true)}
                  className="mt-1"
                >
                  {t('edit_preference')}
                </Button>
              </div>
            </Alert>
          )}

          {/* Countdown modal overlay */}
          {countdown !== null && (
            <div className="fixed inset-0 bg-overlay flex items-center justify-center z-50">
              <Card className="max-w-md p-6 text-center">
                {/* Circular countdown timer */}
                <div className="relative w-32 h-32 mx-auto mb-4">
                  <svg className="transform -rotate-90 w-32 h-32">
                    {/* Background circle */}
                    <circle
                      cx="64"
                      cy="64"
                      r="56"
                      stroke="currentColor"
                      strokeWidth="8"
                      fill="none"
                      className="text-muted"
                    />
                    {/* Progress circle */}
                    <circle
                      cx="64"
                      cy="64"
                      r="56"
                      stroke="currentColor"
                      strokeWidth="8"
                      fill="none"
                      strokeDasharray={2 * Math.PI * 56}
                      strokeDashoffset={2 * Math.PI * 56 * (1 - countdown / AUTO_START_SECONDS)}
                      className="text-accent transition-all duration-1000"
                    />
                  </svg>
                  {/* Countdown number */}
                  <div className="absolute inset-0 flex items-center justify-center text-4xl font-bold">
                    {countdown}
                  </div>
                </div>
                <h3 className="text-lg font-semibold mb-2">{t('auto_starting_crawl')}</h3>
                <p className="text-muted mb-4">
                  {t('using_saved_preference', { strategy: matchingPreference?.strategy ?? '' })}
                </p>
                <Button
                  variant="secondary"
                  size="lg"
                  type="button"
                  onClick={cancelCountdown}
                  className="w-full"
                >
                  {t('cancel_auto_start')}
                </Button>
              </Card>
            </div>
          )}

          {/* Site preview */}
          {profile && (
            <Card padding="md" hoverable={false} className="bg-background-muted">
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="text-sm font-semibold text-foreground truncate">
                      {profile.metadata.title || profile.domain}
                    </h4>
                    <p className="text-xs text-muted mt-0.5 line-clamp-2">
                      {profile.metadata.description || profile.domain}
                    </p>
                  </div>
                  {profile.metadata.favicon && (
                    <img
                      src={profile.metadata.favicon}
                      alt=""
                      className="w-8 h-8 rounded shrink-0"
                    />
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <div>
                    <span className="text-muted">{t('type_label')} </span>
                    <span className="font-medium text-foreground">{profile.siteType}</span>
                  </div>
                  <div>
                    <span className="text-muted">{t('est_pages_label')} </span>
                    <span className="font-medium text-foreground">{profile.estimatedSize}</span>
                  </div>
                  <div>
                    <span className="text-muted">{t('sitemap_label')} </span>
                    <Badge variant={profile.hasSitemap ? 'success' : 'default'}>
                      {profile.hasSitemap ? t('yes') : t('no')}
                    </Badge>
                  </div>
                  <div>
                    <span className="text-muted">{t('js_required_label')} </span>
                    <Badge variant={profile.jsRequired ? 'warning' : 'default'}>
                      {profile.jsRequired ? t('yes') : t('no')}
                    </Badge>
                  </div>
                </div>
                {/* Estimated duration */}
                {profile.estimatedDuration && (
                  <div className="flex items-center gap-2 text-xs text-muted pt-1 border-t border-background-subtle">
                    <Clock className="w-3 h-3" />
                    <span>
                      {t('estimated_time')}{' '}
                      <strong className="text-foreground">
                        {profile.estimatedDuration.formatted}
                      </strong>
                    </span>
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* Scope selector */}
          {profile && (
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => form.setValue('scope', 'single-page')}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  watchedScope === 'single-page'
                    ? 'border-accent bg-accent-subtle'
                    : 'border-border hover:border-accent/50'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <FileText className="w-4 h-4 text-accent" />
                  <span className="text-sm font-medium text-foreground">
                    {t('scope_single_page')}
                  </span>
                </div>
                <p className="text-xs text-muted">{t('scope_single_page_desc')}</p>
              </button>
              <button
                type="button"
                onClick={() => form.setValue('scope', 'full-site')}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  watchedScope === 'full-site'
                    ? 'border-accent bg-accent-subtle'
                    : 'border-border hover:border-accent/50'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Globe className="w-4 h-4 text-accent" />
                  <span className="text-sm font-medium text-foreground">
                    {t('scope_full_site')}
                  </span>
                </div>
                <p className="text-xs text-muted">{t('scope_full_site_desc')}</p>
              </button>
            </div>
          )}

          {/* Full-site options */}
          {watchedScope === 'full-site' && profile && (
            <div className="space-y-4">
              {/* Strategy selector */}
              <Select
                label={t('crawl_strategy_label')}
                options={STRATEGY_OPTIONS}
                value={watchedStrategy ?? ''}
                onChange={(v) => form.setValue('strategy', v as any)}
              />
              {watchedStrategy && STRATEGY_DESCRIPTIONS[watchedStrategy] && (
                <p className="text-xs text-muted -mt-2">{STRATEGY_DESCRIPTIONS[watchedStrategy]}</p>
              )}

              {/* Batch URLs toggle */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowBatchUrls(!showBatchUrls)}
                  className="text-xs text-info hover:underline"
                >
                  {showBatchUrls ? t('hide_multiple_urls') : t('add_multiple_urls')}
                </button>
                {showBatchUrls && (
                  <Textarea
                    label={t('additional_urls_label')}
                    placeholder={'https://example.com/page1\nhttps://example.com/page2'}
                    rows={4}
                    className="mt-2"
                    {...form.register('batchUrls')}
                  />
                )}
              </div>

              {/* Advanced options toggle */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="text-xs text-info hover:underline flex items-center gap-1"
                >
                  {showAdvanced ? '\u25BE' : '\u25B8'} {t('advanced_options')}
                </button>
                {showAdvanced && (
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    <Input
                      label={t('max_pages_label')}
                      type="number"
                      placeholder="50"
                      {...form.register('maxPages')}
                    />
                    <Input
                      label={t('max_depth_label')}
                      type="number"
                      placeholder="3"
                      {...form.register('maxDepth')}
                    />
                  </div>
                )}
              </div>

              {/* Filters toggle */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowFilters(!showFilters)}
                  className="text-xs text-info hover:underline flex items-center gap-1"
                >
                  {showFilters ? '\u25BE' : '\u25B8'} {t('url_content_filters')}
                </button>
                {showFilters && (
                  <div className="space-y-3 mt-2">
                    <Input
                      label={t('include_paths_label')}
                      placeholder="/docs/*, /api/*"
                      {...form.register('includePaths')}
                    />
                    <Input
                      label={t('exclude_paths_label')}
                      placeholder="/blog/*, /changelog"
                      {...form.register('excludePaths')}
                    />
                    <Input
                      label={t('content_keywords_label')}
                      placeholder={t('content_keywords_placeholder')}
                      {...form.register('contentKeywords')}
                    />
                  </div>
                )}
              </div>

              {/* Preview URLs button */}
              {profile?.hasSitemap && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowPreview(true)}
                >
                  {t('preview_urls_from_sitemap')}
                </Button>
              )}

              {/* Selected preview URLs indicator */}
              {selectedPreviewUrls.length > 0 && (
                <div className="flex items-center gap-2 text-xs">
                  <Badge variant="accent">
                    {t('urls_selected_from_preview', { count: selectedPreviewUrls.length })}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => setSelectedPreviewUrls([])}
                    className="text-xs text-muted hover:text-foreground"
                  >
                    {t('clear')}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <Alert variant="error" title={error.title}>
              <p>{error.message}</p>
              {error.action && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={error.action.onClick}
                  className="mt-2"
                >
                  {error.action.label}
                </Button>
              )}
              {error.documentation && (
                <a
                  href={error.documentation}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-info hover:underline mt-2 block"
                >
                  {t('learn_more')}
                </a>
              )}
              <div className="flex items-center gap-2 mt-3">
                <Button variant="ghost" size="sm" type="button" onClick={() => setError(null)}>
                  {t('dismiss')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  onClick={() => {
                    setError(null);
                    setProfile(null);
                    form.reset();
                  }}
                >
                  {t('start_over')}
                </Button>
              </div>
            </Alert>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              variant="primary"
              className="flex-1"
              loading={profiling || submitting}
              disabled={
                countdown !== null || !sourceId || (!watchedUrl && !profiling && !submitting)
              }
            >
              {profiling
                ? t('analysing')
                : submitting
                  ? t('starting_crawl')
                  : profile
                    ? t('start_crawl')
                    : t('analyze_and_crawl')}
            </Button>
            {profile && (
              <Button
                type="button"
                variant="secondary"
                size="md"
                icon={<Bookmark className="w-4 h-4" />}
                onClick={() => {
                  setLastSubmittedUrl(watchedUrl);
                  setShowSaveDialog(true);
                }}
              >
                {t('save_preference')}
              </Button>
            )}
          </div>
        </form>
      </Card>

      {/* Save preference dialog */}
      <SavePreferenceDialog
        open={showSaveDialog}
        onClose={() => setShowSaveDialog(false)}
        url={lastSubmittedUrl || watchedUrl}
        suggestedStrategy={profile?.jsRequired ? 'browser' : 'hybrid'}
      />

      {/* URL preview dialog */}
      <UrlPreviewDialog
        open={showPreview}
        onClose={() => setShowPreview(false)}
        url={watchedUrl}
        onConfirm={(urls) => {
          setSelectedPreviewUrls(urls);
          setShowPreview(false);
        }}
      />
    </>
  );
}
