'use client';

/**
 * PromptLibraryListPage
 *
 * Table of all prompt library items for the current project. Supports
 * search, status filter, pagination, and inline create dialog.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Library, X } from 'lucide-react';
import { toast } from 'sonner';
import { useProjectStore } from '../../store/project-store';
import { useNavigationStore } from '../../store/navigation-store';
import {
  fetchPrompts,
  createPrompt,
  type PromptLibraryItem,
  type PromptLibraryItemStatus,
} from '../../api/prompt-library';
import { sanitizeError } from '../../lib/sanitize-error';
import { Dialog } from '../ui/Dialog';
import { FilterSelect } from '../ui/FilterSelect';
import { ListPageShell } from '../ui/ListPageShell';
import { Button } from '../ui/Button';

const PAGE_SIZE = 50;

function StatusBadge({ status }: { status: PromptLibraryItemStatus }) {
  const t = useTranslations('prompt_library.detail');
  const label =
    status === 'active'
      ? t('version_status_active')
      : status === 'archived'
        ? t('version_status_archived')
        : t('version_status_draft');
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
        status === 'active'
          ? 'bg-status-success/10 text-status-success'
          : 'bg-background-muted text-foreground-muted'
      }`}
    >
      {label}
    </span>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex gap-4 px-4 py-3 border border-default rounded-lg animate-pulse"
        >
          <div className="h-4 w-48 bg-background-muted rounded" />
          <div className="h-4 w-24 bg-background-muted rounded" />
          <div className="h-4 w-12 bg-background-muted rounded ml-auto" />
          <div className="h-4 w-16 bg-background-muted rounded" />
        </div>
      ))}
    </div>
  );
}

interface CreateDialogProps {
  projectId: string;
  onCreated: (item: PromptLibraryItem) => void;
  onClose: () => void;
}

function CreateDialog({ projectId, onCreated, onClose }: CreateDialogProps) {
  const t = useTranslations('prompt_library.create_dialog');
  const tErrors = useTranslations('prompt_library.errors');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [template, setTemplate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);

  const commitTag = (value: string) => {
    const trimmed = value.trim().toLowerCase();
    if (trimmed && !tags.includes(trimmed)) {
      setTags((prev) => [...prev, trimmed]);
    }
    setTagInput('');
  };

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitTag(tagInput);
    } else if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
      setTags((prev) => prev.slice(0, -1));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !template.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const allTags = tagInput.trim()
        ? [...tags, tagInput.trim().toLowerCase()].filter((tag, i, arr) => arr.indexOf(tag) === i)
        : tags;
      const result = await createPrompt(projectId, {
        name: name.trim(),
        description: description.trim() || undefined,
        tags: allTags.length > 0 ? allTags : undefined,
        initialVersion: { template: template.trim(), variables: [] },
      });
      onCreated(result.item);
    } catch (err) {
      setError(sanitizeError(err, tErrors('create_failed')));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={t('title')} maxWidth="lg">
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            {t('name_label')} *
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('name_placeholder')}
            required
            maxLength={128}
            className="w-full rounded-lg border border-default bg-background-subtle px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            {t('description_label')}
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('description_placeholder')}
            maxLength={512}
            className="w-full rounded-lg border border-default bg-background-subtle px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            {t('tags_label')}
          </label>
          <div
            className="flex flex-wrap gap-1.5 min-h-[38px] w-full rounded-lg border border-default bg-background-subtle px-3 py-2 cursor-text focus-within:ring-2 focus-within:ring-accent/50 focus-within:border-accent"
            onClick={() => tagInputRef.current?.focus()}
          >
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs bg-accent/10 text-accent"
              >
                {tag}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setTags((prev) => prev.filter((t) => t !== tag));
                  }}
                  className="hover:text-accent/70"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            <input
              ref={tagInputRef}
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleTagKeyDown}
              onBlur={() => commitTag(tagInput)}
              placeholder={tags.length === 0 ? t('tags_placeholder') : ''}
              className="flex-1 min-w-[120px] bg-transparent text-sm text-foreground placeholder:text-foreground-muted outline-none"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">
            {t('template_label')} *
          </label>
          <textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder={t('template_placeholder')}
            required
            rows={6}
            className="w-full rounded-lg border border-default bg-background-subtle px-3 py-2 text-sm font-mono text-foreground placeholder:text-foreground-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent resize-y"
          />
        </div>
        {error && <p className="text-sm text-status-error">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-foreground-muted border border-default hover:bg-background-muted transition-colors"
          >
            {t('cancel')}
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim() || !template.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? '…' : t('submit')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function PromptLibraryListPage() {
  const t = useTranslations('prompt_library.list');
  const tErrors = useTranslations('prompt_library.errors');
  const currentProject = useProjectStore((s) => s.currentProject);
  const navigate = useNavigationStore((s) => s.navigate);

  const [items, setItems] = useState<PromptLibraryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<PromptLibraryItemStatus | 'all'>('all');
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(
    async (searchValue: string, status: typeof statusFilter) => {
      if (!currentProject?.id) return;
      setLoading(true);
      setError(null);
      try {
        const result = await fetchPrompts(currentProject.id, {
          search: searchValue || undefined,
          status: status === 'all' ? undefined : status,
          limit: PAGE_SIZE,
        });
        setItems(result.items);
        setTotal(result.total);
      } catch (err) {
        setError(sanitizeError(err, tErrors('load_failed')));
      } finally {
        setLoading(false);
      }
    },
    [currentProject?.id, tErrors],
  );

  useEffect(() => {
    void load('', 'all');
  }, [load]);

  useEffect(() => {
    const id = setTimeout(() => void load(search, statusFilter), 300);
    return () => clearTimeout(id);
  }, [search, statusFilter, load]);

  const handleCreated = (item: PromptLibraryItem) => {
    setShowCreate(false);
    toast.success(t('created_toast', { name: item.name }));
    void load(search, statusFilter);
    navigate(`/projects/${currentProject!.id}/prompt-library/${item._id}`);
  };

  const projectId = currentProject?.id;
  if (!projectId) return null;

  const isEmptyStateShown = !loading && !error && items.length === 0;

  return (
    <>
      <ListPageShell
        title={t('title')}
        description={
          total > 0
            ? t(total === 1 ? 'total_count_one' : 'total_count_other', { count: total })
            : undefined
        }
        hidePrimaryAction={isEmptyStateShown}
        primaryAction={
          <Button
            variant="primary"
            size="md"
            icon={<Plus className="h-4 w-4" />}
            onClick={() => setShowCreate(true)}
          >
            {t('new_prompt')}
          </Button>
        }
        searchPlaceholder={t('search_placeholder')}
        searchValue={search}
        onSearchChange={setSearch}
        filterBar={
          <FilterSelect
            options={[
              { value: 'all', label: t('filter_status_all') },
              { value: 'active', label: t('filter_status_active') },
              { value: 'archived', label: t('filter_status_archived') },
            ]}
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as typeof statusFilter)}
          />
        }
      >
        {error ? (
          <p className="text-sm text-status-error">{error}</p>
        ) : loading ? (
          <TableSkeleton />
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <Library className="h-10 w-10 text-foreground-muted" />
            <p className="text-base font-medium text-foreground">{t('empty_title')}</p>
            <p className="text-sm text-foreground-muted">{t('empty_description')}</p>
            <Button
              variant="primary"
              icon={<Plus className="h-4 w-4" />}
              onClick={() => setShowCreate(true)}
              className="mt-2"
            >
              {t('new_prompt')}
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-default overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-default bg-background-muted">
                  <th className="px-4 py-2.5 text-left font-medium text-foreground-muted">
                    {t('column_name')}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium text-foreground-muted">
                    {t('column_tags')}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium text-foreground-muted">
                    {t('column_usage_count')}
                  </th>
                  <th className="px-4 py-2.5 text-center font-medium text-foreground-muted">
                    {t('column_status')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item._id}
                    onClick={() => navigate(`/projects/${projectId}/prompt-library/${item._id}`)}
                    className="border-b border-default last:border-0 hover:bg-background-muted cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-foreground">{item.name}</p>
                      {item.description && (
                        <p className="text-xs text-foreground-muted truncate max-w-xs">
                          {item.description}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {item.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="rounded px-1.5 py-0.5 text-xs bg-background-muted text-foreground-muted"
                          >
                            {tag}
                          </span>
                        ))}
                        {item.tags.length > 3 && (
                          <span className="text-xs text-foreground-muted">
                            +{item.tags.length - 3}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-foreground-muted">
                      {item.usageCount}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <StatusBadge status={item.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ListPageShell>

      {showCreate && (
        <CreateDialog
          projectId={projectId}
          onCreated={handleCreated}
          onClose={() => setShowCreate(false)}
        />
      )}
    </>
  );
}
