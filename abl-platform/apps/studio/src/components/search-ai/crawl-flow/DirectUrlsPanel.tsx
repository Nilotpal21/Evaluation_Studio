'use client';

/**
 * DirectUrlsPanel — Paste URLs to crawl directly.
 *
 * Features:
 *   - One URL per line, parsed on change (debounced 300ms)
 *   - Auto-fix bare domains: `epson.com/page` → `https://epson.com/page`
 *   - Normalize: lowercase scheme+host, strip trailing slash
 *   - Domain enforcement: only same root domain (+ subdomains) accepted
 *   - Dedup on normalized URL
 *   - Cap at DIRECT_URLS_MAX (2,000) — keeps first N lines
 *   - Validation summary: valid, invalid, duplicate, dropped counts
 *   - Expandable invalid URLs list
 *   - Clear button, Configure button
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  Trash2,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertCircle,
  Zap,
  Settings,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { springs } from '@/lib/animation';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { DIRECT_URLS_MAX } from './types';

// ─── URL utilities ─────────────────────────────────────────────────

/** Extract root domain from hostname (e.g. "shop.epson.com" → "epson.com") */
function extractRootDomain(hostname: string): string {
  const parts = hostname.split('.');
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join('.');
}

/** Normalize a URL for dedup: lowercase scheme+host, strip trailing slash */
function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    // Strip trailing slash from pathname (unless it's just "/")
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return null;
  }
}

/** Try to parse a line as a URL, auto-fixing bare domains */
function parseLine(line: string, targetDomain: string): { normalized: string | null; raw: string } {
  const trimmed = line.trim();
  if (!trimmed) return { normalized: null, raw: trimmed };

  // Auto-fix: bare domains without scheme (e.g. "epson.com/page")
  let candidate = trimmed;
  if (!candidate.startsWith('http://') && !candidate.startsWith('https://')) {
    candidate = `https://${candidate}`;
  }

  const normalized = normalizeUrl(candidate);
  return { normalized, raw: trimmed };
}

interface ParseResult {
  valid: string[];
  invalid: string[];
  duplicateCount: number;
  droppedCount: number;
}

function parseUrls(text: string, domain: string): ParseResult {
  const lines = text.split('\n').filter((l) => l.trim());
  const rootDomain = extractRootDomain(domain.toLowerCase());

  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;
  let droppedCount = 0;

  for (const line of lines) {
    const { normalized, raw } = parseLine(line, domain);

    // Not parseable as URL
    if (!normalized) {
      if (raw) invalid.push(raw);
      continue;
    }

    // Domain enforcement: must match root domain (allows subdomains)
    try {
      const urlHost = new URL(normalized).hostname.toLowerCase();
      const urlRoot = extractRootDomain(urlHost);
      if (urlRoot !== rootDomain) {
        invalid.push(raw);
        continue;
      }
    } catch {
      invalid.push(raw);
      continue;
    }

    // Dedup
    if (seen.has(normalized)) {
      duplicateCount++;
      continue;
    }
    seen.add(normalized);

    // Cap enforcement
    if (valid.length >= DIRECT_URLS_MAX) {
      droppedCount++;
      continue;
    }

    valid.push(normalized);
  }

  return { valid, invalid, duplicateCount, droppedCount };
}

// ─── Component ─────────────────────────────────────────────────────

interface DirectUrlsPanelProps {
  /** Root domain from profile (e.g. "epson.com") */
  domain: string;
  /** Preserved text from previous visit to this panel */
  initialText?: string;
  /** Callback with validated, normalized URLs */
  onValidUrlsChange: (urls: string[]) => void;
  /** Callback with raw text (for state preservation across strategy switches) */
  onTextChange: (text: string) => void;
  /** Triggered when user clicks Settings (go to Configure page) */
  onConfigure: () => void;
  /** Triggered when user clicks "Crawl N URLs" (skip Configure, use defaults) */
  onDirectCrawl?: () => void;
  /** Disable all interactions */
  disabled?: boolean;
}

