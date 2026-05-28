'use client';

/**
 * ToolsEditor -- section editor for tool definitions.
 *
 * Full inline editing: name, description, parameters (add/remove/type/required),
 * returns type, binding display, and add/remove tool.
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  Wrench,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Globe,
  Server,
  Box,
  BookOpen,
  Loader2,
  ExternalLink,
  Package,
  Lock,
} from 'lucide-react';
import clsx from 'clsx';
import { Checkbox } from '../../ui/Checkbox';
import { ToolTypeBadge } from '../../tools/ToolTypeBadge';
import { fetchTools } from '../../../api/tools';
import { parseSignatureLine, parseDslProperties } from '@agent-platform/shared/tools';
import { useAgentEditorStore } from '../hooks/useAgentEditorStore';
import { useNavigationStore } from '../../../store/navigation-store';
import { Select } from '../../ui/Select';
import type { SectionEditorProps, ToolSectionData } from '../types';
import type { ToolParameterData } from '../../../store/agent-detail-store';
import type { ToolType, ToolWithVersion } from '../../../store/tool-store';
import { SectionHeader } from './SectionHeader';
import { useFeatures } from '../../../hooks/use-features';
import { useImportedSymbols } from '../../../hooks/useImportedSymbols';
import { buildMountedModuleToolName } from '../../abl/tool-snippets';
import { appendReturnTo, buildAgentToolsReturnPath } from '../../tools/return-navigation';

// =============================================================================
// CONSTANTS
// =============================================================================

const BINDING_LABELS: Record<string, string> = {
  http: 'HTTP',
  mcp: 'MCP',
  sandbox: 'Sandbox',
  lambda: 'Lambda',
  searchai: 'Knowledge Base',
};

const BINDING_ICONS: Record<string, React.ElementType> = {
  http: Globe,
  mcp: Server,
  sandbox: Box,
  lambda: Box,
  searchai: BookOpen,
};

const PARAMETER_TYPES = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'boolean', label: 'boolean' },
  { value: 'object', label: 'object' },
  { value: 'array', label: 'array' },
  { value: 'date', label: 'date' },
] as const;

const INPUT_CLASSES = clsx(
  'w-full px-2 py-1.5 text-xs rounded-md bg-background border border-default text-foreground',
  'placeholder:text-foreground-subtle focus:outline-none focus:ring-2 focus:ring-border-focus/40',
  'focus:border-border-focus transition-default',
);

// =============================================================================
// EDITABLE TOOL CARD
// =============================================================================

interface EditableToolCardProps {
  tool: ToolSectionData;
  index: number;
  onChange: (index: number, tool: ToolSectionData) => void;
  onRemove: (index: number) => void;
  readOnly?: boolean;
}

function EditableToolCard({ tool, index, onChange, onRemove, readOnly }: EditableToolCardProps) {
  const t = useTranslations('agent_editor.tools');
  const [expanded, setExpanded] = useState(false);
  const BindingIcon = tool.toolType ? (BINDING_ICONS[tool.toolType] ?? Wrench) : Wrench;
  const bindingLabel = tool.toolType ? (BINDING_LABELS[tool.toolType] ?? tool.toolType) : null;

  const updateField = useCallback(
    (field: string, value: unknown) => {
      onChange(index, { ...tool, [field]: value });
    },
    [tool, index, onChange],
  );

  const updateParam = useCallback(
    (paramIdx: number, updated: ToolParameterData) => {
      const next = [...tool.parameters];
      next[paramIdx] = updated;
      updateField('parameters', next);
    },
    [tool.parameters, updateField],
  );

  const removeParam = useCallback(
    (paramIdx: number) => {
      updateField(
        'parameters',
        tool.parameters.filter((_, i) => i !== paramIdx),
      );
    },
    [tool.parameters, updateField],
  );

  const addParam = useCallback(() => {
    updateField('parameters', [...tool.parameters, { name: '', type: 'string', required: false }]);
  }, [tool.parameters, updateField]);

  return (
    <div className="rounded-lg border border-default bg-background-muted overflow-hidden shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 p-0.5 rounded hover:bg-background-elevated transition-default"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-foreground-muted" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-foreground-muted" />
          )}
        </button>
        <BindingIcon className="w-4 h-4 text-accent shrink-0" />
        <span className="font-mono text-sm font-medium text-foreground truncate flex-1">
          {tool.name || t('unnamed_tool')}
        </span>
        {bindingLabel && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent font-medium shrink-0">
            {bindingLabel}
          </span>
        )}
        <span className="text-xs text-foreground-muted shrink-0">
          {t('params_count', { count: tool.parameters.length })}
        </span>
        {!readOnly && (
          <button
            type="button"
            onClick={() => onRemove(index)}
            className="p-1 rounded hover:bg-error-subtle text-foreground-muted hover:text-error transition-default shrink-0"
            title={t('action_remove')}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Collapsed description */}
      {!expanded && tool.description && (
        <div className="px-3 pb-2 -mt-0.5">
          <p className="text-xs text-foreground-muted truncate pl-8">{tool.description}</p>
        </div>
      )}

      {/* Expanded editing */}
      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-default pt-3">
          {/* Tool name */}
          <div>
            <label className="text-xs font-semibold text-foreground-muted uppercase tracking-wider block mb-1">
              {t('label_name')}
            </label>
            <input
              type="text"
              value={tool.name}
              onChange={(e) => updateField('name', e.target.value)}
              placeholder={t('placeholder_tool_name')}
              className={clsx(INPUT_CLASSES, 'font-mono')}
              readOnly={readOnly}
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-semibold text-foreground-muted uppercase tracking-wider block mb-1">
              {t('label_description')}
            </label>
            <textarea
              value={tool.description}
              onChange={(e) => updateField('description', e.target.value)}
              placeholder={t('placeholder_description')}
              rows={2}
              className={clsx(INPUT_CLASSES, 'resize-y')}
              readOnly={readOnly}
            />
          </div>

          {/* Returns */}
          <div>
            <label className="text-xs font-semibold text-foreground-muted uppercase tracking-wider block mb-1">
              {t('label_returns')}
            </label>
            <input
              type="text"
              value={tool.returns.type}
              onChange={(e) => updateField('returns', { type: e.target.value })}
              placeholder={t('placeholder_returns')}
              className={clsx(INPUT_CLASSES, 'font-mono')}
              readOnly={readOnly}
            />
          </div>

          {/* Parameters */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
                {t('label_parameters')} ({tool.parameters.length})
              </label>
              {!readOnly && (
                <button
                  type="button"
                  onClick={addParam}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium text-accent hover:bg-accent-subtle transition-default"
                >
                  <Plus className="w-3 h-3" />
                  {t('action_add')}
                </button>
              )}
            </div>

            {tool.parameters.length === 0 ? (
              <p className="text-xs text-foreground-muted italic py-1">{t('no_parameters')}</p>
            ) : (
              <div className="space-y-2">
                {tool.parameters.map((param, paramIdx) => (
                  <div
                    key={paramIdx}
                    className="flex items-center gap-2 rounded-md bg-background px-2 py-1.5"
                  >
                    <input
                      type="text"
                      value={param.name}
                      onChange={(e) => updateParam(paramIdx, { ...param, name: e.target.value })}
                      placeholder="param_name"
                      className="flex-1 text-xs font-mono bg-transparent text-foreground focus:outline-none placeholder:text-foreground-subtle min-w-0"
                      readOnly={readOnly}
                    />
                    <div className="shrink-0 w-24">
                      <Select
                        options={PARAMETER_TYPES as unknown as { value: string; label: string }[]}
                        value={param.type}
                        onChange={(v) => updateParam(paramIdx, { ...param, type: v })}
                        disabled={readOnly}
                      />
                    </div>
                    <Checkbox
                      checked={param.required}
                      onChange={(checked) => updateParam(paramIdx, { ...param, required: checked })}
                      disabled={readOnly}
                      label={t('req_label')}
                      className="shrink-0"
                    />
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={() => removeParam(paramIdx)}
                        className="p-0.5 rounded hover:bg-error-subtle text-foreground-muted hover:text-error transition-default shrink-0"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Binding config (read-only display) */}
          {tool.toolType === 'http' && tool.httpBinding && (
            <div>
              <label className="text-xs font-semibold text-foreground-muted uppercase tracking-wider block mb-1">
                {t('http_binding_label')}
              </label>
              <div className="flex items-center gap-2 text-xs">
                <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent font-medium">
                  {tool.httpBinding.method}
                </span>
                <span className="font-mono text-foreground truncate">
                  {tool.httpBinding.endpoint}
                </span>
              </div>
            </div>
          )}
          {tool.toolType === 'mcp' && tool.mcpBinding && (
            <div>
              <label className="text-xs font-semibold text-foreground-muted uppercase tracking-wider block mb-1">
                {t('mcp_binding_label')}
              </label>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-foreground-muted">{t('mcp_server_label')}</span>
                <span className="font-mono text-foreground">{tool.mcpBinding.server}</span>
                <span className="text-foreground-muted">{t('mcp_tool_label')}</span>
                <span className="font-mono text-foreground">{tool.mcpBinding.tool}</span>
              </div>
            </div>
          )}
          {tool.toolType === 'sandbox' && tool.sandboxBinding && (
            <div>
              <label className="text-xs font-semibold text-foreground-muted uppercase tracking-wider block mb-1">
                {t('sandbox_binding_label')}
              </label>
              <div className="flex items-center gap-2 text-xs">
                <span className="px-1.5 py-0.5 rounded bg-success/10 text-success font-medium">
                  {tool.sandboxBinding.runtime}
                </span>
                {tool.sandboxBinding.timeoutMs != null && (
                  <span className="text-foreground-muted">{tool.sandboxBinding.timeoutMs}ms</span>
                )}
              </div>
              {tool.sandboxBinding.codePreview && (
                <pre className="text-xs font-mono text-foreground-muted bg-background rounded p-2 overflow-x-auto max-h-24 mt-1">
                  {tool.sandboxBinding.codePreview}
                </pre>
              )}
            </div>
          )}

          {/* Hint badges (read-only) */}
          {Object.keys(tool.hints).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tool.hints.cacheable === true && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-success/10 text-success font-medium">
                  {t('cacheable_badge')}
                </span>
              )}
              {typeof tool.hints.latency === 'string' && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-warning/10 text-warning font-medium">
                  {String(tool.hints.latency)}
                </span>
              )}
              {tool.hints.side_effects === true && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-error/10 text-error font-medium">
                  {t('side_effects_badge')}
                </span>
              )}
              {tool.hints.parallelizable === true && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-info/10 text-info font-medium">
                  {t('parallelizable_badge')}
                </span>
              )}
              {tool.hints.requires_auth === true && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-warning/10 text-warning font-medium">
                  {t('auth_required_badge')}
                </span>
              )}
            </div>
          )}

          {/* Confirmation config */}
          {!readOnly && (
            <div>
              <label className="text-xs font-semibold text-foreground-muted uppercase tracking-wider block mb-1">
                {t('confirmation_label')}
              </label>
              <select
                value={tool.confirmation?.require ?? 'never'}
                onChange={(e) => {
                  const val = e.target.value as 'always' | 'never' | 'when_side_effects';
                  onChange(index, {
                    ...tool,
                    confirmation:
                      val === 'never'
                        ? undefined
                        : { require: val, immutableParams: tool.confirmation?.immutableParams },
                  });
                }}
                className={clsx(INPUT_CLASSES, 'w-48')}
              >
                <option value="never">{t('confirmation_never')}</option>
                <option value="always">{t('confirmation_always')}</option>
                <option value="when_side_effects">{t('confirmation_when_side_effects')}</option>
              </select>
              {tool.confirmation && tool.confirmation.require !== 'never' && (
                <div className="mt-2 pl-3 border-l-2 border-accent/30 space-y-1">
                  <label className="text-xs text-foreground-muted block">
                    {t('immutable_params_label')}
                  </label>
                  <input
                    type="text"
                    value={(tool.confirmation.immutableParams ?? []).join(', ')}
                    onChange={(e) => {
                      const params = e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean);
                      onChange(index, {
                        ...tool,
                        confirmation: {
                          ...tool.confirmation!,
                          immutableParams: params.length > 0 ? params : undefined,
                        },
                      });
                    }}
                    placeholder={t('placeholder_immutable_params')}
                    className={clsx(INPUT_CLASSES, 'font-mono')}
                  />
                </div>
              )}
            </div>
          )}

          {/* PII Access */}
          {!readOnly && (
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-foreground-muted uppercase tracking-wider shrink-0">
                {t('pii_access_label')}
              </label>
              <Select
                value={tool.piiAccess ?? 'tools'}
                onChange={(val) => {
                  onChange(index, {
                    ...tool,
                    piiAccess:
                      val === 'tools' ? undefined : (val as 'original' | 'user' | 'logs' | 'llm'),
                  });
                }}
                options={[
                  { value: 'original', label: t('pii_original_plaintext') },
                  { value: 'tools', label: t('pii_redacted') },
                  { value: 'user', label: t('pii_masked') },
                  { value: 'logs', label: t('pii_redacted_logs') },
                  { value: 'llm', label: t('pii_tokenized') },
                ]}
                className="w-44"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function McpServerGroup({
  serverName,
  tools,
  onAdd,
}: {
  serverName: string;
  tools: ToolWithVersion[];
  onAdd: (tool: ToolWithVersion) => void;
}) {
  const t = useTranslations('agent_editor.tools');
  const [isOpen, setIsOpen] = useState(true);
  return (
    <div className="border border-default rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={clsx(
          'w-full flex items-center gap-2 px-3 py-1.5 text-left',
          'bg-background-muted/50 hover:bg-background-muted transition-default',
        )}
      >
        {isOpen ? (
          <ChevronDown className="w-3 h-3 text-foreground-muted" />
        ) : (
          <ChevronRight className="w-3 h-3 text-foreground-muted" />
        )}
        <Server className="w-3 h-3 text-purple" />
        <span className="text-xs font-medium text-foreground">
          {t('mcp_heading', { server: serverName, count: tools.length })}
        </span>
      </button>
      {isOpen && (
        <div className="space-y-1 px-2 py-1.5">
          {tools.map((tool) => (
            <ProjectToolRow
              key={tool.id}
              tool={tool}
              onAdd={onAdd}
              displayName={tool.name.split('__').slice(1).join('__')}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectToolRow({
  tool,
  onAdd,
  displayName,
}: {
  tool: ToolWithVersion;
  onAdd: (tool: ToolWithVersion) => void;
  displayName?: string;
}) {
  const t = useTranslations('agent_editor.tools');
  return (
    <div
      className={clsx(
        'flex items-center gap-3 px-3 py-2 rounded-lg',
        'border border-default bg-background-muted',
        'transition-default hover:border-accent/30',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-medium text-foreground truncate">
            {displayName ?? tool.slug}
          </span>
          <ToolTypeBadge type={tool.toolType} className="text-xs" />
        </div>
        {tool.description && (
          <p className="text-xs text-foreground-muted mt-0.5 truncate">{tool.description}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onAdd(tool)}
        className={clsx(
          'flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium shrink-0',
          'text-accent hover:bg-accent-subtle transition-default',
        )}
      >
        <Plus className="w-3 h-3" />
        {t('action_add')}
      </button>
    </div>
  );
}

// =============================================================================
// ADD TOOL DIALOG — shows project tools to pick from
// =============================================================================

interface AddToolDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  inlineToolNames: Set<string>;
  onAddTool: (tool: ToolSectionData) => void;
  importedTools: Array<{ name: string; alias: string; toolType?: string; description?: string }>;
}

function AddToolDialog({
  open,
  onClose,
  projectId,
  inlineToolNames,
  onAddTool,
  importedTools,
}: AddToolDialogProps) {
  const t = useTranslations('agent_editor.tools');
  const [tools, setTools] = useState<ToolWithVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setSearch('');
    fetchTools(projectId, { limit: 200 })
      .then((result) => {
        setTools(result.data);
        setLoaded(true);
      })
      .catch(() => {
        setTools([]);
        setLoaded(true);
      })
      .finally(() => setLoading(false));
  }, [open, projectId]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, onClose]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  const available = useMemo(
    () => tools.filter((t) => !inlineToolNames.has(t.name)),
    [tools, inlineToolNames],
  );

  const filtered = useMemo(() => {
    if (!search) return available;
    const q = search.toLowerCase();
    return available.filter(
      (t) => t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q),
    );
  }, [available, search]);

  const { searchaiTools, mcpGroups, otherTools } = useMemo(() => {
    const groups = new Map<string, ToolWithVersion[]>();
    const other: ToolWithVersion[] = [];
    const searchai: ToolWithVersion[] = [];
    for (const tool of filtered) {
      if (tool.toolType === 'searchai') {
        searchai.push(tool);
      } else if (tool.toolType === 'mcp' && tool.name.includes('__')) {
        const serverName = tool.name.split('__')[0];
        if (!groups.has(serverName)) groups.set(serverName, []);
        groups.get(serverName)!.push(tool);
      } else {
        other.push(tool);
      }
    }
    return {
      searchaiTools: searchai,
      mcpGroups: Array.from(groups.entries()),
      otherTools: other,
    };
  }, [filtered]);

  const handleAddTool = useCallback(
    (tool: ToolWithVersion) => {
      const sig = parseSignatureLine(tool.dslContent);
      const props = parseDslProperties(tool.dslContent);
      onAddTool({
        name: tool.name,
        description: tool.description || '',
        parameters: sig.parameters.map((p) => ({
          name: p.name,
          type: p.type,
          required: p.required,
        })),
        returns: { type: sig.returnType },
        hints: {
          side_effects: (props.method || 'GET') !== 'GET',
          latency: 'medium',
        },
        toolType: tool.toolType,
        ...(tool.toolType === 'searchai' && {
          searchaiBinding: {
            indexId: props.index_id || '',
            tenantId: props.tenant_id || '',
            kbName: props.kb_name || undefined,
          },
        }),
      });
      onClose();
    },
    [onAddTool, onClose],
  );

  // Filter imported tools: exclude already-attached and apply search
  const availableImported = useMemo(() => {
    return importedTools.filter((tool) => {
      const mountedName = buildMountedModuleToolName(tool.alias, tool.name);
      return !inlineToolNames.has(mountedName);
    });
  }, [importedTools, inlineToolNames]);

  const filteredImported = useMemo(() => {
    if (!search) return availableImported;
    const q = search.toLowerCase();
    return availableImported.filter(
      (tool) =>
        tool.name.toLowerCase().includes(q) ||
        tool.alias.toLowerCase().includes(q) ||
        (tool.description ?? '').toLowerCase().includes(q),
    );
  }, [availableImported, search]);

  const handleAddImportedTool = useCallback(
    (tool: { name: string; alias: string; toolType?: string; description?: string }) => {
      const mountedName = buildMountedModuleToolName(tool.alias, tool.name);
      onAddTool({
        name: mountedName,
        description: tool.description ?? '',
        parameters: [],
        returns: { type: 'string' },
        hints: {},
        toolType: tool.toolType as ToolSectionData['toolType'],
      });
      onClose();
    },
    [onAddTool, onClose],
  );

  const hasAnyResults = filtered.length > 0 || filteredImported.length > 0;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-overlay backdrop-blur-sm">
      <div
        ref={dialogRef}
        className="relative w-full max-w-lg max-h-[70vh] bg-background rounded-xl border border-default shadow-2xl overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-default shrink-0">
          <h3 className="text-sm font-semibold text-foreground">{t('add_tool_dialog_title')}</h3>
          <p className="text-xs text-foreground-muted mt-0.5">{t('add_tool_dialog_description')}</p>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-default shrink-0">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('add_tool_search_placeholder')}
            className={clsx(INPUT_CLASSES, 'text-sm')}
            autoFocus
          />
        </div>

        {/* Tool list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {(loading || !loaded) && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 text-foreground-muted animate-spin" />
            </div>
          )}

          {loaded && !hasAnyResults && (
            <div className="text-center py-8">
              <Wrench className="w-6 h-6 text-foreground-muted/40 mx-auto mb-2" />
              <p className="text-xs text-foreground-muted">
                {search ? t('add_tool_no_match') : t('no_project_tools')}
              </p>
            </div>
          )}

          {/* Knowledge Base tools */}
          {loaded && searchaiTools.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 px-1 py-1">
                <BookOpen className="w-3 h-3 text-success" />
                <span className="text-xs font-medium text-foreground-muted">
                  {t('knowledge_bases_heading', { count: searchaiTools.length })}
                </span>
              </div>
              {searchaiTools.map((tool) => (
                <ProjectToolRow key={tool.id} tool={tool} onAdd={handleAddTool} />
              ))}
            </div>
          )}

          {/* Non-MCP tools */}
          {loaded &&
            otherTools.map((tool) => (
              <ProjectToolRow key={tool.id} tool={tool} onAdd={handleAddTool} />
            ))}

          {/* MCP tools grouped by server */}
          {loaded &&
            mcpGroups.map(([serverName, serverTools]) => (
              <McpServerGroup
                key={serverName}
                serverName={serverName}
                tools={serverTools}
                onAdd={handleAddTool}
              />
            ))}

          {/* Imported module tools */}
          {loaded && filteredImported.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center gap-1.5 px-1 py-1">
                <Package className="w-3 h-3 text-purple" />
                <span className="text-xs font-medium text-foreground-muted">
                  {t('imported_tools_heading', { count: filteredImported.length })}
                </span>
              </div>
              {filteredImported.map((tool) => {
                const mountedName = buildMountedModuleToolName(tool.alias, tool.name);
                return (
                  <div
                    key={mountedName}
                    className={clsx(
                      'flex items-center gap-3 px-3 py-2 rounded-lg',
                      'border border-default bg-background-muted',
                      'transition-default hover:border-accent/30',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Lock className="w-3 h-3 text-foreground-muted shrink-0" />
                        <span className="font-mono text-xs font-medium text-foreground truncate">
                          {tool.alias}.{tool.name}
                        </span>
                        {tool.toolType && (
                          <ToolTypeBadge type={tool.toolType as ToolType} className="text-xs" />
                        )}
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent font-medium shrink-0">
                          {t('imported_badge')}
                        </span>
                      </div>
                      {tool.description && (
                        <p className="text-xs text-foreground-muted mt-0.5 truncate pl-5">
                          {tool.description}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleAddImportedTool(tool)}
                      className={clsx(
                        'flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium shrink-0',
                        'text-accent hover:bg-accent-subtle transition-default',
                      )}
                    >
                      <Plus className="w-3 h-3" />
                      {t('action_add')}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-default shrink-0 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs font-medium text-foreground-muted hover:text-foreground hover:bg-background-muted transition-default"
          >
            {t('add_tool_close')}
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// CREATE TOOL DROPDOWN — navigates to tool creation page
// =============================================================================

const CREATE_TOOL_OPTIONS = [
  { type: 'http' as const, label: 'HTTP', description: 'Call external REST APIs' },
  { type: 'sandbox' as const, label: 'Code Tool', description: 'JavaScript/Python execution' },
  { type: 'mcp' as const, label: 'MCP Server', description: 'Manage servers & import tools' },
];

function CreateToolDropdown({
  projectId,
  agentName,
}: {
  projectId: string;
  agentName: string | null;
}) {
  const t = useTranslations('agent_editor.tools');
  const { navigate } = useNavigationStore();
  const { hasCodeTools } = useFeatures();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleSelect = (toolType: string) => {
    setIsOpen(false);
    const returnTo = agentName ? buildAgentToolsReturnPath(projectId, agentName) : null;
    if (toolType === 'mcp') {
      navigate(appendReturnTo(`/projects/${projectId}/tools?tab=mcp`, returnTo));
    } else {
      navigate(appendReturnTo(`/projects/${projectId}/tools/new?type=${toolType}`, returnTo));
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={clsx(
          'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
          'text-foreground-muted border border-default',
          'hover:border-accent hover:text-accent transition-default',
        )}
      >
        <ExternalLink className="w-3.5 h-3.5" />
        {t('action_create_tool')}
        <ChevronDown className="w-3 h-3" />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-background border border-default rounded-lg shadow-lg overflow-hidden z-50">
          {CREATE_TOOL_OPTIONS.filter((opt) => opt.type !== 'sandbox' || hasCodeTools).map(
            (option) => (
              <button
                key={option.type}
                type="button"
                onClick={() => handleSelect(option.type)}
                className="w-full text-left px-3 py-2.5 hover:bg-background-muted transition-default border-b border-default last:border-b-0"
              >
                <div className="text-xs font-medium text-foreground">{option.label}</div>
                <div className="text-xs text-foreground-muted mt-0.5">{option.description}</div>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ToolsEditor({
  data,
  onChange,
  readOnly,
  onArchClick,
}: SectionEditorProps<'tools'>) {
  const t = useTranslations('agent_editor.tools');
  const projectId = useAgentEditorStore((s) => s.projectId);
  const agentName = useAgentEditorStore((s) => s.agentName);
  const [addToolDialogOpen, setAddToolDialogOpen] = useState(false);
  const { tools: importedTools } = useImportedSymbols();

  const inlineToolNames = useMemo(() => new Set(data.map((d) => d.name).filter(Boolean)), [data]);

  const handleToolChange = useCallback(
    (index: number, tool: ToolSectionData) => {
      const next = [...data];
      next[index] = tool;
      onChange(next);
    },
    [data, onChange],
  );

  const handleRemoveTool = useCallback(
    (index: number) => {
      onChange(data.filter((_, i) => i !== index));
    },
    [data, onChange],
  );

  const handleAddProjectTool = useCallback(
    (tool: ToolSectionData) => {
      onChange([...data, tool]);
    },
    [data, onChange],
  );

  return (
    <div className="p-4 space-y-3 overflow-y-auto h-full">
      <SectionHeader onArchClick={onArchClick} />

      {/* Tool count + actions */}
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
          {data.length === 1
            ? t('tool_count_one', { count: data.length })
            : t('tool_count_other', { count: data.length })}
        </h4>
        {projectId && !readOnly && (
          <CreateToolDropdown projectId={projectId} agentName={agentName} />
        )}
      </div>

      {/* Tool list */}
      {data.length > 0 ? (
        <>
          <div className="space-y-2 stagger-children">
            {data.map((tool, index) => (
              <EditableToolCard
                key={index}
                tool={tool}
                index={index}
                onChange={handleToolChange}
                onRemove={handleRemoveTool}
                readOnly={readOnly}
              />
            ))}
          </div>
          {/* Attach tool from project */}
          {!readOnly && projectId && (
            <button
              type="button"
              onClick={() => setAddToolDialogOpen(true)}
              className={clsx(
                'w-full flex items-center justify-center gap-2 py-2.5 rounded-lg',
                'border border-dashed border-default text-foreground-muted',
                'hover:border-accent hover:text-accent transition-fast',
                'text-sm font-medium',
              )}
            >
              <Plus className="w-4 h-4" />
              {t('action_attach_tool')}
            </button>
          )}
        </>
      ) : (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <Wrench className="w-8 h-8 text-foreground-muted/40 mb-3" />
          <p className="text-sm text-foreground-muted">{t('no_tools_defined')}</p>
          <p className="text-xs text-foreground-subtle mt-1">{t('no_tools_hint')}</p>
          {!readOnly && projectId && (
            <button
              type="button"
              onClick={() => setAddToolDialogOpen(true)}
              className="inline-flex items-center gap-1.5 mt-4 px-3 py-1.5 rounded-md text-xs font-medium text-accent border border-accent/30 hover:bg-accent-subtle transition-default"
            >
              <Plus className="w-3.5 h-3.5" />
              {t('action_attach_tool')}
            </button>
          )}
        </div>
      )}

      {/* Add Tool Dialog */}
      {projectId && (
        <AddToolDialog
          open={addToolDialogOpen}
          onClose={() => setAddToolDialogOpen(false)}
          projectId={projectId}
          inlineToolNames={inlineToolNames}
          onAddTool={handleAddProjectTool}
          importedTools={importedTools}
        />
      )}
    </div>
  );
}
