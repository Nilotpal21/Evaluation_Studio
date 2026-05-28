/**
 * URL Preview Dialog
 *
 * Shows discovered URLs from sitemap with selection controls.
 * Allows users to preview and deselect URLs before crawling.
 */

import { useState, useMemo, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { Search } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Checkbox } from '@/components/ui/Checkbox';
import { Skeleton } from '@/components/ui/Skeleton';
import { Alert } from '@/components/ui/Alert';
import { previewUrls } from '@/api/crawl';

interface UrlPreviewDialogProps {
  open: boolean;
  onClose: () => void;
  url: string;
  onConfirm: (selectedUrls: string[]) => void;
}

export function UrlPreviewDialog({ open, onClose, url, onConfirm }: UrlPreviewDialogProps) {
  const t = useTranslations('search_ai.url_preview');
  const [searchQuery, setSearchQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initialized, setInitialized] = useState(false);

  const { data, isLoading, error } = useSWR(open && url ? ['preview-urls', url] : null, () =>
    previewUrls(url),
  );

  // Initialize all URLs as selected when data arrives
  useEffect(() => {
    if (data?.urls && !initialized) {
      setSelected(new Set(data.urls.map((u) => u.url)));
      setInitialized(true);
    }
  }, [data, initialized]);

  // Reset state when dialog closes
  const handleClose = () => {
    setSearchQuery('');
    setInitialized(false);
    setSelected(new Set());
    onClose();
  };

  // Filter URLs by search query
  const filteredUrls = useMemo(() => {
    if (!data?.urls) return [];
    if (!searchQuery) return data.urls;
    const q = searchQuery.toLowerCase();
    return data.urls.filter((u) => u.url.toLowerCase().includes(q));
  }, [data?.urls, searchQuery]);

  const toggleUrl = (urlStr: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(urlStr)) next.delete(urlStr);
      else next.add(urlStr);
      return next;
    });
  };

  const selectAll = () => {
    if (!data?.urls) return;
    setSelected(new Set(data.urls.map((u) => u.url)));
  };

  const deselectAll = () => setSelected(new Set());

  const handleConfirm = () => {
    onConfirm(Array.from(selected));
    handleClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} title={t('title')} maxWidth="lg">
      <div className="space-y-4">
        {/* Source info */}
        {data && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted">
              {t('found_urls', { total: data.total })} <Badge variant="info">{data.source}</Badge>
            </p>
            <Badge variant="accent">
              {t('selected_of_total', { selected: selected.size, total: data.total })}
            </Badge>
          </div>
        )}

        {/* Search */}
        <Input
          placeholder={t('search_placeholder')}
          icon={<Search className="w-4 h-4" />}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />

        {/* Select/deselect buttons */}
        <div className="flex gap-2">
          <Button variant="ghost" size="xs" type="button" onClick={selectAll}>
            {t('select_all')}
          </Button>
          <Button variant="ghost" size="xs" type="button" onClick={deselectAll}>
            {t('deselect_all')}
          </Button>
        </div>

        {/* URL list */}
        <div className="max-h-80 overflow-y-auto border border-default rounded-lg divide-y divide-border">
          {isLoading && (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          )}

          {error && (
            <Alert variant="error" className="m-2">
              {error instanceof Error ? error.message : t('load_failed')}
            </Alert>
          )}

          {filteredUrls.map((entry) => (
            <div
              key={entry.url}
              className="flex items-center gap-3 px-3 py-2 hover:bg-background-muted cursor-pointer"
              onClick={() => toggleUrl(entry.url)}
            >
              <Checkbox checked={selected.has(entry.url)} onChange={() => toggleUrl(entry.url)} />
              <span className="text-sm text-foreground truncate font-mono">{entry.url}</span>
            </div>
          ))}

          {!isLoading && filteredUrls.length === 0 && (
            <p className="p-4 text-sm text-muted text-center">{t('no_urls_found')}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={handleClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            type="button"
            onClick={handleConfirm}
            disabled={selected.size === 0}
          >
            {t('use_urls', { count: selected.size })}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