export function DirectUrlsPanel({
  domain,
  initialText = '',
  onValidUrlsChange,
  onTextChange,
  onDirectCrawl,
  onConfigure,
  disabled,
}: DirectUrlsPanelProps) {
  const t = useTranslations('search_ai.crawl_flow');
  const [text, setText] = useState(initialText);
  const [showInvalid, setShowInvalid] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  // Parse URLs on text change (debounced)
  const parseResult = useMemo(() => parseUrls(text, domain), [text, domain]);

  // Stable key for the valid URL set — triggers effect when content actually changes
  const validUrlsKey = useMemo(() => parseResult.valid.join('\n'), [parseResult.valid]);

  // Notify parent of valid URLs (debounced 300ms)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onValidUrlsChange(parseResult.valid);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- validUrlsKey tracks content changes
  }, [validUrlsKey, onValidUrlsChange]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newText = e.target.value;
      setText(newText);
      onTextChange(newText);
    },
    [onTextChange],
  );

  const handleClear = useCallback(() => {
    setText('');
    onTextChange('');
    onValidUrlsChange([]);
    setShowInvalid(false);
  }, [onTextChange, onValidUrlsChange]);

  const hasContent = text.trim().length > 0;
  const hasValid = parseResult.valid.length > 0;
  const hasInvalid = parseResult.invalid.length > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={springs.default}
      className="rounded-lg border border-default bg-background-subtle p-4 space-y-3"
    >
      {/* Label + helper */}
      <div>
        <p className="text-sm font-medium text-foreground">{t('direct_urls_label')}</p>
        <p className="text-xs text-muted mt-0.5">{t('direct_urls_helper', { domain })}</p>
      </div>

      {/* Textarea */}
      <Textarea
        value={text}
        onChange={handleChange}
        placeholder={t('direct_urls_placeholder', { domain })}
        rows={8}
        disabled={disabled}
        className="font-mono text-xs"
      />

      {/* Validation summary */}
      {hasContent && (
        <div className="flex flex-wrap items-center gap-2">
          {hasValid && (
            <Badge variant="success">
              <CheckCircle2 className="w-3 h-3" />
              {t('direct_urls_valid', {
                count: parseResult.valid.length.toString(),
                domain,
              })}
            </Badge>
          )}
          {hasInvalid && (
            <button
              type="button"
              onClick={() => setShowInvalid((prev) => !prev)}
              className="inline-flex items-center gap-1"
            >
              <Badge variant="error">
                <AlertCircle className="w-3 h-3" />
                {t('direct_urls_invalid', { count: parseResult.invalid.length.toString() })}
                {showInvalid ? (
                  <ChevronUp className="w-3 h-3" />
                ) : (
                  <ChevronDown className="w-3 h-3" />
                )}
              </Badge>
            </button>
          )}
          {parseResult.duplicateCount > 0 && (
            <Badge variant="warning">
              {t('direct_urls_duplicates', { count: parseResult.duplicateCount.toString() })}
            </Badge>
          )}
          {parseResult.droppedCount > 0 && (
            <Badge variant="error">
              {t('direct_urls_dropped', { count: parseResult.droppedCount.toString() })}
            </Badge>
          )}
          {!hasValid && <p className="text-xs text-muted italic">{t('direct_urls_no_valid')}</p>}
        </div>
      )}

      {/* Expandable invalid URLs list */}
      {showInvalid && hasInvalid && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          transition={springs.default}
          className="rounded border border-error/20 bg-error/5 p-3 max-h-40 overflow-y-auto"
        >
          <ul className="space-y-0.5">
            {parseResult.invalid.map((url, i) => (
              <li key={i} className="text-xs text-error font-mono truncate">
                {url}
              </li>
            ))}
          </ul>
        </motion.div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <Button onClick={onDirectCrawl ?? onConfigure} disabled={!hasValid || disabled}>
          <Zap className="w-4 h-4 mr-1.5" />
          {hasValid
            ? t('crawl_direct_button', { pages: parseResult.valid.length.toLocaleString() })
            : t('direct_urls_configure')}
        </Button>
        <Button variant="secondary" onClick={onConfigure} disabled={!hasValid || disabled}>
          <Settings className="w-4 h-4 mr-1.5" />
          {t('crawl_settings_button')}
        </Button>
        {hasContent && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClear}
            disabled={disabled}
            icon={<Trash2 className="w-3.5 h-3.5" />}
          >
            {t('direct_urls_clear')}
          </Button>
        )}
      </div>
    </motion.div>
  );
}
