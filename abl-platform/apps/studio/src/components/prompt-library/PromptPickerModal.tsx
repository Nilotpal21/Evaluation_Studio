'use client';

/**
 * PromptPickerModal
 *
 * Modal for selecting a prompt + version pair to attach to an agent.
 * Shows a searchable, paginated list of active prompts. Each row expands
 * to a version dropdown (active + draft only). Returns the selected pair
 * via `onConfirm`.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Search, X, ChevronDown, Library } from 'lucide-react';
import {
  fetchPrompts,
  fetchVersions,
  type PromptLibraryItem,
  type PromptLibraryVersion,
} from '../../api/prompt-library';
import { sanitizeError } from '../../lib/sanitize-error';

const PAGE_SIZE = 20;

export interface PickerSelection {
  promptId: string;
  versionId: string;
  promptName: string;
  versionNumber: number;
}

interface PromptPickerModalProps {
  projectId: string;
  onConfirm: (selection: PickerSelection) => void;
  onClose: () => void;
}

export function PromptPickerModal({ projectId, onConfirm, onClose }: PromptPickerModalProps) {
  const t = useTranslations('prompt_library.picker');

  const [search, setSearch] = useState('');
  const [prompts, setPrompts] = useState<PromptLibraryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [expandedPromptId, setExpandedPromptId] = useState<string | null>(null);
  const [versions, setVersions] = useState<PromptLibraryVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);

  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  const load = useCallback(
    async (searchValue: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchPrompts(projectId, {
          status: 'active',
          search: searchValue || undefined,
          limit: PAGE_SIZE,
        });
        setPrompts(result.items);
        setTotal(result.total);
      } catch (err) {
        setError(sanitizeError(err, 'Failed to load prompts'));
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load('');
  }, [load]);

  useEffect(() => {
    const id = setTimeout(() => void load(search), 250);
    return () => clearTimeout(id);
  }, [search, load]);

  const expandPrompt = useCallback(
    async (promptId: string) => {
      if (expandedPromptId === promptId) {
        setExpandedPromptId(null);
        return;
      }
      setExpandedPromptId(promptId);
      setVersionsLoading(true);
      try {
        const result = await fetchVersions(projectId, promptId, { limit: 50 });
        setVersions(result.items.filter((v) => v.status !== 'archived'));
      } catch {
        setVersions([]);
      } finally {
        setVersionsLoading(false);
      }
    },
    [expandedPromptId, projectId],
  );

  const handleSelectVersion = (prompt: PromptLibraryItem, version: PromptLibraryVersion) => {
    setSelectedPromptId(prompt._id);
    setSelectedVersionId(version._id);
  };

  const selectedPrompt = prompts.find((p) => p._id === selectedPromptId);
  const selectedVersion = versions.find((v) => v._id === selectedVersionId);

  const handleConfirm = () => {
    if (!selectedPrompt || !selectedVersion) return;
    onConfirm({
      promptId: selectedPrompt._id,
      versionId: selectedVersion._id,
      promptName: selectedPrompt.name,
      versionNumber: selectedVersion.versionNumber,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="relative flex flex-col w-full max-w-lg max-h-[80vh] rounded-xl border border-default bg-background shadow-elevated overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-default shrink-0">
          <div className="flex items-center gap-2">
            <Library className="h-4 w-4 text-accent" />
            <h2 className="text-base font-semibold text-foreground">{t('title')}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-foreground-muted hover:text-foreground hover:bg-background-muted transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b border-default shrink-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-foreground-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('search_placeholder')}
              className="w-full rounded-lg border border-default bg-background-subtle pl-9 pr-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent"
              autoFocus
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {error ? (
            <p className="px-4 py-6 text-sm text-status-error">{error}</p>
          ) : loading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-12 rounded-lg bg-background-muted animate-pulse" />
              ))}
            </div>
          ) : prompts.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <Library className="h-8 w-8 text-foreground-muted" />
              <p className="text-sm font-medium text-foreground">{t('empty_title')}</p>
              <p className="text-xs text-foreground-muted">{t('empty_description')}</p>
            </div>
          ) : (
            <ul>
              {prompts.map((prompt) => {
                const isExpanded = expandedPromptId === prompt._id;
                return (
                  <li key={prompt._id} className="border-b border-default last:border-0">
                    <button
                      type="button"
                      onClick={() => void expandPrompt(prompt._id)}
                      className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-background-muted transition-colors"
                    >
                      <div>
                        <p className="text-sm font-medium text-foreground">{prompt.name}</p>
                        {prompt.description && (
                          <p className="text-xs text-foreground-muted truncate max-w-xs">
                            {prompt.description}
                          </p>
                        )}
                      </div>
                      <ChevronDown
                        className={`h-4 w-4 text-foreground-muted shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                      />
                    </button>

                    {isExpanded && (
                      <div className="bg-background-subtle border-t border-default">
                        {versionsLoading ? (
                          <p className="px-6 py-3 text-xs text-foreground-muted">Loading…</p>
                        ) : versions.length === 0 ? (
                          <p className="px-6 py-3 text-xs text-foreground-muted">
                            {t('no_active_version')}
                          </p>
                        ) : (
                          <ul>
                            {versions.map((version) => {
                              const isSelected =
                                selectedPromptId === prompt._id &&
                                selectedVersionId === version._id;
                              return (
                                <li key={version._id}>
                                  <button
                                    type="button"
                                    onClick={() => handleSelectVersion(prompt, version)}
                                    className={`w-full flex items-center justify-between px-6 py-2 text-left transition-colors ${
                                      isSelected
                                        ? 'bg-accent/10 text-accent'
                                        : 'hover:bg-background-muted text-foreground'
                                    }`}
                                  >
                                    <span className="text-sm">
                                      v{version.versionNumber}
                                      {version.description && (
                                        <span className="text-foreground-muted ml-2 text-xs">
                                          {version.description}
                                        </span>
                                      )}
                                    </span>
                                    <span
                                      className={`text-xs rounded px-1.5 py-0.5 ${
                                        version.status === 'active'
                                          ? 'bg-status-success/10 text-status-success'
                                          : 'bg-background-muted text-foreground-muted'
                                      }`}
                                    >
                                      {version.status === 'active'
                                        ? t('version_active')
                                        : t('version_draft')}
                                    </span>
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-default shrink-0 bg-background">
          {selectedPrompt && selectedVersion ? (
            <p className="text-xs text-foreground-muted truncate">
              {selectedPrompt.name} · v{selectedVersion.versionNumber}
            </p>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-foreground-muted border border-default hover:bg-background-muted transition-colors"
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              disabled={!selectedPromptId || !selectedVersionId}
              onClick={handleConfirm}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {t('confirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
