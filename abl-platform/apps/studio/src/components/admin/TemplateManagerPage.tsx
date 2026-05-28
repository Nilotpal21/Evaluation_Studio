/**
 * TemplateManagerPage Component
 *
 * Workspace-level admin page for managing templates in the template store.
 * Displays a table of templates with upload, edit, and archive actions.
 */

import { useState, useRef, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import {
  Upload,
  Loader2,
  LayoutTemplate,
  Pencil,
  Archive,
  Download,
  CheckCircle2,
  AlertTriangle,
  X,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { apiFetch } from '../../lib/api-client';
import { sanitizeError } from '../../lib/sanitize-error';
import { useAuthStore } from '../../store/auth-store';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { TemplateUploadDialog } from './TemplateUploadDialog';
import { TemplateEditDialog } from './TemplateEditDialog';

// =============================================================================
// TYPES
// =============================================================================

interface Template {
  id: string;
  slug: string;
  name: string;
  type: string;
  category: string;
  status: string;
  installCount: number;
  downloads: number;
  createdAt: string;
  version: string;
  shortDescription?: string;
  longDescription?: string;
  tags?: string[];
  complexity?: string;
}

type SortKey = 'name' | 'installCount' | 'createdAt';
type SortDirection = 'asc' | 'desc';

// =============================================================================
// CONSTANTS
// =============================================================================

const STATUS_BADGE_VARIANT: Record<string, BadgeVariant> = {
  published: 'success',
  draft: 'default',
  archived: 'warning',
  review: 'info',
};

const PAGE_SIZE = 25;
const DEFAULT_TEMPLATE_VERSION = '1.0.0';
const DEFAULT_CREATED_AT = '1970-01-01T00:00:00.000Z';

function getStringField(record: Record<string, unknown>, key: string, fallback = ''): string {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function getNumberField(record: Record<string, unknown>, key: string, fallback = 0): number {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function normalizeTemplate(record: Record<string, unknown>): Template {
  const id = getStringField(record, '_id', getStringField(record, 'id'));
  const installCount = getNumberField(record, 'installCount', getNumberField(record, 'downloads'));
  return {
    id,
    slug: getStringField(record, 'slug', id),
    name: getStringField(record, 'name', 'Untitled Template'),
    type: getStringField(record, 'type', 'project'),
    category: getStringField(record, 'category', 'general'),
    status: getStringField(record, 'status', 'published'),
    installCount,
    downloads: installCount,
    createdAt: getStringField(record, 'createdAt', DEFAULT_CREATED_AT),
    version: getStringField(record, 'version', DEFAULT_TEMPLATE_VERSION),
    shortDescription: getStringField(record, 'shortDescription'),
    longDescription: getStringField(record, 'longDescription'),
    tags: Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === 'string')
      : [],
    complexity: getStringField(record, 'complexity', 'standard'),
  };
}

function capitalize(value: string): string {
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function compareTemplates(a: Template, b: Template, key: SortKey): number {
  if (key === 'installCount') return a.installCount - b.installCount;
  if (key === 'createdAt') return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  return a.name.localeCompare(b.name);
}

function formatRelativeTime(dateStr: string): string {
  const timestamp = new Date(dateStr).getTime();
  if (!Number.isFinite(timestamp)) return dateStr || '-';

  const diffSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  if (absSeconds < 60) return 'just now';
  if (absSeconds < 3600) return formatter.format(Math.round(diffSeconds / 60), 'minute');
  if (absSeconds < 86400) return formatter.format(Math.round(diffSeconds / 3600), 'hour');
  if (absSeconds < 2592000) return formatter.format(Math.round(diffSeconds / 86400), 'day');
  if (absSeconds < 31536000) return formatter.format(Math.round(diffSeconds / 2592000), 'month');
  return formatter.format(Math.round(diffSeconds / 31536000), 'year');
}

function formatFileName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'template'
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function TemplateManagerPage() {
  const t = useTranslations('admin');
  const tenantId = useAuthStore((s) => s.tenantId);
  const [showUpload, setShowUpload] = useState(false);
  const [editTarget, setEditTarget] = useState<Template | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Template | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [page, setPage] = useState(1);

  // Fetch tenant-scoped templates via template-store proxy
  const {
    data: templatesData,
    error: fetchError,
    isLoading,
    mutate,
  } = useSWR<{ templates: Template[] }>(
    tenantId ? '/api/template-store/admin/templates' : null,
    async (url: string) => {
      const res = await apiFetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message ?? body.error ?? 'Failed to load templates');
      }
      const body = await res.json();
      // Unwrap the { success, data: { templates, ... } } envelope
      const payload = (body.data ?? body) as Record<string, unknown>;
      const templatesValue = payload.templates;
      const rawTemplates: unknown[] = Array.isArray(templatesValue) ? templatesValue : [];
      const normalized = rawTemplates
        .filter(
          (template): template is Record<string, unknown> =>
            template !== null && typeof template === 'object',
        )
        .map(normalizeTemplate);
      return { templates: normalized };
    },
  );

  const templates = templatesData?.templates ?? [];
  const sortedTemplates = useMemo(() => {
    const direction = sortDirection === 'asc' ? 1 : -1;
    return [...templates].sort((a, b) => compareTemplates(a, b, sortKey) * direction);
  }, [templates, sortDirection, sortKey]);

  const totalPages = Math.max(1, Math.ceil(sortedTemplates.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visibleTemplates = sortedTemplates.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const firstVisible = sortedTemplates.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const lastVisible = Math.min(safePage * PAGE_SIZE, sortedTemplates.length);

  const handleSort = (key: SortKey) => {
    setSortKey((currentKey) => {
      if (currentKey !== key) {
        setSortDirection('asc');
        return key;
      }
      setSortDirection((currentDirection) => (currentDirection === 'asc' ? 'desc' : 'asc'));
      return currentKey;
    });
    setPage(1);
  };

  // Auto-dismiss success message
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showSuccess = useCallback(
    (msg: string) => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      setSuccessMessage(msg);
      successTimerRef.current = setTimeout(() => setSuccessMessage(null), 4000);
    },
    [setSuccessMessage],
  );

  // ---------------------------------------------------------------------------
  // ARCHIVE HANDLER
  // ---------------------------------------------------------------------------

  const handleArchive = async (template: Template) => {
    setActionLoading(`archive-${template.id}`);
    setError(null);
    setArchiveTarget(null);

    try {
      const res = await apiFetch(`/api/template-store/admin/templates/${template.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message ?? body.error ?? 'Failed to archive template');
      }

      showSuccess(t('template_manager.success'));
      await mutate();
    } catch (err) {
      setError(sanitizeError(err, 'Failed to archive template'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleDownload = async (template: Template) => {
    setActionLoading(`download-${template.id}`);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (tenantId) params.set('tenantId', tenantId);
      const query = params.toString();
      const res = await apiFetch(
        `/api/template-store/marketplace/templates/${encodeURIComponent(
          template.slug,
        )}/versions/${encodeURIComponent(template.version)}/bundle${query ? `?${query}` : ''}`,
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message ?? body.error ?? 'Failed to download template bundle');
      }

      const body = await res.json();
      const payload = body.data ?? body;
      const files = payload.files;
      if (!files || typeof files !== 'object' || Array.isArray(files)) {
        throw new Error('Template bundle response has unexpected format');
      }

      const { strToU8, zipSync } = await import('fflate');
      const zipFiles: Record<string, Uint8Array> = {};
      for (const [path, content] of Object.entries(files as Record<string, unknown>)) {
        if (typeof content === 'string') {
          zipFiles[path] = strToU8(content);
        }
      }

      if (Object.keys(zipFiles).length === 0) {
        throw new Error('Template bundle is empty');
      }

      const zipped = zipSync(zipFiles, { level: 6 });
      const zipBuffer = new ArrayBuffer(zipped.byteLength);
      new Uint8Array(zipBuffer).set(zipped);
      const blob = new Blob([zipBuffer], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${formatFileName(template.name)}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(sanitizeError(err, 'Failed to download template bundle'));
    } finally {
      setActionLoading(null);
    }
  };

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  const displayError =
    error ?? (fetchError ? sanitizeError(fetchError, 'Failed to load templates') : null);
  const canPrevious = safePage > 1;
  const canNext = safePage < totalPages;

  const renderSortHeader = (key: SortKey, label: string, align: 'left' | 'right' = 'left') => (
    <button
      type="button"
      onClick={() => handleSort(key)}
      className={`inline-flex items-center gap-1 text-xs font-semibold uppercase text-muted transition-default hover:text-foreground ${
        align === 'right' ? 'justify-end' : 'justify-start'
      }`}
    >
      <span>{label}</span>
      <ChevronsUpDown className="h-3.5 w-3.5 text-subtle" />
    </button>
  );

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------

  return (
    <div className="flex-1 overflow-auto bg-noise">
      <div className="w-full px-6 py-8 space-y-6">
        {/* Page header */}
        <PageHeader
          title={t('template_manager.title')}
          description={t('template_manager.description')}
          actions={
            <Button
              variant="primary"
              size="sm"
              icon={<Upload className="w-3.5 h-3.5" />}
              onClick={() => setShowUpload(true)}
            >
              {t('template_manager.upload')}
            </Button>
          }
        />

        {/* Error banner */}
        {displayError && (
          <div className="rounded-xl border border-error bg-error-subtle px-4 py-3 text-sm text-error flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{displayError}</span>
            </div>
            <button
              onClick={() => setError(null)}
              className="text-error hover:opacity-70 transition-default text-xs font-medium ml-4 shrink-0"
              aria-label={t('template_manager.dismissError')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Success banner */}
        {successMessage && (
          <div className="rounded-xl border border-success bg-success-subtle px-4 py-3 text-sm text-success flex items-center gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span>{successMessage}</span>
          </div>
        )}

        {/* Loading state */}
        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-5 h-5 text-muted animate-spin" />
          </div>
        )}

        {/* Templates table */}
        {!isLoading && (
          <div className="rounded-lg border border-default bg-background-elevated overflow-hidden">
            {templates.length === 0 ? (
              <EmptyState
                icon={<LayoutTemplate className="w-6 h-6" />}
                title={t('template_manager.noTemplates')}
                description={t('template_manager.noTemplatesDescription')}
                action={
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Upload className="w-3.5 h-3.5" />}
                    onClick={() => setShowUpload(true)}
                  >
                    {t('template_manager.upload')}
                  </Button>
                }
              />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="min-w-[1040px] w-full table-fixed">
                    <colgroup>
                      <col className="w-[40%]" />
                      <col className="w-[9%]" />
                      <col className="w-[12%]" />
                      <col className="w-[11%]" />
                      <col className="w-[8%]" />
                      <col className="w-[12%]" />
                      <col className="w-[8%]" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-default bg-background-subtle/30">
                        <th className="px-5 py-4 text-left">
                          {renderSortHeader('name', t('template_manager.name'))}
                        </th>
                        <th className="px-5 py-4 text-left">
                          <span className="text-xs font-semibold uppercase text-muted">
                            {t('template_manager.type')}
                          </span>
                        </th>
                        <th className="px-5 py-4 text-left">
                          <span className="text-xs font-semibold uppercase text-muted">
                            {t('template_manager.category')}
                          </span>
                        </th>
                        <th className="px-5 py-4 text-left">
                          <span className="text-xs font-semibold uppercase text-muted">
                            {t('template_manager.status')}
                          </span>
                        </th>
                        <th className="px-5 py-4 text-left">
                          {renderSortHeader('installCount', t('template_manager.installs'))}
                        </th>
                        <th className="px-5 py-4 text-left">
                          {renderSortHeader('createdAt', t('template_manager.created'))}
                        </th>
                        <th className="px-5 py-4 text-right">
                          <span className="sr-only">{t('template_manager.actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTemplates.map((template) => (
                        <tr
                          key={template.id}
                          className="border-b border-default last:border-b-0 transition-default hover:bg-background-muted"
                        >
                          <td className="px-5 py-4">
                            <div className="min-w-0 pr-4">
                              <p className="truncate text-sm font-medium text-foreground">
                                {template.name}
                              </p>
                              {template.shortDescription && (
                                <p className="mt-0.5 truncate text-xs text-muted">
                                  {template.shortDescription}
                                </p>
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-4 text-sm text-foreground">
                            {capitalize(template.type)}
                          </td>
                          <td className="px-5 py-4 text-sm text-foreground">
                            {capitalize(template.category)}
                          </td>
                          <td className="px-5 py-4">
                            <Badge
                              variant={STATUS_BADGE_VARIANT[template.status] ?? 'default'}
                              appearance="outlined"
                              dot
                            >
                              {capitalize(template.status)}
                            </Badge>
                          </td>
                          <td className="px-5 py-4 text-sm text-muted">
                            {template.installCount.toLocaleString()}
                          </td>
                          <td className="px-5 py-4 text-sm text-muted">
                            <span title={new Date(template.createdAt).toLocaleString()}>
                              {formatRelativeTime(template.createdAt)}
                            </span>
                          </td>
                          <td className="px-5 py-4">
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setEditTarget(template)}
                                className="rounded-md p-1.5 text-muted transition-default hover:bg-background-muted hover:text-foreground focus-ring"
                                title={t('template_manager.edit')}
                                aria-label={t('template_manager.edit')}
                                disabled={!!actionLoading}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDownload(template)}
                                className="rounded-md p-1.5 text-muted transition-default hover:bg-background-muted hover:text-foreground focus-ring disabled:opacity-50"
                                title={t('template_manager.downloadBundle')}
                                aria-label={t('template_manager.downloadBundle')}
                                disabled={!!actionLoading}
                              >
                                {actionLoading === `download-${template.id}` ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Download className="h-3.5 w-3.5" />
                                )}
                              </button>
                              <button
                                type="button"
                                onClick={() => setArchiveTarget(template)}
                                className="rounded-md p-1.5 text-muted transition-default hover:bg-error/10 hover:text-error focus-ring disabled:opacity-50"
                                title={t('template_manager.archive')}
                                aria-label={t('template_manager.archive')}
                                disabled={!!actionLoading || template.status === 'archived'}
                              >
                                {actionLoading === `archive-${template.id}` ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Archive className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-col gap-3 border-t border-default px-5 py-4 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
                  <span>
                    Showing {firstVisible}-{lastVisible} of {sortedTemplates.length}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => canPrevious && setPage((current) => current - 1)}
                      disabled={!canPrevious}
                      className="inline-flex items-center gap-1 rounded-lg border border-default px-3 py-1.5 transition-default hover:bg-background-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <ChevronLeft className="h-4 w-4" />
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={() => canNext && setPage((current) => current + 1)}
                      disabled={!canNext}
                      className="inline-flex items-center gap-1 rounded-lg border border-default px-3 py-1.5 transition-default hover:bg-background-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Upload dialog */}
      {showUpload && (
        <TemplateUploadDialog
          open={showUpload}
          onClose={() => setShowUpload(false)}
          onSuccess={() => {
            setShowUpload(false);
            showSuccess(t('template_manager.success'));
            void mutate();
          }}
        />
      )}

      {/* Edit dialog */}
      {editTarget && (
        <TemplateEditDialog
          open={!!editTarget}
          onClose={() => setEditTarget(null)}
          onSuccess={() => {
            setEditTarget(null);
            showSuccess(t('template_manager.editSuccess'));
            void mutate();
          }}
          template={editTarget}
        />
      )}

      {/* Archive confirmation */}
      {archiveTarget && (
        <ConfirmDialog
          open={!!archiveTarget}
          onClose={() => setArchiveTarget(null)}
          onConfirm={() => handleArchive(archiveTarget)}
          title={t('template_manager.archiveConfirm')}
          description={t('template_manager.archiveConfirmDescription')}
          confirmLabel={t('template_manager.archive')}
          variant="danger"
          loading={actionLoading === `archive-${archiveTarget.id}`}
        />
      )}
    </div>
  );
}
