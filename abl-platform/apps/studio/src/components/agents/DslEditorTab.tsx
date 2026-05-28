/**
 * DslEditorTab Component
 *
 * Working copy DSL editor with save and create-version actions.
 * Wraps the existing ABLEditor and adds version creation controls.
 */

import { useState, useCallback, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { Check, Plus, Loader2, Brain, Wrench } from 'lucide-react';
import { saveDslWorkingCopy, fetchRuntimeAgent } from '../../api/runtime-agents';
import { fetchToolPreview, type ToolPreviewEntry } from '../../api/versions';
import { useAgentVersions } from '../../hooks/useAgentVersions';
import { useEditorStore } from '../../store/editor-store';
import { apiFetch } from '../../lib/api-client';

// Lazy-load Monaco-based editor (~50KB gzipped)
const ABLEditor = dynamic(
  () => import('../abl/ABLEditor').then((m) => ({ default: m.ABLEditor })),
  {
    ssr: false,
    loading: () => <div className="h-full animate-pulse bg-background-muted rounded" />,
  },
);
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Dialog } from '../ui/Dialog';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import { getRuntimeUrl } from '../../config/runtime';

interface DslEditorTabProps {
  projectId: string;
  agentName: string;
}

export function DslEditorTab({ projectId, agentName }: DslEditorTabProps) {
  const { create } = useAgentVersions(projectId, agentName);
  const setDslContent = useEditorStore((s) => s.setDslContent);
  const setOriginalContent = useEditorStore((s) => s.setOriginalContent);
  const isDirty = useEditorStore((s) => s.isDirty);
  const dslContent = useEditorStore((s) => s.dslContent);
  const [isSaving, setIsSaving] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [changelog, setChangelog] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [modelPreview, setModelPreview] = useState<{
    defaultModel: string | null;
    temperature: number | null;
    maxTokens: number | null;
  } | null>(null);
  const [toolPreview, setToolPreview] = useState<ToolPreviewEntry[] | null>(null);
  const [toolPreviewLoading, setToolPreviewLoading] = useState(false);

  // Load agent DSL content into editor
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await fetchRuntimeAgent(projectId, agentName);
        if (!cancelled && result.agent.dslContent) {
          setOriginalContent(result.agent.dslContent);
          setDslContent(result.agent.dslContent);
        }
      } catch {
        // Agent may not have DSL content yet
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, agentName, setOriginalContent, setDslContent]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await saveDslWorkingCopy(projectId, agentName, dslContent);
      setOriginalContent(dslContent);
      toast.success('Working copy saved');
    } catch (err) {
      toast.error(sanitizeError(err, 'Failed to save'));
    } finally {
      setIsSaving(false);
    }
  }, [projectId, agentName, dslContent, setOriginalContent]);

  const handleCreateVersion = useCallback(async () => {
    setIsCreating(true);
    try {
      // Save working copy first if dirty
      if (isDirty) {
        await saveDslWorkingCopy(projectId, agentName, dslContent);
        setOriginalContent(dslContent);
      }
      await create(changelog || undefined);
      setShowCreateDialog(false);
      setChangelog('');
    } catch {
      // Error handled by hook toast
    } finally {
      setIsCreating(false);
    }
  }, [projectId, agentName, dslContent, isDirty, changelog, create, setOriginalContent]);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-default bg-background-subtle shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted">Working Copy</span>
          {isDirty && (
            <span className="text-xs text-warning flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-warning" />
              Unsaved
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={
              isSaving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )
            }
            onClick={handleSave}
            disabled={!isDirty || isSaving}
          >
            Save
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
            onClick={() => {
              setShowCreateDialog(true);
              // Load model config preview
              apiFetch(
                `${getRuntimeUrl()}/api/projects/${projectId}/agents/${agentName}/model-config`,
                {
                  headers: { 'Content-Type': 'application/json' },
                },
              )
                .then((res) => res.json())
                .then((data) => {
                  if (data.config) setModelPreview(data.config);
                })
                .catch(() => setModelPreview(null));
              // Load tool preview
              setToolPreviewLoading(true);
              fetchToolPreview(projectId, agentName)
                .then((data) => setToolPreview(data.tools))
                .catch(() => setToolPreview(null))
                .finally(() => setToolPreviewLoading(false));
            }}
          >
            Create Version
          </Button>
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0">
        <ABLEditor onSave={handleSave} projectId={projectId} agentName={agentName} />
      </div>

      {/* Create version dialog */}
      <Dialog open={showCreateDialog} onClose={() => setShowCreateDialog(false)} maxWidth="sm">
        <div className="space-y-4">
          <div>
            <h3 className="text-lg font-semibold text-foreground">Create Version</h3>
            <p className="text-sm text-muted mt-1">
              Snapshot the current working copy as a new version.
              {isDirty && ' Unsaved changes will be saved first.'}
            </p>
          </div>

          <Input
            label="Changelog (optional)"
            placeholder="What changed in this version?"
            value={changelog}
            onChange={(e) => setChangelog(e.target.value)}
          />

          {/* Model Configuration Preview */}
          {modelPreview &&
            (modelPreview.defaultModel ||
              modelPreview.temperature != null ||
              modelPreview.maxTokens != null) && (
              <div className="p-3 rounded-lg bg-background-muted border border-default">
                <div className="flex items-center gap-1.5 mb-2">
                  <Brain className="w-3.5 h-3.5 text-accent" />
                  <span className="text-xs font-medium text-foreground">
                    Model Configuration (snapshotted)
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <p className="text-muted">Model</p>
                    <p className="text-foreground font-mono">
                      {modelPreview.defaultModel || 'Project default'}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted">Temperature</p>
                    <p className="text-foreground">{modelPreview.temperature ?? 'Default'}</p>
                  </div>
                  <div>
                    <p className="text-muted">Max Tokens</p>
                    <p className="text-foreground">{modelPreview.maxTokens ?? 'Default'}</p>
                  </div>
                </div>
              </div>
            )}

          {/* Tool Versions Preview */}
          {toolPreviewLoading ? (
            <div className="p-3 rounded-lg bg-background-muted border border-default">
              <div className="flex items-center gap-1.5">
                <Loader2 className="w-3.5 h-3.5 text-muted animate-spin" />
                <span className="text-xs text-muted">Loading tool versions…</span>
              </div>
            </div>
          ) : toolPreview && toolPreview.length > 0 ? (
            <div className="p-3 rounded-lg bg-background-muted border border-default">
              <div className="flex items-center gap-1.5 mb-2">
                <Wrench className="w-3.5 h-3.5 text-accent" />
                <span className="text-xs font-medium text-foreground">Tools to be Baked</span>
                <span className="text-xs text-muted ml-auto">
                  {toolPreview.length} tool{toolPreview.length !== 1 ? 's' : ''}
                  {toolPreview.some((t) => t.draftOnly) &&
                    ` · ${toolPreview.filter((t) => t.draftOnly).length} draft will be auto-published`}
                </span>
              </div>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {toolPreview.map((tool) => (
                  <div key={tool.toolId} className="flex items-center justify-between text-xs py-1">
                    <span className="text-foreground font-medium truncate">
                      {tool.toolName}
                      <span className="text-muted font-normal ml-1">({tool.toolType})</span>
                    </span>
                    {tool.draftOnly ? (
                      <Badge variant="warning">draft → v1</Badge>
                    ) : tool.publishedVersion ? (
                      <span className="text-muted shrink-0">
                        v{tool.publishedVersion.version}
                        {tool.publishedVersion.versionName && (
                          <span className="ml-1">{tool.publishedVersion.versionName}</span>
                        )}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex gap-3">
            <Button
              variant="secondary"
              onClick={() => setShowCreateDialog(false)}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreateVersion}
              loading={isCreating}
              className="flex-1"
            >
              Create Version
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
