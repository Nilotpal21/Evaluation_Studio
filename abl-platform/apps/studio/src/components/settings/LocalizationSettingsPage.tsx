'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  FileText,
  GitBranch,
  Globe,
  Languages,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  createLocalizationAsset,
  deleteLocalizationAsset,
  fetchLocalizationAssets,
  type LocalizationAsset,
  updateLocalizationAsset,
} from '@/api/localization';
import { fetchGitIntegration, pushToGit } from '@/api/project-io';
import { sanitizeError } from '@/lib/sanitize-error';
import { useNavigationStore } from '@/store/navigation-store';
import { DetailPageShell } from '../ui/DetailPageShell';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Textarea } from '../ui/Textarea';
import { EmptyState } from '../ui/EmptyState';
import { DataTable, type Column } from '../ui/DataTable';
import { SlidePanel } from '../ui/SlidePanel';
import { ConfirmDialog } from '../ui/ConfirmDialog';

const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.default), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-background-muted" />,
});

const EMPTY_EDITOR_JSON = '{\n  \n}';

interface EditorDraft {
  mode: 'create' | 'edit';
  assetId: string | null;
  relativePath: string;
  description: string;
  value: string;
}

function sortAssets(assets: LocalizationAsset[]): LocalizationAsset[] {
  return [...assets].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function formatJsonObject(value: string): string {
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Localization asset content must be a JSON object');
  }

  return JSON.stringify(parsed, null, 2);
}

