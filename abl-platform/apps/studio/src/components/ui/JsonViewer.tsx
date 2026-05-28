/**
 * JsonViewer & CollapsibleSection
 *
 * Shared UI components extracted from DebugTabs.
 * JsonViewer: Expandable JSON tree with syntax coloring, per-node copy, and fullscreen modal.
 * CollapsibleSection: Togglable content block with chevron icon.
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, Copy, Check, Maximize2, X, Search, Link } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { maskForDisplay } from '../../utils/mask-sensitive-data';

function getFindShortcut(): string {
  if (typeof navigator === 'undefined') return 'Ctrl+F';
  return /Mac|iPhone|iPad/i.test(navigator.platform || '') ? '⌘F' : 'Ctrl+F';
}

const COPY_FLAG_DURATION_MS = 1500;

function useCopyFlag(): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  const flash = useCallback(() => {
    setCopied(true);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, COPY_FLAG_DURATION_MS);
  }, []);
  return [copied, flash];
}

// Caps recursion against pathological inputs (cyclic-looking structures, deeply
// nested traces). Real-world workflow execution data sits well under this bound.
const MAX_FILTER_DEPTH = 100;

export function filterJson(
  data: unknown,
  query: string,
  depth = 0,
): { result: unknown; matched: boolean } {
  if (!query) return { result: data, matched: true };
  const q = query.toLowerCase();

  if (depth >= MAX_FILTER_DEPTH) {
    return { result: data, matched: false };
  }

  if (data === null || data === undefined) {
    return { result: data, matched: false };
  }

  if (typeof data !== 'object') {
    const matched = String(data).toLowerCase().includes(q);
    return { result: data, matched };
  }

  if (Array.isArray(data)) {
    const kept = data
      .map((item) => filterJson(item, query, depth + 1))
      .filter((r) => r.matched)
      .map((r) => r.result);
    return { result: kept, matched: kept.length > 0 };
  }

  const filteredEntries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (key.toLowerCase().includes(q)) {
      // Key matches — keep entire subtree so context is preserved
      filteredEntries.push([key, value]);
    } else {
      const { result, matched } = filterJson(value, query, depth + 1);
      if (matched) filteredEntries.push([key, result]);
    }
  }

  return {
    result: Object.fromEntries(filteredEntries),
    matched: filteredEntries.length > 0,
  };
}

// ── FindWidget (floating, Monaco-style) ─────────────────────────────────────

interface FindWidgetProps {
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
}

function FindWidget({ value, onChange, onClose }: FindWidgetProps) {
  const t = useTranslations('common');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-default bg-background px-2 py-1">
      <Search className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder={t('find')}
        className="w-44 bg-transparent text-xs text-foreground placeholder:text-foreground-subtle focus:outline-none"
      />
      <button
        type="button"
        onClick={onClose}
        className="text-foreground-muted hover:text-foreground shrink-0"
        aria-label={t('close_find')}
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

// ── CollapsibleSection ──────────────────────────────────────────────────────

export interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  badge?: string | number;
}

export function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
  badge,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="overflow-hidden rounded-lg border border-default bg-background-muted shadow-sm">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-background-muted/70"
      >
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted" />
        )}
        <span className="text-xs font-medium text-muted">{title}</span>
        {badge !== undefined && (
          <span className="ml-auto rounded-full border border-default bg-background-elevated px-2 py-0.5 text-xs text-muted">
            {badge}
          </span>
        )}
      </button>
      {isOpen && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

// ── Fullscreen JSON Modal ────────────────────────────────────────────────────

function JsonFullscreenModal({ data, onClose }: { data: unknown; onClose: () => void }) {
  const t = useTranslations('common');
  const [copied, flashCopied] = useCopyFlag();
  const [findOpen, setFindOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleCopy = useCallback(() => {
    const text = JSON.stringify(data, null, 2);
    void navigator.clipboard
      ?.writeText(text)
      .then(flashCopied)
      .catch((err) => {
        console.warn('Clipboard write failed', err);
      });
  }, [data, flashCopied]);

  const closeFindWidget = useCallback(() => {
    setFindOpen(false);
    setSearchQuery('');
  }, []);

  // Focus the container on mount so keyboard events land here
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setFindOpen(true);
        return;
      }
      if (e.key === 'Escape') {
        if (findOpen) {
          closeFindWidget();
        } else {
          onClose();
        }
      }
    };
    // Must be on window to intercept Ctrl+F before the browser handles it
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, findOpen, closeFindWidget]);

  const { result: filteredData, matched } = useMemo(() => {
    const q = debouncedQuery.trim();
    if (!q) return { result: data, matched: true };
    return filterJson(data, q);
  }, [data, debouncedQuery]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onClick={onClose}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        className="relative flex h-[85vh] w-[90vw] flex-col rounded-xl border border-default bg-background-elevated shadow-xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-default bg-background-muted px-4 py-3">
          <span className="text-sm font-semibold text-foreground">{t('json_viewer_title')}</span>
          <div className="flex items-center gap-2">
            {/* Inline find widget — expands in the header when open */}
            {findOpen ? (
              <FindWidget value={searchQuery} onChange={setSearchQuery} onClose={closeFindWidget} />
            ) : (
              <button
                onClick={() => setFindOpen(true)}
                className="rounded p-1.5 text-muted transition-colors hover:bg-background-elevated hover:text-foreground"
                title={t('find_shortcut', { shortcut: getFindShortcut() })}
                aria-label={t('find')}
              >
                <Search className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={handleCopy}
              className="rounded p-1.5 text-muted transition-colors hover:bg-background-elevated hover:text-foreground"
              title={t('copy_json')}
              aria-label={t('copy_json')}
            >
              {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
            </button>
            <button
              onClick={onClose}
              className="rounded p-1.5 text-muted transition-colors hover:bg-background-elevated hover:text-foreground"
              title={t('close')}
              aria-label={t('close')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {debouncedQuery && !matched ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-foreground-muted">
              <Search className="w-6 h-6 opacity-40" />
              <span className="text-sm">{t('no_results_for', { query: debouncedQuery })}</span>
            </div>
          ) : (
            <JsonViewer data={filteredData} defaultExpanded={!!debouncedQuery} copyable />
          )}
        </div>
      </div>
    </div>
  );
}

// ── CopyButton (inline) ────────────────────────────────────────────────────

function InlineCopyButton({ path, value }: { path: string; value: unknown }) {
  const t = useTranslations('common');
  const [copiedValue, flashValue] = useCopyFlag();
  const [copiedPath, flashPath] = useCopyFlag();

  const copyText = useCallback((text: string, flash: () => void, e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard
      ?.writeText(text)
      .then(flash)
      .catch((err) => {
        console.warn('Clipboard write failed', err);
      });
  }, []);

  const displayValue =
    typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value));

  return (
    <span className="inline-flex items-center gap-0.5 opacity-0 transition-opacity group-hover/jsonnode:opacity-100">
      <button
        onClick={(e) => copyText(displayValue, flashValue, e)}
        className="rounded p-0.5 text-muted hover:text-foreground"
        title={t('copy_value')}
        aria-label={t('copy_value')}
      >
        {copiedValue ? (
          <Check className="w-2.5 h-2.5 text-success" />
        ) : (
          <Copy className="w-2.5 h-2.5" />
        )}
      </button>
      <button
        onClick={(e) => copyText(path, flashPath, e)}
        className="rounded p-0.5 text-muted hover:text-foreground"
        title={`${t('copy_path')}: ${path}`}
        aria-label={`${t('copy_path')}: ${path}`}
      >
        {copiedPath ? (
          <Check className="w-2.5 h-2.5 text-success" />
        ) : (
          <Link className="w-2.5 h-2.5" />
        )}
      </button>
    </span>
  );
}

