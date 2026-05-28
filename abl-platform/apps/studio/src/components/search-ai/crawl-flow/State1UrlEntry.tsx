'use client';

/**
 * State 1 — URL Entry
 *
 * Clean URL input with a "How our crawler works" collapsible explainer.
 * Shows saved drafts below the input so users can resume.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Scan,
  Brain,
  RotateCcw,
  MessageSquare,
  FileText,
  Trash2,
  Play,
  Shield,
  Plus,
  X,
  KeyRound,
  User,
  Globe,
  Cookie,
} from 'lucide-react';
import { clsx } from 'clsx';
import { toast } from 'sonner';
import { Button } from '../../ui/Button';
import { fetchSources, deleteSource } from '@/api/search-ai';
import type { SearchAISource } from '@/api/search-ai';
import type { State1UrlEntryProps, AuthMethod, HeaderEntry } from './types';

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value.startsWith('http') ? value : `https://${value}`);
    return url.hostname.includes('.');
  } catch {
    return false;
  }
}

/** Format relative time for draft age */
function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Extract domain from URL */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Auth method display config */
const AUTH_METHODS: { value: AuthMethod; icon: React.ReactNode; label: string; desc: string }[] = [
  {
    value: 'none',
    icon: <Globe className="w-4 h-4" />,
    label: 'Public',
    desc: 'No authentication needed',
  },
  {
    value: 'bearer',
    icon: <KeyRound className="w-4 h-4" />,
    label: 'Bearer Token',
    desc: 'API key or access token',
  },
  {
    value: 'basic',
    icon: <User className="w-4 h-4" />,
    label: 'Basic Auth',
    desc: 'Username & password',
  },
  {
    value: 'headers',
    icon: <Shield className="w-4 h-4" />,
    label: 'Custom Headers',
    desc: 'Arbitrary request headers',
  },
  {
    value: 'cookies',
    icon: <Cookie className="w-4 h-4" />,
    label: 'Session Cookies',
    desc: 'Paste from browser DevTools',
  },
];