export function LocalizationSettingsPage() {
  const t = useTranslations('settings.localization');
  const tCommon = useTranslations('common');
  const projectId = useNavigationStore((state) => state.projectId);
  const navigate = useNavigationStore((state) => state.navigate);

  const [assets, setAssets] = useState<LocalizationAsset[]>([]);
  const [locales, setLocales] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [gitConnected, setGitConnected] = useState(false);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [pushingToGit, setPushingToGit] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [localeFilter, setLocaleFilter] = useState('');
  const [scopeFilter, setScopeFilter] = useState('');

  const [editor, setEditor] = useState<EditorDraft | null>(null);
  const [editorError, setEditorError] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LocalizationAsset | null>(null);
  const [deleting, setDeleting] = useState(false);

  const uploadInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (showSpinner = true) => {
      if (!projectId) {
        return;
      }

      if (showSpinner) {
        setLoading(true);
      } else {
        setRefreshing(true);
      }

      try {
        const [localizationResponse, gitResponse] = await Promise.all([
          fetchLocalizationAssets(projectId),
          fetchGitIntegration(projectId).catch(() => ({ integration: null })),
        ]);

        setAssets(sortAssets(localizationResponse.assets));
        setLocales(localizationResponse.locales);
        setGitConnected(!!gitResponse.integration);
        setGitBranch(gitResponse.integration?.defaultBranch ?? null);
      } catch (error) {
        toast.error(sanitizeError(error, t('load_failed')));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [projectId, t],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const filteredAssets = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return assets.filter((asset) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        asset.relativePath.toLowerCase().includes(normalizedQuery) ||
        asset.description?.toLowerCase().includes(normalizedQuery) ||
        asset.localeCode.toLowerCase().includes(normalizedQuery) ||
        asset.assetName.toLowerCase().includes(normalizedQuery);
      const matchesLocale = localeFilter.length === 0 || asset.localeCode === localeFilter;
      const matchesScope = scopeFilter.length === 0 || asset.scope === scopeFilter;

      return matchesQuery && matchesLocale && matchesScope;
    });
  }, [assets, localeFilter, scopeFilter, searchQuery]);

  const sharedAssetsCount = useMemo(
    () => assets.filter((asset) => asset.scope === 'shared').length,
    [assets],
  );

  const localeOptions = useMemo(
    () => [
      { value: '', label: t('filters.all_locales') },
      ...locales.map((localeCode) => ({ value: localeCode, label: localeCode })),
    ],
    [locales, t],
  );

  const scopeOptions = useMemo(
    () => [
      { value: '', label: t('filters.all_scopes') },
      { value: 'shared', label: t('scope.shared') },
      { value: 'agent', label: t('scope.agent') },
    ],
    [t],
  );

  const openCreateEditor = useCallback(() => {
    setEditor({
      mode: 'create',
      assetId: null,
      relativePath: '',
      description: '',
      value: EMPTY_EDITOR_JSON,
    });
    setEditorError('');
  }, []);

  const openEditEditor = useCallback((asset: LocalizationAsset) => {
    setEditor({
      mode: 'edit',
      assetId: asset.id,
      relativePath: asset.relativePath,
      description: asset.description ?? '',
      value: asset.value,
    });
    setEditorError('');
  }, []);

  const closeEditor = useCallback(() => {
    if (saving) {
      return;
    }
    setEditor(null);
    setEditorError('');
  }, [saving]);

  const handlePrettify = useCallback(() => {
    if (!editor) {
      return;
    }

    try {
      setEditor((current) =>
        current
          ? {
              ...current,
              value: formatJsonObject(current.value),
            }
          : current,
      );
      setEditorError('');
    } catch (error) {
      setEditorError(sanitizeError(error, t('editor.json_object_required')));
    }
  }, [editor, t]);

  const handleUploadJson = useCallback(async () => {
    uploadInputRef.current?.click();
  }, []);

  const handleUploadedFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';

      if (!file) {
        return;
      }

      try {
        const text = await file.text();
        const formatted = formatJsonObject(text);
        setEditor((current) =>
          current
            ? {
                ...current,
                value: formatted,
              }
            : current,
        );
        setEditorError('');
        toast.success(t('editor.upload_loaded', { name: file.name }));
      } catch (error) {
        toast.error(sanitizeError(error, t('editor.upload_failed')));
      }
    },
    [t],
  );

  const handleSave = useCallback(async () => {
    if (!projectId || !editor) {
      return;
    }

    try {
      setSaving(true);
      setEditorError('');

      const payload = {
        relativePath: editor.relativePath.trim(),
        description: editor.description.trim() ? editor.description.trim() : null,
        value: formatJsonObject(editor.value),
      };

      const response =
        editor.mode === 'create'
          ? await createLocalizationAsset(projectId, payload)
          : await updateLocalizationAsset(projectId, editor.assetId!, payload);

      const nextAssets =
        editor.mode === 'create'
          ? sortAssets([...assets, response.asset])
          : sortAssets(
              assets.map((asset) => (asset.id === response.asset.id ? response.asset : asset)),
            );

      setAssets(nextAssets);
      setLocales(
        [...new Set(nextAssets.map((asset) => asset.localeCode))].sort((a, b) =>
          a.localeCompare(b),
        ),
      );
      setEditor({
        mode: 'edit',
        assetId: response.asset.id,
        relativePath: response.asset.relativePath,
        description: response.asset.description ?? '',
        value: response.asset.value,
      });
      toast.success(editor.mode === 'create' ? t('created_toast') : t('updated_toast'));
    } catch (error) {
      const message = sanitizeError(error, t('save_failed'));
      setEditorError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }, [assets, editor, projectId, t]);

  const handleDelete = useCallback(async () => {
    if (!projectId || !deleteTarget) {
      return;
    }

    try {
      setDeleting(true);
      await deleteLocalizationAsset(projectId, deleteTarget.id);

      const nextAssets = assets.filter((asset) => asset.id !== deleteTarget.id);
      setAssets(nextAssets);
      setLocales(
        [...new Set(nextAssets.map((asset) => asset.localeCode))].sort((a, b) =>
          a.localeCompare(b),
        ),
      );
      setDeleteTarget(null);

      if (editor?.assetId === deleteTarget.id) {
        setEditor(null);
        setEditorError('');
      }

      toast.success(t('deleted_toast'));
    } catch (error) {
      toast.error(sanitizeError(error, t('delete_failed')));
    } finally {
      setDeleting(false);
    }
  }, [assets, deleteTarget, editor?.assetId, projectId, t]);

  const handlePushToGit = useCallback(async () => {
    if (!projectId) {
      return;
    }

    try {
      setPushingToGit(true);
      const result = await pushToGit(projectId);
      toast.success(
        result.message ??
          t('git_push_success', {
            count: result.localeFilesCount ?? assets.length,
          }),
      );
    } catch (error) {
      toast.error(sanitizeError(error, t('git_push_failed')));
    } finally {
      setPushingToGit(false);
    }
  }, [assets.length, projectId, t]);

  const columns = useMemo<Column<LocalizationAsset>[]>(
    () => [
      {
        key: 'file',
        label: t('table.file'),
        sortable: true,
        sortValue: (asset) => asset.relativePath,
        render: (asset) => (
          <div className="space-y-1">
            <div className="font-medium text-foreground">{asset.filePath}</div>
            <div className="text-xs text-muted">
              {asset.description || t('table.no_description')}
            </div>
          </div>
        ),
      },
      {
        key: 'locale',
        label: t('table.locale'),
        sortable: true,
        sortValue: (asset) => asset.localeCode,
        render: (asset) => <Badge variant="accent">{asset.localeCode}</Badge>,
      },
      {
        key: 'scope',
        label: t('table.scope'),
        sortable: true,
        sortValue: (asset) => asset.scope,
        render: (asset) => (
          <Badge variant={asset.scope === 'shared' ? 'info' : 'default'}>
            {asset.scope === 'shared' ? t('scope.shared') : t('scope.agent')}
          </Badge>
        ),
      },
      {
        key: 'updatedAt',
        label: t('table.updated'),
        sortable: true,
        sortValue: (asset) => asset.updatedAt ?? '',
        render: (asset) => (
          <span className="text-sm text-muted">
            {asset.updatedAt ? new Date(asset.updatedAt).toLocaleString() : t('table.never')}
          </span>
        ),
      },
      {
        key: 'actions',
        label: tCommon('actions'),
        render: (asset) => (
          <Button
            variant="ghost"
            size="sm"
            icon={<Pencil className="w-3.5 h-3.5" />}
            onClick={(event) => {
              event.stopPropagation();
              openEditEditor(asset);
            }}
          >
            {tCommon('edit')}
          </Button>
        ),
      },
    ],
    [openEditEditor, t, tCommon],
  );

  return (
    <DetailPageShell
      title={t('page_title')}
      maxWidth="full"
      actions={
        <>
          <Button
            variant="ghost"
            size="sm"
            icon={
              refreshing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )
            }
            onClick={() => void load(false)}
          >
            {tCommon('refresh')}
          </Button>
          {gitConnected ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<GitBranch className="w-3.5 h-3.5" />}
              loading={pushingToGit}
              onClick={() => void handlePushToGit()}
            >
              {t('push_to_git')}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              icon={<GitBranch className="w-3.5 h-3.5" />}
              onClick={() => projectId && navigate(`/projects/${projectId}/settings/git`)}
            >
              {t('open_git_settings')}
            </Button>
          )}
          <Button size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={openCreateEditor}>
            {t('new_asset')}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-5 w-5 animate-spin text-muted" />
        </div>
      ) : (
        <div className="space-y-6">
          <Card hoverable={false} padding="lg">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div className="space-y-2">
                <div className="inline-flex items-center gap-2 rounded-full bg-accent-subtle px-3 py-1 text-xs font-medium text-accent">
                  <Languages className="h-3.5 w-3.5" />
                  {t('eyebrow')}
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-foreground">{t('intro_title')}</h2>
                  <p className="mt-2 max-w-3xl text-sm text-muted">{t('page_description')}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="accent">{t('summary.assets', { count: assets.length })}</Badge>
                <Badge variant="info">{t('summary.locales', { count: locales.length })}</Badge>
                <Badge variant="default">
                  {t('summary.shared_assets', { count: sharedAssetsCount })}
                </Badge>
              </div>
            </div>

            <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="rounded-xl border border-default bg-background-subtle p-4">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-background-muted p-2 text-muted">
                    <Sparkles className="h-4 w-4" />
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-foreground">
                      {t('path_contract_title')}
                    </p>
                    <p className="text-sm text-muted">{t('path_contract_description')}</p>
                    <div className="rounded-lg bg-background-elevated px-3 py-2 text-xs font-mono text-foreground">
                      {t('path_contract_example')}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-default bg-background-subtle p-4">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-background-muted p-2 text-muted">
                    <GitBranch className="h-4 w-4" />
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-foreground">{t('git_card_title')}</p>
                    <p className="text-sm text-muted">
                      {gitConnected
                        ? t('git_card_connected', { branch: gitBranch ?? t('git_branch_unknown') })
                        : t('git_card_disconnected')}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant={gitConnected ? 'success' : 'default'} dot>
                        {gitConnected ? t('git_connected') : t('git_not_connected')}
                      </Badge>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          <Card hoverable={false} padding="lg">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_220px_220px]">
              <Input
                label={tCommon('search')}
                placeholder={t('search_placeholder')}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                icon={<Search className="h-4 w-4" />}
              />
              <Select
                label={t('filters.locale_label')}
                options={localeOptions}
                value={localeFilter}
                onChange={setLocaleFilter}
              />
              <Select
                label={t('filters.scope_label')}
                options={scopeOptions}
                value={scopeFilter}
                onChange={setScopeFilter}
              />
            </div>
          </Card>

          <Card hoverable={false} padding="none">
            {assets.length === 0 ? (
              <EmptyState
                icon={<Languages className="h-6 w-6" />}
                title={t('empty_title')}
                description={t('empty_description')}
                action={
                  <Button icon={<Plus className="h-4 w-4" />} onClick={openCreateEditor}>
                    {t('new_asset')}
                  </Button>
                }
              />
            ) : (
              <DataTable
                columns={columns}
                data={filteredAssets}
                keyExtractor={(asset) => asset.id}
                onRowClick={openEditEditor}
                emptyMessage={t('empty_filtered')}
                className="px-2 py-2"
              />
            )}
          </Card>
        </div>
      )}

      <SlidePanel
        open={editor !== null}
        onClose={closeEditor}
        title={editor?.mode === 'create' ? t('editor.create_title') : t('editor.edit_title')}
        description={
          editor?.mode === 'create' ? t('editor.create_description') : editor?.relativePath
        }
        width="full"
      >
        {editor && (
          <div className="flex min-h-[640px] flex-col gap-6">
            <div className="grid flex-1 gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
              <div className="space-y-4 xl:border-r xl:border-default xl:pr-6">
                <Input
                  label={t('editor.relative_path_label')}
                  placeholder={t('editor.relative_path_placeholder')}
                  value={editor.relativePath}
                  onChange={(event) =>
                    setEditor((current) =>
                      current
                        ? {
                            ...current,
                            relativePath: event.target.value,
                          }
                        : current,
                    )
                  }
                />

                <Textarea
                  label={tCommon('description')}
                  placeholder={t('editor.description_placeholder')}
                  rows={3}
                  value={editor.description}
                  onChange={(event) =>
                    setEditor((current) =>
                      current
                        ? {
                            ...current,
                            description: event.target.value,
                          }
                        : current,
                    )
                  }
                />

                <div className="rounded-xl border border-default bg-background-subtle p-4">
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-foreground">
                      {t('editor.metadata_title')}
                    </p>
                    <p className="text-sm text-muted">{t('editor.metadata_description')}</p>
                    {editor.relativePath.trim().length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {editor.relativePath.includes('/_shared.json') ? (
                          <Badge variant="info">{t('scope.shared')}</Badge>
                        ) : (
                          <Badge variant="default">{t('scope.agent')}</Badge>
                        )}
                        <Badge variant="accent">
                          {editor.relativePath.split('/')[0] || t('editor.locale_pending')}
                        </Badge>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Upload className="h-3.5 w-3.5" />}
                    onClick={() => void handleUploadJson()}
                  >
                    {t('editor.upload_json')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Sparkles className="h-3.5 w-3.5" />}
                    onClick={handlePrettify}
                  >
                    {t('editor.prettify')}
                  </Button>
                </div>

                {editor.mode === 'edit' && (
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                    onClick={() => {
                      const asset = assets.find((candidate) => candidate.id === editor.assetId);
                      if (asset) {
                        setDeleteTarget(asset);
                      }
                    }}
                  >
                    {tCommon('delete')}
                  </Button>
                )}

                {editorError && (
                  <div className="rounded-xl border border-error/30 bg-error-subtle/30 px-3 py-2 text-sm text-error">
                    {editorError}
                  </div>
                )}
              </div>

              <div className="min-w-0">
                <div className="overflow-hidden rounded-xl border border-default bg-background-subtle">
                  <div className="flex items-center justify-between border-b border-default px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="rounded-lg bg-background-muted p-2 text-muted">
                        {editor.relativePath.includes('/_shared.json') ? (
                          <Globe className="h-4 w-4" />
                        ) : (
                          <FileText className="h-4 w-4" />
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          {t('editor.json_title')}
                        </p>
                        <p className="text-xs text-muted">{t('editor.json_description')}</p>
                      </div>
                    </div>
                    <Badge variant="accent">
                      {editor.relativePath.trim() || t('editor.unsaved_asset')}
                    </Badge>
                  </div>

                  <div className="h-[calc(100vh-340px)] min-h-[420px]">
                    <MonacoEditor
                      language="json"
                      theme="vs-dark"
                      value={editor.value}
                      onChange={(value) =>
                        setEditor((current) =>
                          current
                            ? {
                                ...current,
                                value: value ?? '',
                              }
                            : current,
                        )
                      }
                      options={{
                        minimap: { enabled: false },
                        fontSize: 13,
                        lineNumbers: 'on',
                        scrollBeyondLastLine: false,
                        wordWrap: 'on',
                        tabSize: 2,
                        automaticLayout: true,
                        padding: { top: 16 },
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t border-default pt-4 lg:flex-row lg:items-center lg:justify-between">
              <p className="text-sm text-muted">{t('editor.save_hint')}</p>
              <div className="flex flex-wrap gap-3">
                <Button variant="ghost" onClick={closeEditor}>
                  {tCommon('cancel')}
                </Button>
                <Button
                  loading={saving}
                  icon={<Pencil className="h-3.5 w-3.5" />}
                  onClick={() => void handleSave()}
                >
                  {editor.mode === 'create' ? tCommon('create') : tCommon('save')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </SlidePanel>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
        title={t('delete_title')}
        description={
          deleteTarget
            ? t('delete_description', { path: deleteTarget.filePath })
            : t('delete_description', { path: '' })
        }
        confirmLabel={tCommon('delete')}
        loading={deleting}
        variant="danger"
      />

      <input
        ref={uploadInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleUploadedFile}
      />
    </DetailPageShell>
  );
}