// ── JsonViewer ──────────────────────────────────────────────────────────────

export interface JsonViewerProps {
  data: unknown;
  /** @deprecated Use defaultExpanded instead. Kept for backward compat. */
  maxDepth?: number;
  depth?: number;
  copyable?: boolean;
  /** @deprecated Use defaultExpanded instead */
  expandAll?: boolean;
  /** When true, redact sensitive data (PII, credentials) before rendering. */
  maskSensitive?: boolean;
  /** When true, all nodes start expanded. Default false (collapsed). */
  defaultExpanded?: boolean;
  /** JSON path prefix for this node — threaded through recursive calls to build copy paths. */
  path?: string;
}

export function JsonViewer({
  data: rawData,
  maxDepth,
  depth = 0,
  copyable = false,
  expandAll = false,
  maskSensitive = false,
  defaultExpanded = false,
  path = '',
}: JsonViewerProps) {
  const t = useTranslations('common');
  const startExpanded = defaultExpanded || expandAll;
  // Mask sensitive data once at the root level only
  const data = useMemo(
    () => (maskSensitive && depth === 0 ? maskForDisplay(rawData) : rawData),
    [rawData, maskSensitive, depth],
  );
  const [toggledKeys, setToggledKeys] = useState<Set<string>>(new Set());
  const [copied, flashCopied] = useCopyFlag();
  const [fullscreenData, setFullscreenData] = useState<unknown | null>(null);

  // `toggledKeys` records nodes the user explicitly flipped *away* from the
  // current default. Its meaning inverts when `defaultExpanded` changes —
  // e.g. clearing the modal's search query flips `defaultExpanded` from
  // true to false, which would otherwise make previously-expanded nodes
  // appear collapsed (and vice versa). Reset on default change.
  useEffect(() => {
    setToggledKeys(new Set());
  }, [startExpanded]);

  const toggleKey = (key: string) => {
    setToggledKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const isKeyExpanded = (keyPath: string) =>
    startExpanded ? !toggledKeys.has(keyPath) : toggledKeys.has(keyPath);

  const handleCopy = () => {
    const text = JSON.stringify(data, null, 2);
    void navigator.clipboard
      ?.writeText(text)
      .then(flashCopied)
      .catch((err) => {
        console.warn('Clipboard write failed', err);
      });
  };

  if (data === null) {
    return <span className="text-muted">null</span>;
  }

  if (typeof data === 'undefined') {
    return <span className="text-muted">undefined</span>;
  }

  if (typeof data === 'boolean') {
    return <span className="font-medium text-info">{data.toString()}</span>;
  }

  if (typeof data === 'number') {
    return <span className="font-medium text-warning">{data}</span>;
  }

  if (typeof data === 'string') {
    if (data.length > 200) {
      return <ExpandableString value={data} />;
    }
    return <span className="text-success truncate block">&quot;{data}&quot;</span>;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <span className="text-muted">[]</span>;
    }
    return (
      <div className="text-[12px] leading-6">
        <span className="text-foreground-muted">[</span>
        <div className="ml-1 border-l border-default pl-2">
          {data.slice(0, 50).map((item, i) => (
            <div key={i}>
              <JsonViewer
                data={item}
                depth={depth + 1}
                defaultExpanded={startExpanded}
                path={path ? `${path}[${i}]` : `[${i}]`}
              />
              {i < data.length - 1 && <span className="text-foreground-muted">,</span>}
            </div>
          ))}
          {data.length > 50 && (
            <div className="text-foreground-subtle">...{data.length - 50} more</div>
          )}
        </div>
        <span className="text-foreground-muted">]</span>
      </div>
    );
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return <span className="text-muted">{'{}'}</span>;
    }

    const wrapper = (
      <div className="text-[12px] leading-6">
        {entries.map(([key, value]) => {
          const isExpandable = typeof value === 'object' && value !== null;
          const keyPath = `${depth}-${key}`;
          const isExpanded = isKeyExpanded(keyPath);
          const nodePath = path ? `${path}.${key}` : key;

          return (
            <div key={key} className="group/jsonnode">
              <div className="flex items-start gap-1">
                {isExpandable ? (
                  <button
                    onClick={() => toggleKey(keyPath)}
                    className="mt-0.5 flex-shrink-0 rounded-md p-0.5 text-foreground-muted transition-colors hover:bg-background hover:text-foreground"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                  </button>
                ) : (
                  <span className="w-3 flex-shrink-0" />
                )}
                <span className="flex-shrink-0 font-medium text-info">{key}</span>
                <span className="flex-shrink-0 text-foreground-muted">:</span>
                {isExpandable && !isExpanded ? (
                  <span
                    className="cursor-pointer text-foreground-muted transition-colors hover:text-foreground"
                    onClick={() => toggleKey(keyPath)}
                  >
                    {Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`}
                  </span>
                ) : !isExpandable ? (
                  <span className="min-w-0 overflow-hidden">
                    <JsonViewer
                      data={value}
                      depth={depth + 1}
                      defaultExpanded={startExpanded}
                      path={nodePath}
                    />
                  </span>
                ) : null}
                {/* Copy value/path on hover — works for both expandable and leaf nodes */}
                <InlineCopyButton path={nodePath} value={value} />
              </div>
              {isExpandable && isExpanded && (
                <div className="ml-1.5 border-l border-default pl-3">
                  <JsonViewer
                    data={value}
                    depth={depth + 1}
                    defaultExpanded={startExpanded}
                    path={nodePath}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    );

    // Root level: show search + copy + expand buttons
    if (depth === 0 && copyable) {
      return (
        <div className="relative group">
          <div className="absolute right-0 top-0 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={() => setFullscreenData(data)}
              className="rounded border border-default bg-background-elevated p-1 text-muted transition-colors hover:text-foreground"
              title={t('expand_fullscreen')}
              aria-label={t('expand_fullscreen')}
            >
              <Maximize2 className="w-3 h-3" />
            </button>
            <button
              onClick={handleCopy}
              className="rounded border border-default bg-background-elevated p-1 text-muted transition-colors hover:text-foreground"
              title={t('copy_json')}
              aria-label={t('copy_json')}
            >
              {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>
          {wrapper}
          {fullscreenData !== null && (
            <JsonFullscreenModal data={fullscreenData} onClose={() => setFullscreenData(null)} />
          )}
        </div>
      );
    }

    return wrapper;
  }

  return <span className="text-foreground-muted">{String(data)}</span>;
}

// ── ExpandableString ──────────────────────────────────────────────────────

function ExpandableString({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <span className="text-success break-all">
      &quot;
      <span className="whitespace-pre-wrap break-all">
        {expanded ? value : `${value.slice(0, 200)}...`}
      </span>
      &quot;
      <button
        onClick={() => setExpanded(!expanded)}
        className="ml-1 text-xs font-medium text-info underline"
      >
        {expanded ? '[show less]' : '[show more]'}
      </button>
    </span>
  );
}
