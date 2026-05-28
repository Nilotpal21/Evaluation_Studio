'use client';

/**
 * PromptLibraryDetailPage
 *
 * Three-tab detail view for a prompt library item:
 *  - Template tab: PromptEditor with save-draft + promote actions
 *  - Versions tab: full version history with lifecycle actions
 *  - References tab: agent versions that reference this prompt
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ChevronUp, Archive, Library, FlaskConical, X } from 'lucide-react';
import { toast } from 'sonner';
import { useProjectStore } from '../../store/project-store';
import { useNavigationStore } from '../../store/navigation-store';
import {
  fetchPrompt,
  fetchVersions,
  fetchReferences,
  updateVersion,
  updatePrompt,
  promoteVersion,
  archiveVersion,
  createVersion,
  type PromptLibraryItem,
  type PromptLibraryVersion,
  type PromptDraftAgentReference,
  type PromptReference,
} from '../../api/prompt-library';
import { PromptEditor, extractVariables } from './PromptEditor';
import { sanitizeError } from '../../lib/sanitize-error';

type DetailTab = 'template' | 'versions' | 'references';

interface PromptLibraryDetailPageProps {
  promptId: string;
}

export function PromptLibraryDetailPage({ promptId }: PromptLibraryDetailPageProps) {
  const t = useTranslations('prompt_library.detail');
  const currentProject = useProjectStore((s) => s.currentProject);
  const navigate = useNavigationStore((s) => s.navigate);

  const [tab, setTab] = useState<DetailTab>('template');
  const [prompt, setPrompt] = useState<PromptLibraryItem | null>(null);
  const [versions, setVersions] = useState<PromptLibraryVersion[]>([]);
  const [references, setReferences] = useState<PromptReference[]>([]);
  const [draftReferences, setDraftReferences] = useState<PromptDraftAgentReference[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [draftVersion, setDraftVersion] = useState<PromptLibraryVersion | null>(null);
  const [editorValue, setEditorValue] = useState('');
  const [editorVariables, setEditorVariables] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [promoting, setPromoting] = useState(false);

  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [savingTags, setSavingTags] = useState(false);
  const tagInputRef = useRef<HTMLInputElement>(null);

  const projectId = currentProject?.id;

  const loadAll = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const [promptResult, versionsResult] = await Promise.all([
        fetchPrompt(projectId, promptId),
        fetchVersions(projectId, promptId, { limit: 100 }),
      ]);
      setPrompt(promptResult.item);
      setTags(promptResult.item.tags ?? []);
      setVersions(versionsResult.items);
      const draft = versionsResult.items.find((v) => v.status === 'draft');
      setDraftVersion(draft ?? null);
      setEditorValue(draft?.template ?? '');
      setEditorVariables(extractVariables(draft?.template ?? ''));
    } catch (err) {
      setError(sanitizeError(err, t('load_failed')));
    } finally {
      setLoading(false);
    }
  }, [projectId, promptId]);

  const loadReferences = useCallback(async () => {
    if (!projectId) return;
    try {
      const result = await fetchReferences(projectId, promptId);
      setReferences(result.agents);
      setDraftReferences(result.draftAgents);
    } catch {
      setReferences([]);
      setDraftReferences([]);
    }
  }, [projectId, promptId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (tab === 'references') void loadReferences();
  }, [tab, loadReferences]);

  const handleSaveDraft = async () => {
    if (!projectId || !editorValue.trim()) return;
    setSaving(true);
    try {
      if (draftVersion) {
        const result = await updateVersion(projectId, promptId, draftVersion._id, {
          template: editorValue,
          variables: editorVariables,
        });
        setDraftVersion(result.item);
        setVersions((prev) => prev.map((v) => (v._id === result.item._id ? result.item : v)));
      } else {
        const result = await createVersion(projectId, promptId, {
          template: editorValue,
          variables: editorVariables,
        });
        setDraftVersion(result.item);
        setVersions((prev) => [result.item, ...prev]);
      }
      toast.success(t('draft_saved'));
    } catch (err) {
      toast.error(sanitizeError(err, t('save_failed')));
    } finally {
      setSaving(false);
    }
  };

  const handlePromote = async () => {
    if (!projectId || !draftVersion) return;
    setPromoting(true);
    try {
      await promoteVersion(projectId, promptId, draftVersion._id);
      toast.success(t('promoted_toast'));
      void loadAll();
    } catch (err) {
      toast.error(sanitizeError(err, t('promote_failed')));
    } finally {
      setPromoting(false);
    }
  };

  const handleArchiveVersion = async (version: PromptLibraryVersion) => {
    if (!projectId) return;
    try {
      await archiveVersion(projectId, promptId, version._id);
      toast.success(t('archived_toast', { number: version.versionNumber }));
      void loadAll();
    } catch (err) {
      toast.error(sanitizeError(err, t('archive_failed')));
    }
  };

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

  const handleSaveTags = async (finalTags: string[]) => {
    if (!projectId) return;
    setSavingTags(true);
    try {
      const result = await updatePrompt(projectId, promptId, { tags: finalTags });
      setPrompt(result.item);
      setTags(result.item.tags ?? []);
      toast.success(t('tags_saved'));
    } catch (err) {
      toast.error(sanitizeError(err, t('tags_save_failed')));
    } finally {
      setSavingTags(false);
    }
  };

  const handleTagBlur = () => {
    const trimmed = tagInput.trim().toLowerCase();
    const finalTags = trimmed && !tags.includes(trimmed) ? [...tags, trimmed] : tags;
    setTagInput('');
    if (JSON.stringify(finalTags) !== JSON.stringify(prompt?.tags ?? [])) {
      void handleSaveTags(finalTags);
    }
  };

  if (!projectId) return null;

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-6 py-4 border-b border-default">
          <div className="h-6 w-48 bg-background-muted rounded animate-pulse" />
        </div>
        <div className="flex-1 p-6 space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-4 bg-background-muted rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !prompt) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <Library className="h-10 w-10 text-foreground-muted" />
        <p className="text-sm text-status-error">{error ?? t('not_found')}</p>
        <button
          type="button"
          onClick={() => navigate(`/projects/${projectId}/prompt-library`)}
          className="text-sm text-accent hover:underline"
        >
          ← {t('back_to_library')}
        </button>
      </div>
    );
  }

  const activeVersion = versions.find((v) => v.status === 'active');

  const TABS: { id: DetailTab; label: string }[] = [
    { id: 'template', label: t('tab_template') },
    { id: 'versions', label: t('tab_versions') },
    { id: 'references', label: t('tab_references') },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-default shrink-0">
        <button
          type="button"
          onClick={() => navigate(`/projects/${projectId}/prompt-library`)}
          className="flex items-center gap-1 text-xs text-foreground-muted hover:text-foreground mb-2 transition-colors"
        >
          <ArrowLeft className="h-3 w-3" />
          {t('back_to_library')}
        </button>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-foreground">{prompt.name}</h1>
            {prompt.description && (
              <p className="text-sm text-foreground-muted mt-0.5">{prompt.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1 shrink-0">
            <button
              type="button"
              onClick={() => navigate(`/projects/${projectId}/prompt-library/${promptId}/compare`)}
              className="inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium bg-accent text-accent-foreground hover:bg-accent/90 transition-colors"
            >
              <FlaskConical className="h-3.5 w-3.5" />
              {t('test_compare')}
            </button>
            <span
              className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
                prompt.status === 'active'
                  ? 'bg-status-success/10 text-status-success'
                  : 'bg-background-muted text-foreground-muted'
              }`}
            >
              {prompt.status}
            </span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-default shrink-0 px-6">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === id
                ? 'border-accent text-accent'
                : 'border-transparent text-foreground-muted hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'template' && (
          <div className="flex flex-col gap-4 max-w-3xl">
            <PromptEditor
              value={editorValue}
              onChange={setEditorValue}
              onVariablesChange={setEditorVariables}
            />

            {editorVariables.length > 0 && (
              <div>
                <p className="text-xs font-medium text-foreground-muted mb-2">
                  {t('variables_label')}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {editorVariables.map((v) => (
                    <span
                      key={v}
                      className="rounded px-2 py-0.5 text-xs font-mono bg-accent/10 text-accent"
                    >
                      {`{{${v}}}`}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleSaveDraft()}
                disabled={saving || !editorValue.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium border border-default text-foreground hover:bg-background-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? '…' : t('save_draft')}
              </button>
              <button
                type="button"
                onClick={() => void handlePromote()}
                disabled={promoting || !draftVersion || editorValue !== draftVersion.template}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ChevronUp className="h-3.5 w-3.5" />
                {promoting ? '…' : t('promote')}
              </button>
            </div>

            {activeVersion && (
              <div className="rounded-lg border border-default bg-background-subtle p-4">
                <p className="text-xs font-medium text-foreground-muted mb-2">
                  Active — v{activeVersion.versionNumber}
                </p>
                <pre className="whitespace-pre-wrap text-sm font-mono text-foreground-muted leading-relaxed">
                  {activeVersion.template}
                </pre>
              </div>
            )}

            {/* Tags */}
            <div>
              <p className="text-xs font-medium text-foreground-muted mb-2">{t('tags_label')}</p>
              <div
                className="flex flex-wrap gap-1.5 min-h-[36px] rounded-lg border border-default bg-background-subtle px-3 py-2 cursor-text focus-within:ring-2 focus-within:ring-accent/50 focus-within:border-accent"
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
                      disabled={savingTags}
                      onClick={(e) => {
                        e.stopPropagation();
                        const next = tags.filter((t) => t !== tag);
                        setTags(next);
                        void handleSaveTags(next);
                      }}
                      className="hover:text-accent/70 disabled:opacity-40"
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
                  onBlur={handleTagBlur}
                  placeholder={tags.length === 0 ? t('tags_placeholder') : ''}
                  className="flex-1 min-w-[120px] bg-transparent text-sm text-foreground placeholder:text-foreground-muted outline-none"
                />
              </div>
            </div>
          </div>
        )}

        {tab === 'versions' && (
          <div className="space-y-2 max-w-2xl">
            {versions.length === 0 ? (
              <p className="text-sm text-foreground-muted">{t('no_variables')}</p>
            ) : (
              versions.map((version) => (
                <div
                  key={version._id}
                  className="flex items-center justify-between gap-4 rounded-lg border border-default bg-background-elevated px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      v{version.versionNumber}
                      {version.description && (
                        <span className="ml-2 text-xs text-foreground-muted font-normal">
                          {version.description}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-foreground-muted">
                      {new Date(version.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${
                        version.status === 'active'
                          ? 'bg-status-success/10 text-status-success'
                          : version.status === 'draft'
                            ? 'bg-background-muted text-foreground-muted'
                            : 'bg-status-error/10 text-status-error'
                      }`}
                    >
                      {t(`version_status_${version.status}`)}
                    </span>
                    {version.status !== 'archived' && (
                      <button
                        type="button"
                        title={t('archive')}
                        onClick={() => void handleArchiveVersion(version)}
                        className="rounded p-1 text-foreground-muted hover:text-status-error hover:bg-status-error/10 transition-colors"
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'references' && (
          <div className="space-y-2 max-w-2xl">
            {references.length === 0 && draftReferences.length === 0 ? (
              <p className="text-sm text-foreground-muted">{t('references_empty')}</p>
            ) : (
              <>
                <p className="text-xs text-foreground-muted mb-3">
                  {t('references_count', { count: references.length + draftReferences.length })}
                </p>
                {references.map((ref) => (
                  <div
                    key={`version:${ref.agentName}:${ref.versionId}`}
                    className="flex items-center justify-between rounded-lg border border-default bg-background-elevated px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground">{ref.agentName}</p>
                      <p className="text-xs text-foreground-muted font-mono">
                        {ref.versionId.slice(0, 8)} · {ref.resolvedHash.slice(0, 8)}
                      </p>
                    </div>
                  </div>
                ))}
                {draftReferences.map((ref) => (
                  <div
                    key={`draft:${ref.agentName}:${ref.versionId}`}
                    className="flex items-center justify-between rounded-lg border border-default bg-background-elevated px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium text-foreground">{ref.agentName}</p>
                      <p className="text-xs text-foreground-muted font-mono">
                        {ref.versionId.slice(0, 8)} ·{' '}
                        {ref.resolvedHash
                          ? ref.resolvedHash.slice(0, 8)
                          : t('references_unresolved')}
                      </p>
                    </div>
                    <span className="rounded bg-status-warning/10 px-2 py-0.5 text-xs font-medium text-status-warning">
                      {t('references_draft_agent')}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