export function State1UrlEntry({
  onSubmit,
  isLoading,
  initialUrl,
  projectId,
  indexId,
  onResumeSource,
  authConfig,
  onAuthConfigChange,
}: State1UrlEntryProps) {
  const t = useTranslations('search_ai.crawl_flow');
  const [url, setUrl] = useState(initialUrl ?? '');
  const [expanded, setExpanded] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configuringSources, setConfiguringSources] = useState<SearchAISource[]>([]);
  const [loadingDrafts, setLoadingDrafts] = useState(false);

  // ─── Load configuring sources (replaces listCrawlDrafts) ──────────
  useEffect(() => {
    if (!indexId) return;
    let cancelled = false;

    async function load() {
      setLoadingDrafts(true);
      try {
        const { sources } = await fetchSources(indexId!);
        if (!cancelled) {
          // Only show web sources in configuring status
          setConfiguringSources(
            sources.filter((s) => s.status === 'configuring' && s.sourceType === 'web'),
          );
        }
      } catch {
        // Silent — configuring sources list is optional
      } finally {
        if (!cancelled) setLoadingDrafts(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [indexId]);

  const handleSubmit = useCallback(() => {
    const trimmed = url.trim();
    if (!trimmed) return;
    if (!isValidUrl(trimmed)) {
      setError(t('url_invalid'));
      return;
    }
    setError(null);
    const normalized = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
    onSubmit(normalized);
  }, [url, onSubmit, t]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleDeleteSource = useCallback(
    async (sourceId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await deleteSource(indexId!, sourceId);
        setConfiguringSources((prev) => prev.filter((s) => s._id !== sourceId));
        toast.success(t('draft_deleted'));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(msg);
      }
    },
    [indexId, t],
  );

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const [authExpanded, setAuthExpanded] = useState(authConfig.method !== 'none');

  const handleAddHeader = useCallback(() => {
    const current = authConfig.customHeaders ?? [];
    onAuthConfigChange({ ...authConfig, customHeaders: [...current, { key: '', value: '' }] });
  }, [authConfig, onAuthConfigChange]);

  const handleRemoveHeader = useCallback(
    (index: number) => {
      const current = authConfig.customHeaders ?? [];
      onAuthConfigChange({ ...authConfig, customHeaders: current.filter((_, i) => i !== index) });
    },
    [authConfig, onAuthConfigChange],
  );

  const handleHeaderChange = useCallback(
    (index: number, field: 'key' | 'value', val: string) => {
      const current = [...(authConfig.customHeaders ?? [])];
      current[index] = { ...current[index], [field]: val };
      onAuthConfigChange({ ...authConfig, customHeaders: current });
    },
    [authConfig, onAuthConfigChange],
  );

  const steps = useMemo(
    () => [
      {
        icon: <Scan className="w-4 h-4" />,
        label: t('step_analyse'),
        desc: t('step_analyse_desc'),
      },
      { icon: <Brain className="w-4 h-4" />, label: t('step_learn'), desc: t('step_learn_desc') },
      {
        icon: <RotateCcw className="w-4 h-4" />,
        label: t('step_reuse'),
        desc: t('step_reuse_desc'),
      },
      {
        icon: <MessageSquare className="w-4 h-4" />,
        label: t('step_improve'),
        desc: t('step_improve_desc'),
      },
    ],
    [t],
  );

  // ─── Flow state label mapping ─────────────────────────────────────
  const flowStateLabel = useCallback(
    (state: string) => {
      const map: Record<string, string> = {
        profiling: t('draft_profiling'),
        sections_ready: t('draft_sections_ready'),
        configured: t('draft_configured'),
        submitted: t('draft_submitted'),
      };
      return map[state] ?? state;
    },
    [t],
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="text-center space-y-1">
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted">{t('subtitle')}</p>
      </div>

      {/* URL input row */}
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <input
            type="url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('url_placeholder')}
            disabled={isLoading}
            className={clsx(
              'w-full rounded-lg border bg-background-subtle text-foreground placeholder:text-subtle',
              'transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
              'text-sm py-2 px-3',
              error ? 'border-error' : 'border-default',
            )}
            aria-label={t('url_placeholder')}
          />
          {error && <p className="text-xs text-error mt-1">{error}</p>}
        </div>
        <Button
          onClick={handleSubmit}
          loading={isLoading}
          disabled={isLoading || !url.trim()}
          icon={<ArrowRight className="w-4 h-4" />}
        >
          {t('go')}
        </Button>
      </div>

      {/* Authentication (collapsible) */}
      <div className="rounded-xl border border-default bg-background-elevated">
        <button
          onClick={() => setAuthExpanded((p) => !p)}
          className="flex items-center justify-between w-full px-4 py-3 text-sm font-medium text-foreground hover:bg-background-muted rounded-xl transition-default"
          aria-expanded={authExpanded}
        >
          <span className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-muted" />
            {t('auth_heading')}
            {authConfig.method !== 'none' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent font-medium">
                {AUTH_METHODS.find((m) => m.value === authConfig.method)?.label}
              </span>
            )}
          </span>
          {authExpanded ? (
            <ChevronUp className="w-4 h-4 text-muted" />
          ) : (
            <ChevronDown className="w-4 h-4 text-muted" />
          )}
        </button>
        {authExpanded && (
          <div className="px-4 pb-4 space-y-4">
            <p className="text-xs text-muted">{t('auth_hint')}</p>

            {/* Auth method selector */}
            <div className="grid grid-cols-5 gap-1.5">
              {AUTH_METHODS.map((method) => {
                const isSelected = authConfig.method === method.value;
                return (
                  <button
                    key={method.value}
                    onClick={() => onAuthConfigChange({ ...authConfig, method: method.value })}
                    className={clsx(
                      'flex flex-col items-center gap-1 p-2.5 rounded-lg border text-center transition-default',
                      isSelected
                        ? 'border-accent bg-accent/5 ring-1 ring-accent'
                        : 'border-default bg-background-subtle hover:bg-background-muted',
                    )}
                  >
                    <span className={isSelected ? 'text-accent' : 'text-muted'}>{method.icon}</span>
                    <span className="text-[10px] font-medium text-foreground">{method.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Bearer token */}
            {authConfig.method === 'bearer' && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">
                  {t('auth_bearer_label')}
                </label>
                <input
                  type="password"
                  value={authConfig.bearerToken ?? ''}
                  onChange={(e) =>
                    onAuthConfigChange({ ...authConfig, bearerToken: e.target.value })
                  }
                  placeholder={t('auth_bearer_placeholder')}
                  className="w-full rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle text-sm py-2 px-3 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default"
                />
                <p className="text-[10px] text-muted">{t('auth_bearer_hint')}</p>
              </div>
            )}

            {/* Basic auth */}
            {authConfig.method === 'basic' && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">
                    {t('auth_basic_user')}
                  </label>
                  <input
                    type="text"
                    value={authConfig.basicUsername ?? ''}
                    onChange={(e) =>
                      onAuthConfigChange({ ...authConfig, basicUsername: e.target.value })
                    }
                    placeholder={t('auth_basic_user_placeholder')}
                    className="w-full rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle text-sm py-2 px-3 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">
                    {t('auth_basic_password')}
                  </label>
                  <input
                    type="password"
                    value={authConfig.basicPassword ?? ''}
                    onChange={(e) =>
                      onAuthConfigChange({ ...authConfig, basicPassword: e.target.value })
                    }
                    placeholder={t('auth_basic_password_placeholder')}
                    className="w-full rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle text-sm py-2 px-3 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default"
                  />
                </div>
              </div>
            )}

            {/* Custom headers */}
            {authConfig.method === 'headers' && (
              <div className="space-y-2">
                <label className="text-xs font-medium text-foreground">
                  {t('auth_headers_label')}
                </label>
                {(authConfig.customHeaders ?? []).map((header, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={header.key}
                      onChange={(e) => handleHeaderChange(i, 'key', e.target.value)}
                      placeholder={t('auth_header_key')}
                      className="flex-1 rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle text-sm py-1.5 px-2.5 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default"
                    />
                    <input
                      type="text"
                      value={header.value}
                      onChange={(e) => handleHeaderChange(i, 'value', e.target.value)}
                      placeholder={t('auth_header_value')}
                      className="flex-1 rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle text-sm py-1.5 px-2.5 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default"
                    />
                    <button
                      onClick={() => handleRemoveHeader(i)}
                      className="p-1 text-muted hover:text-danger rounded transition-default"
                      aria-label={t('auth_header_remove')}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  onClick={handleAddHeader}
                  className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 transition-default"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {t('auth_header_add')}
                </button>
              </div>
            )}

            {/* Session cookies */}
            {authConfig.method === 'cookies' && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">
                  {t('auth_cookies_label')}
                </label>
                <textarea
                  value={authConfig.cookieString ?? ''}
                  onChange={(e) =>
                    onAuthConfigChange({ ...authConfig, cookieString: e.target.value })
                  }
                  placeholder={t('auth_cookies_placeholder')}
                  rows={3}
                  className="w-full rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle text-sm py-2 px-3 focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus transition-default resize-none font-mono"
                />
                <p className="text-[10px] text-muted">{t('auth_cookies_hint')}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Configuring sources (replaces saved drafts) */}
      {configuringSources.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wider">
            {t('saved_drafts')}
          </h3>
          <div className="space-y-1.5">
            {configuringSources.map((src) => {
              const srcUrl = (src.sourceConfig as { url?: string })?.url ?? '';
              const wizardStep = src.crawlConfig?.wizardStep ?? 'profiling';
              const sectionCount = src.crawlConfig?.sections?.length ?? 0;
              return (
                <div
                  key={src._id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onResumeSource?.(src._id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onResumeSource?.(src._id);
                    }
                  }}
                  className="group w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-default bg-background-subtle hover:bg-background-elevated hover:border-accent/40 transition-default text-left cursor-pointer"
                >
                  <FileText className="w-4 h-4 text-muted shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">
                        {srcUrl ? extractDomain(srcUrl) : src.name}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-background-muted text-muted font-medium">
                        {flowStateLabel(wizardStep)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-muted mt-0.5">
                      {sectionCount > 0 && (
                        <span>{t('draft_sections_count', { count: sectionCount.toString() })}</span>
                      )}
                      <span>{timeAgo(src.updatedAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="flex items-center gap-1 text-xs text-accent opacity-0 group-hover:opacity-100 transition-default">
                      <Play className="w-3 h-3" />
                      {t('draft_resume')}
                    </span>
                    <button
                      onClick={(e) => handleDeleteSource(src._id, e)}
                      className="p-1 text-muted hover:text-danger opacity-0 group-hover:opacity-100 rounded transition-default"
                      aria-label={t('draft_delete')}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* How it works collapsible */}
      <div className="rounded-xl border border-default bg-background-elevated">
        <button
          onClick={toggleExpanded}
          className="flex items-center justify-between w-full px-4 py-3 text-sm font-medium text-foreground hover:bg-background-muted rounded-xl transition-default"
          aria-expanded={expanded}
        >
          <span>{t('how_it_works')}</span>
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-muted" />
          ) : (
            <ChevronDown className="w-4 h-4 text-muted" />
          )}
        </button>
        {expanded && (
          <div className="px-4 pb-4">
            <p className="text-xs text-muted mb-3">{t('how_it_works_detail')}</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {steps.map((step) => (
                <div
                  key={step.label}
                  className="flex flex-col items-center gap-1.5 p-3 rounded-lg bg-background-muted text-center"
                >
                  <span className="text-accent">{step.icon}</span>
                  <span className="text-xs font-medium text-foreground">{step.label}</span>
                  <span className="text-[10px] text-muted">{step.desc}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
