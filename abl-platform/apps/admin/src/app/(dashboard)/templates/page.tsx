'use client';

import { useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { LayoutTemplate, RefreshCw, Download, Archive, Pencil, Upload } from 'lucide-react';
import { useApi } from '../../../hooks/use-swr-fetch';
import {
  PageHeader,
  DataTable,
  StatusBadge,
  SkeletonTable,
  EmptyState,
  ConfirmDialog,
  relativeTime,
  type Column,
  type StatusBadgeVariant,
} from '@agent-platform/admin-ui';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Template {
  id: string;
  name: string;
  shortDescription: string;
  type: string;
  category: string;
  status: string;
  complexity: string;
  installCount: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface TemplatesResponse {
  success: boolean;
  data: {
    templates: Template[];
    total: number;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toStatusVariant(status: string): StatusBadgeVariant {
  switch (status) {
    case 'published':
      return 'active';
    case 'draft':
      return 'unknown';
    case 'archived':
      return 'archived';
    default:
      return 'unknown';
  }
}

function capitalize(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TemplatesManagerPage() {
  const router = useRouter();
  const [archiveTarget, setArchiveTarget] = useState<Template | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, loading, error, refetch } = useApi<TemplatesResponse>('/api/templates');

  const templates = useMemo(() => data?.data?.templates ?? [], [data]);

  const handleArchive = useCallback(async () => {
    if (!archiveTarget) return;
    setArchiving(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/templates/${archiveTarget.id}`, {
        method: 'DELETE',
      });
      const result = await res.json();
      if (res.ok && result.success) {
        refetch();
      } else {
        const rawError = result.error;
        const errorMsg =
          typeof rawError === 'string'
            ? rawError
            : rawError && typeof rawError === 'object' && 'message' in rawError
              ? String(rawError.message)
              : `Archive failed with status ${res.status}`;
        setActionError(errorMsg);
      }
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to connect to server');
    } finally {
      setArchiving(false);
      setArchiveTarget(null);
    }
  }, [archiveTarget, refetch]);

  const handleDownload = useCallback(async (templateId: string, templateName: string) => {
    try {
      const res = await fetch(`/api/templates/${templateId}?download=true`);
      if (!res.ok) {
        setActionError('Failed to download template bundle');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${templateName.toLowerCase().replace(/\s+/g, '-')}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Download failed');
    }
  }, []);

  const columns: Column<Template>[] = useMemo(
    () => [
      {
        key: 'name',
        header: 'Name',
        render: (row) => (
          <div>
            <div className="font-medium text-foreground">{row.name}</div>
            <div className="text-xs text-foreground-muted truncate max-w-[300px]">
              {row.shortDescription}
            </div>
          </div>
        ),
        sortable: true,
        sortFn: (a, b) => a.name.localeCompare(b.name),
      },
      {
        key: 'type',
        header: 'Type',
        render: (row) => <span className="text-foreground">{capitalize(row.type)}</span>,
        width: '100px',
      },
      {
        key: 'category',
        header: 'Category',
        render: (row) => <span className="text-foreground">{capitalize(row.category)}</span>,
        width: '140px',
      },
      {
        key: 'status',
        header: 'Status',
        render: (row) => (
          <StatusBadge status={toStatusVariant(row.status)} label={capitalize(row.status)} />
        ),
        width: '120px',
      },
      {
        key: 'installCount',
        header: 'Installs',
        render: (row) => (
          <span className="text-foreground-muted">{row.installCount.toLocaleString()}</span>
        ),
        sortable: true,
        sortFn: (a, b) => a.installCount - b.installCount,
        width: '100px',
      },
      {
        key: 'createdAt',
        header: 'Created',
        render: (row) => (
          <span className="text-foreground-muted" title={new Date(row.createdAt).toLocaleString()}>
            {relativeTime(row.createdAt)}
          </span>
        ),
        sortable: true,
        sortFn: (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        width: '120px',
      },
      {
        key: 'actions',
        header: '',
        render: (row) => (
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                router.push(`/templates/${row.id}`);
              }}
              className="rounded-md p-1.5 text-foreground-muted hover:text-foreground hover:bg-background-muted transition-colors"
              title="Edit"
            >
              <Pencil size={14} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleDownload(row.id, row.name);
              }}
              className="rounded-md p-1.5 text-foreground-muted hover:text-foreground hover:bg-background-muted transition-colors"
              title="Download Bundle"
            >
              <Download size={14} />
            </button>
            {row.status !== 'archived' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setArchiveTarget(row);
                }}
                className="rounded-md p-1.5 text-foreground-muted hover:text-error hover:bg-error/10 transition-colors"
                title="Archive"
              >
                <Archive size={14} />
              </button>
            )}
          </div>
        ),
        width: '120px',
      },
    ],
    [router, handleDownload],
  );

  if (loading && !data) {
    return (
      <div>
        <PageHeader
          title="Templates Manager"
          description="Manage global templates for the marketplace"
        />
        <SkeletonTable rows={8} />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div>
        <PageHeader
          title="Templates Manager"
          description="Manage global templates for the marketplace"
        />
        <EmptyState
          title="Failed to load templates"
          description={error}
          action={
            <button
              type="button"
              onClick={() => refetch()}
              className="flex items-center gap-2 rounded-md border border-border bg-background-subtle px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-background-muted"
            >
              <RefreshCw size={14} />
              Retry
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Templates Manager"
        description="Manage global templates for the marketplace"
        actions={
          <button
            onClick={() => router.push('/templates/upload')}
            className="flex items-center gap-2 px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm font-medium hover:opacity-90 transition-colors"
          >
            <Upload size={16} />
            Upload Template
          </button>
        }
      />

      {actionError && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-error/25 bg-error/10 px-4 py-3 text-sm text-error">
          <span>{actionError}</span>
          <button
            onClick={() => setActionError(null)}
            className="ml-4 text-xs font-medium hover:text-error-muted transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {templates.length > 0 ? (
        <div className={loading ? 'opacity-60 pointer-events-none transition-opacity' : ''}>
          <DataTable
            columns={columns}
            data={templates}
            rowKey={(row) => row.id}
            onRowClick={(row) => router.push(`/templates/${row.id}`)}
            pageSize={25}
          />
        </div>
      ) : (
        <EmptyState
          icon={<LayoutTemplate size={48} />}
          title="No templates found"
          description="Upload your first template to get started."
          action={
            <button
              onClick={() => router.push('/templates/upload')}
              className="flex items-center gap-2 px-4 py-2 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm font-medium hover:opacity-90 transition-colors"
            >
              <Upload size={16} />
              Upload Template
            </button>
          }
        />
      )}

      <ConfirmDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setArchiveTarget(null);
        }}
        title="Archive Template"
        description={
          archiveTarget
            ? `Are you sure you want to archive "${archiveTarget.name}"? This will remove it from the marketplace.`
            : ''
        }
        confirmLabel="Archive"
        variant="destructive"
        onConfirm={handleArchive}
        loading={archiving}
        loadingLabel="Archiving..."
      />
    </div>
  );
}
