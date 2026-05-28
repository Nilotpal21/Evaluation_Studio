/**
 * VocabularyTab Component (New Implementation)
 *
 * Field View UI for managing domain vocabulary entries.
 * Uses new REST APIs (API-1 to API-6) with Studio patterns (SWR + Radix UI).
 *
 * Features:
 * - List vocabulary entries with pagination
 * - Create/Edit/Delete entries
 * - Toggle enable/disable
 * - Test vocabulary resolution
 * - Search and filtering
 */

import { useState, useMemo } from 'react';
import useSWR from 'swr';
import {
  Plus,
  Pencil,
  Trash2,
  TestTube2,
  BookOpen,
  Search,
  Filter,
  MoreVertical,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '../ui/Button';
import { DataTable, type Column } from '../ui/DataTable';
import { Dialog } from '../ui/Dialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '../ui/DropdownMenu';
import { Pagination } from '../ui/Pagination';
import { Toggle } from '../ui/Toggle';
import { sanitizeError } from '@/lib/sanitize-error';
import {
  listVocabularyEntries,
  deleteVocabularyEntry,
  toggleVocabularyEntry,
  type VocabularyEntry,
} from '../../api/search-ai';
import { VocabularyEntryForm } from './VocabularyEntryForm';
import { VocabularyTestPanel } from './VocabularyTestPanel';

interface VocabularyTabProps {
  indexId: string;
}

export function VocabularyTab({ indexId }: VocabularyTabProps) {
  const t = useTranslations('search_ai.vocabulary');

  // State
  const [page, setPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'active' | 'inactive' | 'all'>('active');
  const [generatedByFilter, setGeneratedByFilter] = useState<'auto' | 'manual' | 'all'>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<VocabularyEntry | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<VocabularyEntry | null>(null);
  const [testOpen, setTestOpen] = useState(false);

  const limit = 50;
  const offset = (page - 1) * limit;

  // Build SWR key with filters
  const swrKey = useMemo(() => {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      status: statusFilter,
      generatedBy: generatedByFilter,
    });
    if (searchQuery.trim()) {
      params.append('search', searchQuery.trim());
    }
    return `/api/search-ai/indexes/${indexId}/vocabulary?${params.toString()}`;
  }, [indexId, page, limit, offset, statusFilter, generatedByFilter, searchQuery]);

  // Data fetching with SWR
  const { data, error, mutate, isLoading } = useSWR(indexId ? swrKey : null);

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / limit);

  // Handlers
  const handleToggle = async (entryId: string, enabled: boolean) => {
    try {
      await toggleVocabularyEntry(indexId, entryId, enabled);
      mutate();
      toast.success(t('toast_toggled', { state: enabled ? 'enabled' : 'disabled' }));
    } catch (err) {
      const msg = sanitizeError(err, t('error_toggle'));
      toast.error(msg);
    }
  };

  const handleDelete = async () => {
    if (!deleteEntry) return;
    try {
      await deleteVocabularyEntry(indexId, deleteEntry.id);
      mutate();
      setDeleteEntry(null);
      toast.success(t('toast_deleted'));
    } catch (err) {
      const msg = sanitizeError(err, t('error_delete'));
      toast.error(msg);
    }
  };

  const handleFormSuccess = () => {
    mutate();
    setCreateOpen(false);
    setEditEntry(null);
  };

  // Table columns
  const columns: Column<VocabularyEntry>[] = useMemo(
    () => [
      {
        key: 'term',
        label: t('col_term'),
        sortable: true,
        sortValue: (row) => row.term,
        render: (row) => (
          <div>
            <div className="font-medium text-foreground">{row.term}</div>
            {row.aliases.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {row.aliases.map((alias) => (
                  <Badge key={alias} variant="default" className="text-xs">
                    {alias}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        ),
      },
      {
        key: 'fieldRef',
        label: t('col_field'),
        sortable: true,
        sortValue: (row) => row.fieldRef,
        render: (row) => (
          <code className="text-xs text-muted bg-background-muted px-2 py-0.5 rounded">
            {row.fieldRef}
          </code>
        ),
      },
      {
        key: 'capabilities',
        label: t('col_capabilities'),
        render: (row) => (
          <div className="flex flex-wrap gap-1">
            {row.capabilities.canFilter && (
              <Badge variant="info" className="text-xs">
                {t('cap_filter')}
              </Badge>
            )}
            {row.capabilities.canDisplay && (
              <Badge variant="info" className="text-xs">
                {t('cap_display')}
              </Badge>
            )}
            {row.capabilities.canAggregate && (
              <Badge variant="info" className="text-xs">
                {t('cap_aggregate')}
              </Badge>
            )}
            {row.capabilities.canSort && (
              <Badge variant="info" className="text-xs">
                {t('cap_sort')}
              </Badge>
            )}
          </div>
        ),
      },
      {
        key: 'generatedBy',
        label: t('col_source'),
        sortable: true,
        sortValue: (row) => row.generatedBy,
        render: (row) => (
          <Badge variant={row.generatedBy === 'auto' ? 'default' : 'success'} className="text-xs">
            {row.generatedBy === 'auto' ? t('source_auto') : t('source_manual')}
          </Badge>
        ),
      },
      {
        key: 'enabled',
        label: t('col_enabled'),
        width: 'w-20',
        render: (row) => (
          <Toggle checked={row.enabled} onChange={(enabled) => handleToggle(row.id, enabled)} />
        ),
      },
      {
        key: 'actions',
        label: '',
        width: 'w-12',
        render: (row) => (
          <DropdownMenu
            trigger={
              <button
                className="p-1.5 text-muted hover:text-foreground rounded-lg transition-default"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="w-4 h-4" />
              </button>
            }
          >
            <DropdownMenuItem
              onSelect={() => setEditEntry(row)}
              icon={<Pencil className="w-4 h-4" />}
            >
              {t('action_edit')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setDeleteEntry(row)}
              variant="danger"
              icon={<Trash2 className="w-4 h-4" />}
            >
              {t('action_delete')}
            </DropdownMenuItem>
          </DropdownMenu>
        ),
      },
    ],
    [t, indexId],
  );

  if (error) {
    return (
      <div className="rounded-xl border border-default bg-background-elevated p-6">
        <EmptyState
          icon={<BookOpen className="w-6 h-6" />}
          title={t('error_title')}
          description={sanitizeError(error, t('error_load'))}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header Actions */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 flex-1 max-w-md">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-subtle" />
            <Input
              placeholder={t('search_placeholder')}
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(1); // Reset to first page on search
              }}
              className="pl-9"
            />
          </div>
          <DropdownMenu
            trigger={
              <Button variant="secondary" icon={<Filter className="w-4 h-4" />}>
                {t('filter')}
              </Button>
            }
          >
            {/* Filter options would go here */}
            <div className="px-3 py-2 text-xs text-muted">{t('filter_coming_soon')}</div>
          </DropdownMenu>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            icon={<TestTube2 className="w-4 h-4" />}
            onClick={() => setTestOpen(true)}
          >
            {t('test_resolution')}
          </Button>
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => setCreateOpen(true)}>
            {t('add_entry')}
          </Button>
        </div>
      </div>

      {/* Vocabulary Info */}
      {data?.vocabulary && (
        <div className="flex items-center gap-4 text-xs text-muted">
          <span>
            {t('vocab_version')}: <span className="font-medium">{data.vocabulary.version}</span>
          </span>
          <span>
            {t('vocab_status')}:{' '}
            <Badge
              className="text-xs"
              variant={data.vocabulary.status === 'active' ? 'success' : 'default'}
            >
              {data.vocabulary.status}
            </Badge>
          </span>
          {data.vocabulary.lastGeneratedAt && (
            <span>
              {t('vocab_last_generated')}:{' '}
              {new Date(data.vocabulary.lastGeneratedAt).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <div className="text-center py-12 text-sm text-muted">{t('loading')}</div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="w-6 h-6" />}
          title={searchQuery ? t('empty_search_title') : t('empty_title')}
          description={searchQuery ? t('empty_search_description') : t('empty_description')}
          action={
            !searchQuery && (
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => setCreateOpen(true)}>
                {t('add_first_entry')}
              </Button>
            )
          }
        />
      ) : (
        <>
          <div className="rounded-xl border border-default bg-background-elevated overflow-hidden">
            <DataTable
              columns={columns}
              data={entries}
              keyExtractor={(row) => row.id}
              onRowClick={(row) => setEditEntry(row)}
            />
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex justify-between items-center">
              <div className="text-sm text-muted">
                {t('showing_results', {
                  from: offset + 1,
                  to: Math.min(offset + limit, total),
                  total,
                })}
              </div>
              <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
            </div>
          )}
        </>
      )}

      {/* Create Dialog */}
      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t('dialog_create_title')}
        maxWidth="lg"
      >
        <VocabularyEntryForm
          indexId={indexId}
          onSuccess={handleFormSuccess}
          onCancel={() => setCreateOpen(false)}
        />
      </Dialog>

      {/* Edit Dialog */}
      {editEntry && (
        <Dialog
          open={!!editEntry}
          onClose={() => setEditEntry(null)}
          title={t('dialog_edit_title')}
          maxWidth="lg"
        >
          <VocabularyEntryForm
            indexId={indexId}
            entry={editEntry}
            onSuccess={handleFormSuccess}
            onCancel={() => setEditEntry(null)}
          />
        </Dialog>
      )}

      {/* Delete Confirmation */}
      <ConfirmDialog
        open={!!deleteEntry}
        onClose={() => setDeleteEntry(null)}
        onConfirm={handleDelete}
        title={t('confirm_delete_title')}
        description={t('confirm_delete_description', { term: deleteEntry?.term ?? '' })}
        variant="danger"
        confirmLabel={t('confirm_delete_button')}
      />

      {/* Test Panel Dialog */}
      <Dialog
        open={testOpen}
        onClose={() => setTestOpen(false)}
        title={t('dialog_test_title')}
        maxWidth="xl"
      >
        <VocabularyTestPanel indexId={indexId} />
      </Dialog>
    </div>
  );
}
