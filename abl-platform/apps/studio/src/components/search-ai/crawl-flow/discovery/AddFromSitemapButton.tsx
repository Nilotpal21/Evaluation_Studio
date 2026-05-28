'use client';

/**
 * AddFromSitemapButton — dialog for previewing and merging sitemap URLs into
 * the discovery tree.
 *
 * Shows URL count, top-level path groups, exclusion info, and overlap count.
 * On confirm, merges sitemap nodes into the tree via mergeSitemapUrlsIntoTree.
 */

import { useState, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { FileText } from 'lucide-react';
import { Dialog } from '../../../ui/Dialog';
import { Button } from '../../../ui/Button';
import { Badge } from '../../../ui/Badge';
import type { UnifiedTreeNode } from './unified-tree-types';
import {
  previewSitemapMerge,
  mergeSitemapUrlsIntoTree,
  matchesExclusionPattern,
  EXCLUSION_PATTERNS,
  type SitemapMergePreview,
} from './sitemap-merge';

interface AddFromSitemapButtonProps {
  primaryUrl: string;
  tree: UnifiedTreeNode[];
  onTreeChange: (tree: UnifiedTreeNode[]) => void;
  sitemapUrls: string[];
  isDiscovering?: boolean;
}

export function AddFromSitemapButton({
  primaryUrl,
  tree,
  onTreeChange,
  sitemapUrls,
  isDiscovering,
}: AddFromSitemapButtonProps) {
  const t = useTranslations('search_ai.crawl_flow');
  const [open, setOpen] = useState(false);
  const [excludedPatterns, setExcludedPatterns] = useState<Set<number>>(
    () => new Set(EXCLUSION_PATTERNS.map((_, i) => i)),
  );

  const preview: SitemapMergePreview | null = useMemo(() => {
    if (!open || sitemapUrls.length === 0) return null;
    return previewSitemapMerge(tree, sitemapUrls);
  }, [open, tree, sitemapUrls]);

  const handleToggleExclusion = useCallback((index: number) => {
    setExcludedPatterns((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    // Filter sitemap URLs based on toggled exclusion patterns
    const activePatterns = EXCLUSION_PATTERNS.filter((_, i) => excludedPatterns.has(i));
    const filteredUrls = sitemapUrls.filter((url) => {
      try {
        const pathname = new URL(url).pathname;
        return !activePatterns.some((p) => p.test(pathname));
      } catch {
        return true;
      }
    });

    let baseUrl: string;
    try {
      const parsed = new URL(primaryUrl);
      baseUrl = parsed.origin;
    } catch {
      baseUrl = primaryUrl;
    }

    const newTree = mergeSitemapUrlsIntoTree(tree, filteredUrls, baseUrl);
    onTreeChange(newTree);
    setOpen(false);
  }, [sitemapUrls, excludedPatterns, tree, primaryUrl, onTreeChange]);

  const handleOpen = useCallback(() => {
    // Reset exclusion toggles to default (all active)
    setExcludedPatterns(new Set(EXCLUSION_PATTERNS.map((_, i) => i)));
    setOpen(true);
  }, []);

  // Describe each exclusion pattern with a human-readable label
  const exclusionLabels = useMemo(
    () => [
      'login / signup',
      'cart / checkout',
      'api',
      'admin / dashboard',
      'account / settings',
      'search / results',
    ],
    [],
  );

  if (sitemapUrls.length === 0) return null;

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        icon={<FileText className="w-3.5 h-3.5" />}
        disabled={isDiscovering}
        onClick={handleOpen}
      >
        {t('sitemap_add_button')}
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('sitemap_dialog_title')}
        maxWidth="md"
      >
        <div className="space-y-4">
          {/* Summary stats */}
          {preview && (
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg bg-background-subtle px-3 py-2 text-center">
                <div className="text-lg font-semibold text-foreground">
                  {preview.totalSitemapUrls}
                </div>
                <div className="text-xs text-muted">{t('sitemap_total_urls')}</div>
              </div>
              <div className="rounded-lg bg-background-subtle px-3 py-2 text-center">
                <div className="text-lg font-semibold text-success">{preview.newUrls}</div>
                <div className="text-xs text-muted">{t('sitemap_new_urls')}</div>
              </div>
              <div className="rounded-lg bg-background-subtle px-3 py-2 text-center">
                <div className="text-lg font-semibold text-muted">{preview.overlapUrls}</div>
                <div className="text-xs text-muted">{t('sitemap_overlap_urls')}</div>
              </div>
            </div>
          )}

          {/* Path groups */}
          {preview && preview.pathGroups.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted mb-2">{t('sitemap_path_groups')}</h4>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {preview.pathGroups.slice(0, 15).map((group) => (
                  <div
                    key={group.path}
                    className="flex items-center justify-between text-xs px-2 py-1 rounded bg-background-subtle"
                  >
                    <span className="font-mono text-foreground">{group.path}</span>
                    <Badge variant="default" appearance="outlined">
                      {String(group.count)}
                    </Badge>
                  </div>
                ))}
                {preview.pathGroups.length > 15 && (
                  <div className="text-xs text-muted px-2">
                    +{preview.pathGroups.length - 15} {t('more')}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Exclusion toggles */}
          <div>
            <h4 className="text-xs font-medium text-muted mb-2">{t('sitemap_exclusions')}</h4>
            <div className="space-y-1.5">
              {EXCLUSION_PATTERNS.map((_, i) => (
                <label key={i} className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={excludedPatterns.has(i)}
                    onChange={() => handleToggleExclusion(i)}
                    className="rounded"
                  />
                  <span className="text-foreground">
                    {t('sitemap_exclude_label', {
                      pattern: exclusionLabels[i] ?? `Pattern ${i + 1}`,
                    })}
                  </span>
                </label>
              ))}
            </div>
            {preview && preview.excludedUrls > 0 && (
              <p className="text-xs text-muted mt-1.5">
                {t('sitemap_excluded_count', {
                  count: String(preview.excludedUrls),
                })}
              </p>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-default">
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              size="sm"
              onClick={handleConfirm}
              disabled={preview !== null && preview.newUrls === 0}
            >
              {t('sitemap_confirm_merge', {
                count: String(preview?.newUrls ?? 0),
              })}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
