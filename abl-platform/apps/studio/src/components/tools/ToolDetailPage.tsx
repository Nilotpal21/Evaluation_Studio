/**
 * ToolDetailPage Component
 *
 * Tool detail view with tabbed layout: Config, Test.
 *
 * Configuration tab renders inline-editable config forms (HttpConfigForm,
 * SandboxConfigForm, McpConfigForm). Dirty state shows Save/Discard buttons
 * in the header; clean state shows the Delete button.
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Download,
  Trash2,
  Loader2,
  Settings,
  Play,
  Pencil,
  Check,
  X,
  Calendar,
  User,
  Copy,
  Tag,
  Workflow,
  Package,
  Lock,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { SegmentedControl, type SegmentOption } from '../ui/SegmentedControl';
import { ToolTypeBadge } from './ToolTypeBadge';
import { ToolTestingSection } from './sections/ToolTestingSection';
import { TestToolDialog } from './TestToolDialog';
import { AuthProfileOAuthDialog } from '../auth-profiles/AuthProfileOAuthDialog';
import { HttpConfigForm, validateHttpConfig } from './HttpConfigForm';
import { SandboxConfigForm, validateSandboxConfig } from './SandboxConfigForm';
import { McpConfigForm, validateMcpConfig } from './McpConfigForm';
import {
  toolFormToHttpConfig,
  toolFormToSandboxConfig,
  toolFormToMcpConfig,
  httpConfigToToolForm,
  sandboxConfigToToolForm,
  mcpConfigToToolForm,
} from './form-adapters';
import { buildInputSchemaFromTool } from './tool-utils';
import { useToolStore, type ToolWithVersion, type ToolTestResult } from '../../store/tool-store';
import { useProjectStore } from '../../store/project-store';
import { useNavigationStore } from '../../store/navigation-store';
import { fetchTool, updateTool, deleteTool, exportTool, testTool } from '../../api/tools';
import { fetchVariableNamespaces, type VariableNamespace } from '../../api/variable-namespaces';
import { sanitizeError, sanitizeErrors } from '../../lib/sanitize-error';
import { ErrorAlert } from '../ui/ErrorAlert';
import { toast } from 'sonner';
import { parseDslToToolForm, parseDslProperties } from '@agent-platform/shared/tools';
import { serializeToolFormToDsl } from '@agent-platform/shared/tools';
import type { ProjectToolFormData } from '@agent-platform/shared/types';
import type { HttpConfig, SandboxConfig, McpConfig, AnyToolConfig } from './shared-types';
import { useFeatures } from '../../hooks/use-features';
import { maskRawDslForDisplay } from '../../utils/mask-sensitive-data';

const FORCE_DELETE_HINT = 'Use ?force=true to delete anyway.';

function isForceDeleteConflict(error: unknown): error is Error & { statusCode?: number } {
  return (
    error instanceof Error &&
    'statusCode' in error &&
    (error as { statusCode?: number }).statusCode === 409 &&
    error.message.includes(FORCE_DELETE_HINT)
  );
}

function extractDependentAgents(message: string): string[] {
  const marker = 'agent(s): ';
  const markerIndex = message.indexOf(marker);
  if (markerIndex === -1) return [];

  const namesSegment = message
    .slice(markerIndex + marker.length)
    .replace(`. ${FORCE_DELETE_HINT}`, '')
    .trim();

  if (!namesSegment) return [];

  return namesSegment
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

interface ToolDetailPageProps {
  readOnly?: boolean;
  moduleProvenance?: { alias: string; moduleProjectName: string; version: string };
}

export function ToolDetailPage({ readOnly, moduleProvenance }: ToolDetailPageProps = {}) {
  const t = useTranslations('tools.detail');
  const { currentProject } = useProjectStore();
  const { navigate, subPage: toolId } = useNavigationStore();
  const { currentTool, setCurrentTool, removeTool } = useToolStore();
  const { hasCodeTools } = useFeatures();

  const sectionOptions = useMemo(() => {
    const options: SegmentOption[] = [
      {
        id: 'configuration',
        label: t('section_configuration'),
        icon: <Settings className="w-3.5 h-3.5" />,
      },
    ];
    if (currentTool?.toolType !== 'searchai' && currentTool?.toolType !== 'workflow') {
      options.push({
        id: 'testing',
        label: t('section_testing'),
        icon: <Play className="w-3.5 h-3.5" />,
      });
    }
    return options;
  }, [currentTool?.toolType, t]);

  const projectId = currentProject?.id;

  // Guard: If toolId is 'new', redirect back to tools list (shouldn't happen but safety check)
  useEffect(() => {
    if (toolId === 'new' && projectId) {
      navigate(`/projects/${projectId}/tools`);
    }
  }, [toolId, projectId, navigate]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | string[] | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [forceDeleteOpen, setForceDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dependentAgents, setDependentAgents] = useState<string[]>([]);

  // Section navigation state
  const [activeSection, setActiveSection] = useState<string>('configuration');

  // Test dialog state
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [latestTestResult, setLatestTestResult] = useState<ToolTestResult | null>(null);
  const [oauthReconnectContext, setOauthReconnectContext] = useState<NonNullable<
    ToolTestResult['oauthReauth']
  > | null>(null);
  const [oauthReconnectOpen, setOauthReconnectOpen] = useState(false);

  // Inline editing state for header (name + description)
  const [editingName, setEditingName] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const descInputRef = useRef<HTMLTextAreaElement>(null);

  // Namespace state
  const [variableNamespaces, setVariableNamespaces] = useState<VariableNamespace[]>([]);
  const [toolVariableNamespaceIds, setToolVariableNamespaceIds] = useState<string[]>([]);
  const [savingVariableNamespaces, setSavingVariableNamespaces] = useState(false);

  // Inline config editing state
  const [parsedForm, setParsedForm] = useState<ProjectToolFormData | null>(null);
  const [dslContent, setDslContent] = useState('');
  const maskedDslContent = useMemo(() => maskRawDslForDisplay(dslContent), [dslContent]);
  const [editingConfig, setEditingConfig] = useState<AnyToolConfig | null>(null);
  const initialConfigRef = useRef<AnyToolConfig | null>(null);
  const [configErrors, setConfigErrors] = useState<Record<string, string>>({});

  const isDirty = useMemo(() => {
    if (!editingConfig || !initialConfigRef.current) return false;
    return JSON.stringify(editingConfig) !== JSON.stringify(initialConfigRef.current);
  }, [editingConfig]);

  const loadTool = useCallback(async () => {
    if (!projectId || !toolId) return;

    setLoading(true);
    setError(null);

    try {
      const result = await fetchTool(projectId, toolId);
      const tool: ToolWithVersion = result.tool as ToolWithVersion;
      setCurrentTool(tool);
      setToolVariableNamespaceIds(tool.variableNamespaceIds || []);

      // Populate DSL content
      const dsl = tool.dslContent || '';
      setDslContent(dsl);

      // Parse DSL into form data for structured view
      // SearchAI and workflow tools are auto-managed — skip form parsing, show read-only view
      let form: ProjectToolFormData | null = null;
      if (tool.toolType !== 'searchai' && tool.toolType !== 'workflow') {
        const toolType = tool.toolType as 'http' | 'sandbox' | 'mcp';
        form = parseDslToToolForm(dsl, toolType);
      }
      setParsedForm(form);

      // Populate inline editable fields
      setEditName(tool.name);
      setEditDescription(tool.description || '');

      // Initialize editable config from parsed form
      let config: AnyToolConfig | null = null;
      if (form) {
        switch (form.toolType) {
          case 'http':
            config = toolFormToHttpConfig(form);
            break;
          case 'sandbox':
            config = toolFormToSandboxConfig(form);
            break;
          case 'mcp':
            config = toolFormToMcpConfig(form);
            break;
        }
      }
      setEditingConfig(config);
      initialConfigRef.current = config ? JSON.parse(JSON.stringify(config)) : null;
      setConfigErrors({});
    } catch (err) {
      setError(sanitizeErrors(err, 'Failed to load tool'));
    } finally {
      setLoading(false);
    }
  }, [projectId, toolId, setCurrentTool]);

  useEffect(() => {
    loadTool();
  }, [loadTool]);

  useEffect(() => {
    if (!projectId) return;
    fetchVariableNamespaces(projectId)
      .then((data) => setVariableNamespaces(data.namespaces || []))
      .catch((err) => {
        console.error('Failed to load variable namespaces:', err);
        toast.error(sanitizeError(err, 'Failed to load variable namespaces'));
      });
  }, [projectId]);

  const handleToggleVariableNamespace = async (nsId: string) => {
    if (!projectId || !toolId) return;
    setSavingVariableNamespaces(true);
    try {
      const current = toolVariableNamespaceIds;
      const updated = current.includes(nsId)
        ? current.filter((id) => id !== nsId)
        : [...current, nsId];
      await updateTool(projectId, toolId, { variableNamespaceIds: updated });
      setToolVariableNamespaceIds(updated);
      useToolStore.getState().updateToolInList(toolId, { variableNamespaceIds: updated });
      toast.success('Variable namespace assignment updated');
    } catch (err) {
      toast.error(sanitizeError(err, 'Failed to update variable namespaces'));
    } finally {
      setSavingVariableNamespaces(false);
    }
  };

  // ─── Unified config save / discard handlers ────────────────────────
  const handleConfigSave = async () => {
    if (!projectId || !toolId || !currentTool || !editingConfig || !parsedForm) return;

    const toolType = currentTool.toolType as 'http' | 'sandbox' | 'mcp';
    let errors: Record<string, string> = {};
    if (toolType === 'http') errors = validateHttpConfig(editingConfig as HttpConfig);
    else if (toolType === 'sandbox') errors = validateSandboxConfig(editingConfig as SandboxConfig);
    else if (toolType === 'mcp') errors = validateMcpConfig(editingConfig as McpConfig);

    if (Object.keys(errors).length > 0) {
      setConfigErrors(errors);
      return;
    }

    setSaving(true);
    setError(null);
    setConfigErrors({});

    try {
      let formData: ProjectToolFormData;
      switch (toolType) {
        case 'http':
          formData = httpConfigToToolForm(
            currentTool.name,
            currentTool.description,
            editingConfig as HttpConfig,
            parsedForm.toolType === 'http' ? parsedForm : null,
          );
          break;
        case 'sandbox':
          formData = sandboxConfigToToolForm(
            currentTool.name,
            currentTool.description,
            editingConfig as SandboxConfig,
            parsedForm.toolType === 'sandbox' ? parsedForm : null,
          );
          break;
        case 'mcp':
          formData = mcpConfigToToolForm(
            currentTool.name,
            currentTool.description,
            editingConfig as McpConfig,
            parsedForm.toolType === 'mcp' ? parsedForm : null,
          );
          break;
      }

      const newDsl = serializeToolFormToDsl(formData);
      await updateTool(projectId, toolId, {
        dslContent: newDsl,
      });
      await loadTool();
      toast.success(t('tool_saved'));
    } catch (err) {
      setError(sanitizeErrors(err, 'Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  const handleConfigDiscard = () => {
    if (initialConfigRef.current) {
      setEditingConfig(JSON.parse(JSON.stringify(initialConfigRef.current)));
      setConfigErrors({});
    }
  };

  const handleExport = async () => {
    if (!projectId || !toolId || !currentTool) return;

    setExporting(true);
    try {
      const result = await exportTool(projectId, toolId);
      const blob = new Blob([JSON.stringify(result.export, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${currentTool.slug}.tool.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toast.success(t('export_success'));
    } catch (err) {
      toast.error(sanitizeError(err, t('export_failed')));
    } finally {
      setExporting(false);
    }
  };

  const handleDelete = async (force = false) => {
    if (!projectId || !toolId) return;

    setDeleting(true);
    setError(null);

    try {
      await deleteTool(projectId, toolId, force ? { force: true } : undefined);
      removeTool(toolId);
      toast.success(force ? t('force_delete_success') : t('delete_success'));
      navigate(`/projects/${projectId}/tools`);
    } catch (err) {
      if (!force && isForceDeleteConflict(err)) {
        setDependentAgents(extractDependentAgents(err.message));
        setForceDeleteOpen(true);
      } else {
        setError(
          sanitizeErrors(err, force ? t('force_delete_failed') : t('failed_to_delete_tool')),
        );
      }
    } finally {
      setDeleting(false);
      if (force) {
        setForceDeleteOpen(false);
      } else {
        setDeleteOpen(false);
      }
    }
  };

  const handleTest = async (input: Record<string, unknown>): Promise<ToolTestResult> => {
    if (!projectId || !toolId) throw new Error('Missing project or tool');
    const result = await testTool(projectId, toolId, input);
    return result.result;
  };

  const handleTestComplete = (result: ToolTestResult) => {
    setLatestTestResult(result);
  };

  const handleClearTestResult = () => {
    setLatestTestResult(null);
  };

  const handleReconnectProfile = (reauth: NonNullable<ToolTestResult['oauthReauth']>) => {
    setOauthReconnectContext(reauth);
    setOauthReconnectOpen(true);
  };

  const startEditingName = () => {
    if (!currentTool) return;
    setEditName(currentTool.name);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 0);
  };

  const startEditingDescription = () => {
    if (!currentTool) return;
    setEditDescription(currentTool.description || '');
    setEditingDescription(true);
    setTimeout(() => descInputRef.current?.focus(), 0);
  };

  const cancelEditName = () => {
    setEditingName(false);
    setEditName('');
  };

  const cancelEditDescription = () => {
    setEditingDescription(false);
    setEditDescription('');
  };

  const saveInlineName = async () => {
    if (!projectId || !toolId || !currentTool) return;
    const trimmed = editName.trim();
    if (trimmed.length < 2) {
      setError(t('name_min_length'));
      return;
    }
    if (trimmed === currentTool.name) {
      setEditingName(false);
      return;
    }
    setSavingMeta(true);
    setError(null);
    try {
      // Regenerate DSL with the new name so the signature line stays in sync
      const updatePayload: Record<string, unknown> = { name: trimmed };
      if (parsedForm) {
        const updatedForm = { ...parsedForm, name: trimmed };
        updatePayload.dslContent = serializeToolFormToDsl(updatedForm);
      }
      await updateTool(projectId, toolId, updatePayload);
      await loadTool();
      setEditingName(false);
      toast.success(t('name_updated'));
    } catch (err) {
      setError(sanitizeErrors(err, 'Failed to update name'));
    } finally {
      setSavingMeta(false);
    }
  };

  const saveInlineDescription = async () => {
    if (!projectId || !toolId || !currentTool) return;
    const trimmed = editDescription.trim();
    if (trimmed === currentTool.description) {
      setEditingDescription(false);
      return;
    }
    setSavingMeta(true);
    setError(null);
    try {
      // Regenerate DSL with the new description so the DSL description field stays in sync
      const updatePayload: Record<string, unknown> = { description: trimmed || null };
      if (parsedForm) {
        const updatedForm = { ...parsedForm, description: trimmed || '' };
        updatePayload.dslContent = serializeToolFormToDsl(updatedForm);
      }
      await updateTool(projectId, toolId, updatePayload);
      await loadTool();
      setEditingDescription(false);
      toast.success(t('description_updated'));
    } catch (err) {
      setError(sanitizeErrors(err, 'Failed to update description'));
    } finally {
      setSavingMeta(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 text-muted animate-spin" />
      </div>
    );
  }

  if (!currentTool) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-sm text-muted">{error || t('tool_not_found_text')}</p>
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() => projectId && navigate(`/projects/${projectId}/tools`)}
          >
            {t('back_to_tools_link')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {/* Header */}
        <div className="mb-6">
          <button
            onClick={() => projectId && navigate(`/projects/${projectId}/tools`)}
            className="flex items-center gap-1 text-sm text-muted hover:text-foreground transition-default mb-4"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('back_link')}
          </button>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              {/* Title row: inline-editable name + tool type badge */}
              <div className="flex items-center gap-2.5">
                {editingName ? (
                  <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    <input
                      ref={nameInputRef}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveInlineName();
                        if (e.key === 'Escape') cancelEditName();
                      }}
                      className="flex-1 min-w-0 text-2xl font-semibold text-foreground tracking-tight bg-transparent border-b-2 border-accent outline-none py-0.5"
                      disabled={savingMeta}
                    />
                    <button
                      onClick={saveInlineName}
                      disabled={savingMeta}
                      className="p-1 rounded text-success hover:bg-success-subtle transition-default"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    <button
                      onClick={cancelEditName}
                      disabled={savingMeta}
                      className="p-1 rounded text-muted hover:bg-background-muted transition-default"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ) : currentTool.toolType !== 'searchai' && !readOnly ? (
                  <h1
                    className="text-2xl font-semibold text-foreground truncate tracking-tight cursor-pointer group flex items-center gap-1.5 hover:text-accent transition-default"
                    onClick={startEditingName}
                    title={t('click_edit_name')}
                  >
                    {currentTool.name}
                    <Pencil className="w-3.5 h-3.5 opacity-0 group-hover:opacity-60 transition-default shrink-0" />
                  </h1>
                ) : (
                  <h1 className="text-2xl font-semibold text-foreground truncate tracking-tight">
                    {currentTool.name}
                  </h1>
                )}
                <ToolTypeBadge type={currentTool.toolType} className="shrink-0" />
              </div>

              {/* Description: inline-editable below title */}
              <div className="mt-2">
                {editingDescription ? (
                  <div className="flex items-start gap-1.5">
                    <textarea
                      ref={descInputRef}
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveInlineDescription();
                        if (e.key === 'Escape') cancelEditDescription();
                      }}
                      rows={2}
                      className="flex-1 text-sm text-muted bg-transparent border-b-2 border-accent outline-none resize-none py-0.5"
                      placeholder={t('add_description')}
                      disabled={savingMeta}
                    />
                    <button
                      onClick={saveInlineDescription}
                      disabled={savingMeta}
                      className="p-1 rounded text-success hover:bg-success-subtle transition-default mt-0.5"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={cancelEditDescription}
                      disabled={savingMeta}
                      className="p-1 rounded text-muted hover:bg-background-muted transition-default mt-0.5"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : readOnly ? (
                  <p className="text-sm text-muted">
                    {currentTool.description || t('add_description')}
                  </p>
                ) : (
                  <p
                    className="text-sm text-muted cursor-pointer group flex items-center gap-1.5 hover:text-foreground transition-default"
                    onClick={startEditingDescription}
                    title={t('click_edit_description')}
                  >
                    {currentTool.description || t('add_description')}
                    <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-60 transition-default shrink-0" />
                  </p>
                )}
              </div>

              {/* Slug display with copy-to-clipboard */}
              <div className="mt-2 flex items-center gap-2">
                <span className="text-xs text-muted">slug:</span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(currentTool.slug);
                    toast.success(t('slug_copied'));
                  }}
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-background-muted hover:bg-background-subtle border border-default text-xs font-mono text-foreground transition-default"
                  title={t('copy_slug')}
                >
                  {currentTool.slug}
                  <Copy className="w-3 h-3 text-muted" />
                </button>
              </div>

              <div className="flex items-center gap-4 mt-2 text-xs text-muted flex-wrap">
                <span className="inline-flex items-center gap-1.5">
                  <Calendar className="w-3 h-3" />
                  {t('created_label')} {new Date(currentTool.createdAt).toLocaleDateString()}
                  {currentTool.createdBy && (
                    <span className="inline-flex items-center gap-1 ml-0.5">
                      <User className="w-3 h-3" /> {currentTool.createdBy}
                    </span>
                  )}
                </span>
                <span className="text-border">|</span>
                <span className="inline-flex items-center gap-1.5">
                  <Pencil className="w-3 h-3" />
                  {t('updated_label')} {new Date(currentTool.updatedAt).toLocaleDateString()}
                  {currentTool.lastEditedBy && (
                    <span className="inline-flex items-center gap-1 ml-0.5">
                      <User className="w-3 h-3" /> {currentTool.lastEditedBy}
                    </span>
                  )}
                </span>
              </div>
            </div>
            {!readOnly && (
              <AnimatePresence mode="wait">
                {activeSection === 'configuration' && isDirty ? (
                  <motion.div
                    key="save-actions"
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 12 }}
                    transition={{ duration: 0.15 }}
                    className="flex items-center gap-2 shrink-0"
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleConfigDiscard}
                      disabled={saving}
                    >
                      {t('discard_changes')}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleConfigSave}
                      loading={saving}
                      disabled={!hasCodeTools && currentTool?.toolType === 'sandbox'}
                      data-testid="save-tool-button"
                    >
                      {t('save_changes')}
                    </Button>
                  </motion.div>
                ) : activeSection === 'configuration' && currentTool.toolType !== 'searchai' ? (
                  <motion.div
                    key="delete-action"
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 12 }}
                    transition={{ duration: 0.15 }}
                    className="flex items-center gap-2 shrink-0"
                  >
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Download className="w-4 h-4" />}
                      onClick={handleExport}
                      loading={exporting}
                    >
                      {t('export_button')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Trash2 className="w-4 h-4" />}
                      onClick={() => setDeleteOpen(true)}
                      disabled={exporting}
                    >
                      {t('delete_button')}
                    </Button>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            )}
          </div>
        </div>

        {error && <ErrorAlert error={error} onDismiss={() => setError(null)} className="mb-4" />}

        {/* Module provenance banner */}
        {readOnly && moduleProvenance && (
          <div className="mb-4 rounded-lg border border-accent/30 bg-accent/10 p-3 flex items-center gap-2">
            <Package className="w-4 h-4 text-accent" />
            <span className="text-sm">
              Imported from <strong>{moduleProvenance.moduleProjectName}</strong> (
              {moduleProvenance.alias}) v{moduleProvenance.version}
            </span>
            <Lock className="w-3.5 h-3.5 text-muted-foreground ml-auto" />
            <span className="text-xs text-muted-foreground">Read-only</span>
          </div>
        )}

        {!hasCodeTools && currentTool?.toolType === 'sandbox' && (
          <div className="mb-4 rounded-lg border border-warning/25 bg-warning/10 px-4 py-3 text-sm text-warning">
            {t('code_tools_disabled_warning')}
          </div>
        )}

        {Object.keys(configErrors).length > 0 && (
          <div className="mb-4 rounded-lg border border-error/30 bg-error-subtle p-3">
            <p className="text-sm font-medium text-error mb-1">{t('config_errors_title')}</p>
            <ul className="text-sm text-error list-disc list-inside space-y-0.5">
              {Object.entries(configErrors).map(([key, msg]) => (
                <li key={key}>{msg}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Segmented Control Navigation */}
        <div className="flex justify-center mb-6">
          <SegmentedControl
            options={sectionOptions}
            value={activeSection}
            onChange={setActiveSection}
            size="md"
          />
        </div>

        {/* Animated Section Content */}
        <div className="relative min-h-[400px] rounded-lg border border-default bg-background-elevated p-5 sm:p-6">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeSection}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{
                type: 'spring',
                stiffness: 300,
                damping: 30,
              }}
            >
              {activeSection === 'configuration' && currentTool.toolType === 'workflow' && (
                <div className="space-y-6" data-testid="workflow-binding-panel">
                  <div className="rounded-lg border border-default bg-background-subtle p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Workflow className="w-4 h-4 text-muted" />
                      <h3 className="text-sm font-medium text-foreground">
                        {t('workflow_binding_title')}
                      </h3>
                    </div>
                    <p className="text-xs text-muted mb-4">{t('workflow_binding_description')}</p>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-xs font-medium text-muted uppercase tracking-wider">
                          {t('workflow_tool_name')}
                        </span>
                        <div className="font-mono text-foreground mt-1">{currentTool.name}</div>
                      </div>
                      <div>
                        <span className="text-xs font-medium text-muted uppercase tracking-wider">
                          {t('workflow_tool_type')}
                        </span>
                        <div className="text-foreground mt-1">{t('workflow_tool_type_value')}</div>
                      </div>
                    </div>
                    {dslContent && (
                      <div className="mt-4">
                        <span className="text-xs font-medium text-muted uppercase tracking-wider">
                          {t('workflow_dsl')}
                        </span>
                        <pre className="mt-1 p-3 rounded bg-background text-xs font-mono text-foreground-muted overflow-x-auto whitespace-pre-wrap">
                          {maskedDslContent}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {activeSection === 'configuration' && currentTool.toolType === 'searchai' && (
                <div className="space-y-6">
                  <div className="rounded-lg border border-default bg-background-subtle p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Settings className="w-4 h-4 text-muted" />
                      <h3 className="text-sm font-medium text-foreground">
                        {t('searchai_binding_title')}
                      </h3>
                    </div>
                    <p className="text-xs text-muted mb-4">{t('searchai_binding_description')}</p>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-xs font-medium text-muted uppercase tracking-wider">
                          {t('searchai_tool_name')}
                        </span>
                        <div className="font-mono text-foreground mt-1">{currentTool.name}</div>
                      </div>
                      <div>
                        <span className="text-xs font-medium text-muted uppercase tracking-wider">
                          {t('searchai_tool_type')}
                        </span>
                        <div className="text-foreground mt-1">{t('searchai_tool_type_value')}</div>
                      </div>
                    </div>
                    {dslContent && (
                      <div className="mt-4">
                        <span className="text-xs font-medium text-muted uppercase tracking-wider">
                          {t('searchai_dsl')}
                        </span>
                        <pre className="mt-1 p-3 rounded bg-background text-xs font-mono text-foreground-muted overflow-x-auto whitespace-pre-wrap">
                          {maskedDslContent}
                        </pre>
                      </div>
                    )}
                    {projectId && (
                      <div className="mt-4 pt-4 border-t border-default">
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<ArrowUpRight className="w-3.5 h-3.5" />}
                          onClick={() => navigate(`/projects/${projectId}/search-ai`)}
                        >
                          {t('view_knowledge_base')}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {activeSection === 'configuration' &&
                editingConfig &&
                currentTool.toolType !== 'searchai' &&
                currentTool.toolType !== 'workflow' && (
                  <div className={`space-y-6${readOnly ? ' pointer-events-none opacity-70' : ''}`}>
                    {currentTool.toolType === 'http' && (
                      <HttpConfigForm
                        config={editingConfig as HttpConfig}
                        onChange={(config) => setEditingConfig(config)}
                        showTemplates={false}
                        projectId={currentTool.projectId}
                      />
                    )}
                    {currentTool.toolType === 'sandbox' && (
                      <SandboxConfigForm
                        config={editingConfig as SandboxConfig}
                        onChange={(config) => setEditingConfig(config)}
                        showTemplates={false}
                      />
                    )}
                    {currentTool.toolType === 'mcp' && (
                      <McpConfigForm
                        config={editingConfig as McpConfig}
                        onChange={(config) => setEditingConfig(config)}
                      />
                    )}

                    {/* Environment Variable Namespaces */}
                    {variableNamespaces.length > 0 && (
                      <div className="rounded-lg border border-default bg-background-subtle p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <Tag className="w-4 h-4 text-muted" />
                          <h3 className="text-sm font-medium text-foreground">
                            {t('variable_namespaces_title')}
                          </h3>
                        </div>
                        <p className="text-xs text-muted mb-3">
                          {t('variable_namespaces_description')}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {variableNamespaces
                            .sort((a, b) => a.order - b.order)
                            .map((ns) => {
                              const isAssigned = toolVariableNamespaceIds.includes(ns.id);
                              return (
                                <button
                                  key={ns.id}
                                  type="button"
                                  onClick={() => handleToggleVariableNamespace(ns.id)}
                                  disabled={savingVariableNamespaces}
                                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-default border ${
                                    isAssigned
                                      ? 'bg-accent/10 border-accent/40 text-accent font-medium'
                                      : 'bg-background-muted border-default text-muted hover:text-foreground hover:border-accent/30'
                                  } ${savingVariableNamespaces ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                                  title={
                                    isAssigned
                                      ? `Remove from ${ns.displayName}`
                                      : `Add to ${ns.displayName}`
                                  }
                                >
                                  <span
                                    className="w-2 h-2 rounded-full shrink-0"
                                    style={{
                                      backgroundColor: ns.color || 'var(--color-muted)',
                                    }}
                                  />
                                  {ns.displayName}
                                  {isAssigned && <Check className="w-3 h-3" />}
                                </button>
                              );
                            })}
                        </div>
                        {toolVariableNamespaceIds.length === 0 && (
                          <p className="text-xs text-muted/60 mt-2 italic">
                            {t('variable_namespaces_empty')}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Collapsible DSL preview */}
                    <details className="group">
                      <summary className="text-xs font-medium text-muted cursor-pointer hover:text-foreground transition-default select-none flex items-center gap-1">
                        <span className="group-open:rotate-90 transition-transform inline-block">
                          &#9654;
                        </span>
                        {t('view_raw_dsl')}
                      </summary>
                      <pre className="mt-2 p-3 rounded-lg bg-background-muted border border-default text-xs font-mono overflow-x-auto whitespace-pre-wrap max-h-64 overflow-y-auto">
                        {maskedDslContent}
                      </pre>
                    </details>
                  </div>
                )}

              {activeSection === 'configuration' &&
                !editingConfig &&
                currentTool.toolType !== 'searchai' &&
                currentTool.toolType !== 'workflow' && (
                  <div className="text-sm text-muted text-center py-8">
                    {t('parse_failed_fallback')}
                    <pre className="mt-4 p-4 rounded-lg bg-background-muted border border-default text-xs font-mono overflow-x-auto whitespace-pre-wrap text-left">
                      {maskedDslContent}
                    </pre>
                  </div>
                )}

              {activeSection === 'testing' && (
                <ToolTestingSection
                  projectId={projectId}
                  toolId={toolId}
                  latestTestResult={latestTestResult}
                  onTestClick={() => setTestDialogOpen(true)}
                  onRerunTest={() => setTestDialogOpen(true)}
                  onClearResult={handleClearTestResult}
                  onReconnectProfile={handleReconnectProfile}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Test Tool Dialog */}
        {currentTool && (
          <TestToolDialog
            open={testDialogOpen}
            onClose={() => setTestDialogOpen(false)}
            tool={currentTool}
            inputSchema={buildInputSchemaFromTool(currentTool)}
            onTest={handleTest}
            onTestComplete={handleTestComplete}
          />
        )}

        {oauthReconnectContext && (
          <AuthProfileOAuthDialog
            open={oauthReconnectOpen}
            onClose={() => setOauthReconnectOpen(false)}
            projectId={currentTool.projectId}
            authProfileId={oauthReconnectContext.authProfileId}
            connectorName={oauthReconnectContext.connectorName}
            displayName={`${oauthReconnectContext.profileName} token`}
            onSuccess={() => setOauthReconnectOpen(false)}
          />
        )}

        {/* Delete confirmation */}
        <ConfirmDialog
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          onConfirm={() => void handleDelete()}
          title={t('delete_title')}
          description={t('delete_description', { name: currentTool.name })}
          confirmLabel={t('delete_confirm_label')}
          variant="danger"
          loading={deleting}
        />

        <ConfirmDialog
          open={forceDeleteOpen}
          onClose={() => !deleting && setForceDeleteOpen(false)}
          onConfirm={() => void handleDelete(true)}
          title={t('force_delete_title')}
          description={t('force_delete_description')}
          confirmLabel={t('force_delete_confirm_label')}
          variant="danger"
          loading={deleting}
        >
          {dependentAgents.length > 0 && (
            <div className="w-full mb-6 rounded-lg border border-warning/30 bg-warning-subtle/30 p-3 text-left">
              <p className="text-xs font-medium uppercase tracking-wide text-warning">
                {t('force_delete_agents_label')}
              </p>
              <ul className="mt-2 space-y-1 text-sm text-foreground">
                {dependentAgents.map((agentName) => (
                  <li key={agentName} className="font-mono">
                    {agentName}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </ConfirmDialog>
      </div>
    </div>
  );
}
