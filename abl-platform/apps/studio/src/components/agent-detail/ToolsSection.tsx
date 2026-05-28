'use client';

/**
 * ToolsSection — collapsible section for tool definitions.
 *
 * Collapsed: shows tool count badge and name chips with binding type badges.
 * Expanded: shows linked tool cards, editable inline tool cards,
 * an "Add Inline Tool" button, and a collapsible "Project Tools" area
 * for linking available project tools.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  Wrench,
  Plus,
  Globe,
  Server,
  Box,
  X,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Loader2,
  Package,
  Lock,
} from 'lucide-react';
import clsx from 'clsx';
import { motion, AnimatePresence } from 'framer-motion';
import { useImportedSymbols } from '../../hooks/useImportedSymbols';
import { buildMountedModuleToolName } from '../abl/tool-snippets';
import { SectionCard } from './SectionCard';
import { Badge } from '@/components/ui/Badge';
import { Checkbox } from '@/components/ui/Checkbox';
import { Select } from '@/components/ui/Select';
import { ToolTypeBadge } from '@/components/tools/ToolTypeBadge';
import { fetchTools } from '@/api/tools';
import { springs } from '@/lib/animation';
import { parseSignatureLine, parseDslProperties } from '@agent-platform/shared/tools';
import type { ToolSectionData, ToolParameterData, SaveStatus } from '@/store/agent-detail-store';
import type { ToolWithVersion } from '@/store/tool-store';

// =============================================================================
// CONSTANTS
// =============================================================================

const BINDING_LABELS: Record<string, string> = {
  http: 'HTTP',
  mcp: 'MCP',
  sandbox: 'Sandbox',
};

const BINDING_VARIANTS: Record<string, 'accent' | 'info' | 'warning' | 'success'> = {
  http: 'accent',
  mcp: 'info',
  sandbox: 'success',
};

const BINDING_ICONS: Record<string, React.ElementType> = {
  http: Globe,
  mcp: Server,
  sandbox: Box,
};

/** Hint keys we render as badges */
const DISPLAYABLE_HINTS = [
  'cacheable',
  'latency',
  'side_effects',
  'parallelizable',
  'requires_auth',
  'timeout',
] as const;

const PARAMETER_TYPE_OPTIONS = ['string', 'number', 'boolean', 'date', 'object', 'array'] as const;

import { INLINE_INPUT_CLASSES } from './inline-input-classes';

// =============================================================================
// PROPS
// =============================================================================

export interface ToolsSectionProps {
  data: ToolSectionData[];
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (data: ToolSectionData[]) => void;
  onArchClick?: () => void;
  saveStatus?: SaveStatus;
  projectId?: string;
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

/** Collapsed chip showing tool name + binding type badge */
function ToolChip({ tool }: { tool: ToolSectionData }) {
  const bindingLabel = tool.toolType ? BINDING_LABELS[tool.toolType] : null;
  const bindingVariant = tool.toolType ? BINDING_VARIANTS[tool.toolType] : 'accent';

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs',
        'bg-background-muted text-foreground border border-default',
      )}
    >
      <Wrench className="w-3 h-3 text-muted" />
      {tool.name}
      {bindingLabel && (
        <Badge variant={bindingVariant} className="text-xs px-1.5 py-0">
          {bindingLabel}
        </Badge>
      )}
    </span>
  );
}

/** Binding configuration display */
function BindingConfig({ tool }: { tool: ToolSectionData }) {
  const t = useTranslations('agents.tools_section');
  if (tool.toolType === 'http' && tool.httpBinding) {
    return (
      <div className="space-y-1">
        <span className="text-xs font-medium text-muted">{t('http_binding_label')}</span>
        <div className="flex items-center gap-2 text-xs">
          <Badge variant="accent">{tool.httpBinding.method}</Badge>
          <span className="font-mono text-foreground truncate">{tool.httpBinding.endpoint}</span>
        </div>
      </div>
    );
  }

  if (tool.toolType === 'mcp' && tool.mcpBinding) {
    return (
      <div className="space-y-1">
        <span className="text-xs font-medium text-muted">{t('mcp_binding_label')}</span>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted">{t('mcp_server_label')}</span>
          <span className="font-mono text-foreground">{tool.mcpBinding.server}</span>
          <span className="text-muted">{t('mcp_tool_label')}</span>
          <span className="font-mono text-foreground">{tool.mcpBinding.tool}</span>
        </div>
      </div>
    );
  }

  if (tool.toolType === 'sandbox' && tool.sandboxBinding) {
    return (
      <div className="space-y-1">
        <span className="text-xs font-medium text-muted">{t('sandbox_binding_label')}</span>
        <div className="flex items-center gap-2 text-xs">
          <Badge variant="success">{tool.sandboxBinding.runtime}</Badge>
          {tool.sandboxBinding.timeoutMs && (
            <span className="text-muted">{tool.sandboxBinding.timeoutMs}ms</span>
          )}
          {tool.sandboxBinding.memoryMb && (
            <span className="text-muted">{tool.sandboxBinding.memoryMb}MB</span>
          )}
        </div>
        {tool.sandboxBinding.codePreview && (
          <pre className="text-xs font-mono text-muted bg-background-muted rounded p-2 overflow-x-auto max-h-24">
            {tool.sandboxBinding.codePreview}
          </pre>
        )}
      </div>
    );
  }

  return null;
}

/** Hint badges row */
function HintBadges({ hints }: { hints: Record<string, unknown> }) {
  const t = useTranslations('agents.tools_section');
  const entries = DISPLAYABLE_HINTS.filter((key) => hints[key] !== undefined).map((key) => ({
    key,
    value: hints[key],
  }));

  if (entries.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(({ key, value }) => {
        if (key === 'cacheable' && value === true) {
          return (
            <Badge key={key} variant="success" className="text-xs">
              {t('cacheable_badge')}
            </Badge>
          );
        }
        if (key === 'latency' && typeof value === 'string') {
          return (
            <Badge key={key} variant="warning" className="text-xs">
              {t('latency_badge', { value: String(value) })}
            </Badge>
          );
        }
        if (key === 'side_effects' && value === true) {
          return (
            <Badge key={key} variant="error" className="text-xs">
              {t('side_effects_badge')}
            </Badge>
          );
        }
        if (key === 'parallelizable' && value === true) {
          return (
            <Badge key={key} variant="info" className="text-xs">
              {t('parallelizable_badge')}
            </Badge>
          );
        }
        if (key === 'requires_auth' && value === true) {
          return (
            <Badge key={key} variant="warning" className="text-xs">
              {t('requires_auth_badge')}
            </Badge>
          );
        }
        if (key === 'timeout' && typeof value === 'number') {
          return (
            <Badge key={key} variant="accent" className="text-xs">
              {t('timeout_badge', { value: String(value) })}
            </Badge>
          );
        }
        return null;
      })}
    </div>
  );
}

// =============================================================================
// EDITABLE PARAMETERS
// =============================================================================

interface EditableParametersProps {
  parameters: ToolParameterData[];
  onChangeParameters: (params: ToolParameterData[]) => void;
}

function EditableParameters({ parameters, onChangeParameters }: EditableParametersProps) {
  const t = useTranslations('agents.tools_section');
  const handleParamChange = useCallback(
    (paramIdx: number, updated: ToolParameterData) => {
      const next = [...parameters];
      next[paramIdx] = updated;
      onChangeParameters(next);
    },
    [parameters, onChangeParameters],
  );

  const handleRemoveParam = useCallback(
    (paramIdx: number) => {
      onChangeParameters(parameters.filter((_, i) => i !== paramIdx));
    },
    [parameters, onChangeParameters],
  );

  const handleAddParam = useCallback(() => {
    onChangeParameters([...parameters, { name: '', type: 'string', required: false }]);
  }, [parameters, onChangeParameters]);

  return (
    <div className="space-y-2">
      {parameters.length === 0 && <p className="text-xs text-muted italic">{t('no_parameters')}</p>}

      {parameters.map((param, paramIdx) => (
        <div key={paramIdx} className="flex items-center gap-2">
          <input
            type="text"
            value={param.name}
            onChange={(e) => handleParamChange(paramIdx, { ...param, name: e.target.value })}
            placeholder={t('param_name_placeholder')}
            className={clsx(INLINE_INPUT_CLASSES, 'flex-1 font-mono')}
          />
          <select
            value={param.type}
            onChange={(e) => handleParamChange(paramIdx, { ...param, type: e.target.value })}
            className={clsx(INLINE_INPUT_CLASSES, '!w-24 shrink-0')}
          >
            {PARAMETER_TYPE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
          <Checkbox
            checked={param.required}
            onChange={(checked) => handleParamChange(paramIdx, { ...param, required: checked })}
            label={t('req_label')}
          />
          <input
            type="text"
            value={param.description ?? ''}
            onChange={(e) => handleParamChange(paramIdx, { ...param, description: e.target.value })}
            placeholder={t('description_placeholder')}
            className={clsx(INLINE_INPUT_CLASSES, 'flex-1')}
          />
          <input
            type="text"
            value={param.defaultValue !== undefined ? String(param.defaultValue) : ''}
            onChange={(e) => {
              const val = e.target.value;
              handleParamChange(paramIdx, {
                ...param,
                defaultValue: val === '' ? undefined : val,
              });
            }}
            placeholder={t('default_placeholder')}
            className={clsx(INLINE_INPUT_CLASSES, '!w-20 shrink-0')}
          />
          <button
            type="button"
            aria-label={`Remove parameter ${param.name}`}
            onClick={() => handleRemoveParam(paramIdx)}
            className="p-0.5 rounded hover:bg-error/10 hover:text-error transition-fast shrink-0"
          >
            <X className="w-3.5 h-3.5 text-muted hover:text-error" />
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={handleAddParam}
        className={clsx(
          'flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium',
          'text-muted hover:text-accent transition-fast',
        )}
      >
        <Plus className="w-3 h-3" />
        {t('add_parameter')}
      </button>
    </div>
  );
}

// =============================================================================
// EDITABLE TOOL CARD
// =============================================================================

interface ToolCardProps {
  tool: ToolSectionData;
  index: number;
  onChangeTool: (index: number, tool: ToolSectionData) => void;
  onRemoveTool: (index: number) => void;
}

function ToolCard({ tool, index, onChangeTool, onRemoveTool }: ToolCardProps) {
  const t = useTranslations('agents.tools_section');
  const BindingIcon = tool.toolType ? BINDING_ICONS[tool.toolType] : Wrench;
  const bindingLabel = tool.toolType ? BINDING_LABELS[tool.toolType] : null;
  const bindingVariant = tool.toolType ? BINDING_VARIANTS[tool.toolType] : 'accent';

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChangeTool(index, { ...tool, name: e.target.value });
    },
    [index, tool, onChangeTool],
  );

  const handleDescriptionChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChangeTool(index, { ...tool, description: e.target.value });
    },
    [index, tool, onChangeTool],
  );

  const handleReturnsTypeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChangeTool(index, { ...tool, returns: { ...tool.returns, type: e.target.value } });
    },
    [index, tool, onChangeTool],
  );

  const handleParametersChange = useCallback(
    (params: ToolParameterData[]) => {
      onChangeTool(index, { ...tool, parameters: params });
    },
    [index, tool, onChangeTool],
  );

  return (
    <div
      className={clsx(
        'rounded-lg border border-default bg-background-subtle p-4 space-y-3',
        'transition-fast hover:border-accent/30',
      )}
    >
      {/* Header: icon + name input + binding badge + remove button */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <BindingIcon className="w-4 h-4 text-accent shrink-0" />
          <input
            type="text"
            value={tool.name}
            onChange={handleNameChange}
            placeholder={t('tool_name_placeholder')}
            className={clsx(INLINE_INPUT_CLASSES, 'flex-1 font-mono font-semibold')}
          />
          {bindingLabel && <Badge variant={bindingVariant}>{bindingLabel}</Badge>}
        </div>
        <button
          type="button"
          aria-label={`Remove tool ${tool.name}`}
          onClick={() => onRemoveTool(index)}
          className="p-1 rounded hover:bg-error/10 hover:text-error transition-fast shrink-0"
        >
          <X className="w-4 h-4 text-muted hover:text-error" />
        </button>
      </div>

      {/* Description */}
      <textarea
        value={tool.description}
        onChange={handleDescriptionChange}
        placeholder={t('tool_description_placeholder')}
        rows={2}
        className={clsx(INLINE_INPUT_CLASSES, 'resize-y')}
      />

      {/* Returns type */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted shrink-0">{t('returns_label')}</span>
        <input
          type="text"
          value={tool.returns.type}
          onChange={handleReturnsTypeChange}
          placeholder={t('returns_placeholder')}
          className={clsx(INLINE_INPUT_CLASSES, '!w-32 font-mono')}
        />
      </div>

      {/* Parameters */}
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-foreground">{t('parameters_label')}</span>
        <EditableParameters
          parameters={tool.parameters}
          onChangeParameters={handleParametersChange}
        />
      </div>

      {/* Binding config (read-only display) */}
      <BindingConfig tool={tool} />

      {/* Hints (read-only display) */}
      <HintBadges hints={tool.hints} />

      {tool.confirmation?.require === 'always' && (
        <Badge variant="warning" className="text-xs">
          {t('confirm_always_badge')}
        </Badge>
      )}
      {tool.confirmation?.require === 'when_side_effects' && (
        <Badge variant="warning" className="text-xs">
          {t('confirm_side_effects_badge')}
        </Badge>
      )}
      {tool.piiAccess && tool.piiAccess !== 'tools' && (
        <Badge variant="info" className="text-xs">
          {t('pii_badge', { level: tool.piiAccess })}
        </Badge>
      )}

      {/* Confirmation */}
      <div className="space-y-2">
        <span className="text-xs font-medium text-foreground">{t('confirmation_label')}</span>
        <div className="flex items-center gap-3">
          <select
            value={tool.confirmation?.require ?? 'never'}
            onChange={(e) => {
              const val = e.target.value as 'always' | 'never' | 'when_side_effects';
              onChangeTool(index, {
                ...tool,
                confirmation:
                  val === 'never'
                    ? undefined
                    : { require: val, immutableParams: tool.confirmation?.immutableParams },
              });
            }}
            className={clsx(INLINE_INPUT_CLASSES, '!w-48 shrink-0')}
          >
            <option value="never">{t('confirmation_never')}</option>
            <option value="always">{t('confirmation_always')}</option>
            <option value="when_side_effects">{t('confirmation_when_side_effects')}</option>
          </select>
        </div>
        {tool.confirmation && tool.confirmation.require !== 'never' && (
          <div className="space-y-1.5 pl-3 border-l-2 border-accent/30">
            <span className="text-xs text-muted">{t('immutable_params_label')}</span>
            <input
              type="text"
              value={(tool.confirmation.immutableParams ?? []).join(', ')}
              onChange={(e) => {
                const params = e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
                onChangeTool(index, {
                  ...tool,
                  confirmation: {
                    ...tool.confirmation!,
                    immutableParams: params.length > 0 ? params : undefined,
                  },
                });
              }}
              placeholder="order_id, amount, currency"
              className={clsx(INLINE_INPUT_CLASSES, 'font-mono')}
            />
            <span className="text-xs text-muted">{t('immutable_params_hint')}</span>
          </div>
        )}
      </div>

      {/* PII Access */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-foreground">{t('pii_access_label')}</span>
        <Select
          value={tool.piiAccess ?? 'tools'}
          onChange={(val) => {
            onChangeTool(index, {
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
          className="w-44 shrink-0"
        />
      </div>
    </div>
  );
}

// =============================================================================
// PROJECT TOOLS COLLAPSIBLE
// =============================================================================

interface ProjectToolsProps {
  projectId: string;
  inlineToolNames: Set<string>;
  onAddTool: (tool: ToolSectionData) => void;
  importedTools: Array<{ name: string; alias: string; toolType?: string; description?: string }>;
}

function ProjectTools({ projectId, inlineToolNames, onAddTool, importedTools }: ProjectToolsProps) {
  const t = useTranslations('agents.tools_section');
  const [isOpen, setIsOpen] = useState(false);
  const [tools, setTools] = useState<ToolWithVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const handleToggle = useCallback(() => {
    const opening = !isOpen;
    setIsOpen(opening);
    if (opening && !loaded && !loading) {
      setLoading(true);
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
    }
  }, [isOpen, loaded, loading, projectId]);

  const available = useMemo(
    () => tools.filter((t) => !inlineToolNames.has(t.name)),
    [tools, inlineToolNames],
  );

  // Group MCP tools by server name (derived from name__tool convention)
  const { mcpGroups, otherTools } = useMemo(() => {
    const groups = new Map<string, ToolWithVersion[]>();
    const other: ToolWithVersion[] = [];
    for (const tool of available) {
      if (tool.toolType === 'mcp' && tool.name.includes('__')) {
        const serverName = tool.name.split('__')[0];
        if (!groups.has(serverName)) groups.set(serverName, []);
        groups.get(serverName)!.push(tool);
      } else {
        other.push(tool);
      }
    }
    return { mcpGroups: Array.from(groups.entries()), otherTools: other };
  }, [available]);

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
      });
    },
    [onAddTool],
  );

  // Filter imported tools to exclude ones already added
  const availableImported = useMemo(() => {
    return importedTools.filter((tool) => {
      const mountedName = buildMountedModuleToolName(tool.alias, tool.name);
      return !inlineToolNames.has(mountedName);
    });
  }, [importedTools, inlineToolNames]);

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
    },
    [onAddTool],
  );

  const totalAvailable = available.length + availableImported.length;

  return (
    <div className="rounded-lg border border-dashed border-default overflow-hidden">
      <button
        type="button"
        onClick={handleToggle}
        className={clsx(
          'w-full flex items-center justify-between px-3 py-2 text-left',
          'hover:bg-background-muted/50 transition-default',
        )}
      >
        <span className="flex items-center gap-2 text-sm font-medium text-muted">
          <Wrench className="w-3.5 h-3.5" />
          {t('project_tools_label')}
          {loaded && (
            <Badge variant="accent" className="text-xs">
              {totalAvailable}
            </Badge>
          )}
        </span>
        {isOpen ? (
          <ChevronUp className="w-4 h-4 text-muted" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted" />
        )}
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={springs.snappy}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 space-y-2">
              {(loading || !loaded) && (
                <div className="flex items-center justify-center py-3">
                  <Loader2 className="w-4 h-4 text-muted animate-spin" />
                </div>
              )}

              {loaded && available.length === 0 && availableImported.length === 0 && (
                <p className="text-xs text-muted py-2 text-center">{t('no_project_tools')}</p>
              )}

              {/* Non-MCP tools (HTTP, Sandbox, etc.) */}
              {loaded &&
                otherTools.map((tool) => (
                  <DetailToolRow key={tool.id} tool={tool} onAdd={handleAddTool} />
                ))}

              {/* MCP tools grouped by server */}
              {loaded &&
                mcpGroups.map(([serverName, serverTools]) => (
                  <DetailMcpServerGroup
                    key={serverName}
                    serverName={serverName}
                    tools={serverTools}
                    onAdd={handleAddTool}
                  />
                ))}

              {/* Imported module tools */}
              {availableImported.length > 0 && (
                <div className="mt-2 pt-2 border-t border-default/50">
                  <div className="flex items-center gap-1.5 px-1 py-1 mb-1">
                    <Package className="h-3 w-3 text-purple" />
                    <span className="text-xs font-medium text-muted">
                      {t('imported_tools_label')}
                    </span>
                    <span className="text-xs text-muted">({availableImported.length})</span>
                  </div>
                  {availableImported.map((tool) => {
                    const mountedName = buildMountedModuleToolName(tool.alias, tool.name);
                    return (
                      <div
                        key={mountedName}
                        className={clsx(
                          'flex items-center gap-3 px-3 py-2 rounded-lg',
                          'border border-default bg-background-subtle',
                          'transition-fast hover:border-accent/30',
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <Lock className="h-3 w-3 text-muted shrink-0" />
                            <span className="font-mono text-xs font-medium text-foreground truncate">
                              {tool.alias}.{tool.name}
                            </span>
                            {tool.toolType && (
                              <span className="text-[10px] bg-background-muted px-1 py-0.5 rounded uppercase">
                                {tool.toolType}
                              </span>
                            )}
                            <Badge variant="accent" className="text-[10px] px-1 py-0.5">
                              {t('imported_badge')}
                            </Badge>
                          </div>
                          {tool.description && (
                            <p className="text-xs text-muted mt-0.5 truncate pl-5">
                              {tool.description}
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => handleAddImportedTool(tool)}
                          className={clsx(
                            'flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium shrink-0',
                            'text-accent hover:bg-accent/10 transition-fast',
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DetailMcpServerGroup({
  serverName,
  tools,
  onAdd,
}: {
  serverName: string;
  tools: ToolWithVersion[];
  onAdd: (tool: ToolWithVersion) => void;
}) {
  const [isOpen, setIsOpen] = useState(true);
  return (
    <div className="border border-default rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={clsx(
          'w-full flex items-center gap-2 px-3 py-1.5 text-left',
          'bg-background-subtle hover:bg-background-muted transition-fast',
        )}
      >
        {isOpen ? (
          <ChevronDown className="w-3 h-3 text-muted" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted" />
        )}
        <Server className="w-3 h-3 text-purple" />
        <span className="text-xs font-medium text-foreground">{serverName}</span>
        <span className="text-xs px-1.5 py-0.5 rounded bg-purple-subtle text-purple font-medium">
          {tools.length}
        </span>
      </button>
      {isOpen && (
        <div className="space-y-1 px-2 py-1.5">
          {tools.map((tool) => (
            <DetailToolRow
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

function DetailToolRow({
  tool,
  onAdd,
  displayName,
}: {
  tool: ToolWithVersion;
  onAdd: (tool: ToolWithVersion) => void;
  displayName?: string;
}) {
  const t = useTranslations('agents.tools_section');
  return (
    <div
      className={clsx(
        'flex items-center gap-3 px-3 py-2 rounded-lg',
        'border border-default bg-background-subtle',
        'transition-fast hover:border-accent/30',
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
          <p className="text-xs text-muted mt-0.5 truncate">{tool.description}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onAdd(tool)}
        className={clsx(
          'flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium shrink-0',
          'text-accent hover:bg-accent/10 transition-fast',
        )}
      >
        <Plus className="w-3 h-3" />
        {t('action_add')}
      </button>
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ToolsSection({
  data,
  isExpanded,
  onToggle,
  onChange,
  onArchClick,
  saveStatus,
  projectId,
}: ToolsSectionProps) {
  const t = useTranslations('agents.tools_section');

  // ---------------------------------------------------------------------------
  // Derived
  // ---------------------------------------------------------------------------

  const { tools: importedTools } = useImportedSymbols();

  const inlineToolNames = useMemo(() => new Set(data.map((d) => d.name).filter(Boolean)), [data]);

  const totalCount = data.length;

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleToolChange = useCallback(
    (index: number, tool: ToolSectionData) => {
      const updated = [...data];
      updated[index] = tool;
      onChange(updated);
    },
    [data, onChange],
  );

  const handleRemoveTool = useCallback(
    (index: number) => {
      onChange(data.filter((_, i) => i !== index));
    },
    [data, onChange],
  );

  const handleAddTool = useCallback(() => {
    onChange([
      ...data,
      { name: '', description: '', parameters: [], returns: { type: 'string' }, hints: {} },
    ]);
  }, [data, onChange]);

  const handleAddProjectTool = useCallback(
    (tool: ToolSectionData) => {
      onChange([...data, tool]);
    },
    [data, onChange],
  );

  // ---------------------------------------------------------------------------
  // Collapsed summary: inline tool chips + linked tool chips
  // ---------------------------------------------------------------------------

  const summaryContent =
    totalCount > 0 ? (
      <span className="flex items-center gap-1.5 flex-wrap">
        {data.map((tool, idx) => (
          <ToolChip key={`tool-${tool.name}-${idx}`} tool={tool} />
        ))}
      </span>
    ) : undefined;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <SectionCard
      title={t('title')}
      sectionId="TOOLS"
      count={totalCount}
      isExpanded={isExpanded}
      onToggle={onToggle}
      onArchClick={onArchClick}
      summary={summaryContent}
      saveStatus={saveStatus}
      isEmpty={totalCount === 0}
    >
      <div className="space-y-3">
        {/* Tool cards */}
        {data.length > 0 && (
          <div className="space-y-2">
            {data.map((tool, index) => (
              <ToolCard
                key={index}
                tool={tool}
                index={index}
                onChangeTool={handleToolChange}
                onRemoveTool={handleRemoveTool}
              />
            ))}
          </div>
        )}

        {/* Add Inline Tool button */}
        <button
          type="button"
          aria-label="Add Inline Tool"
          onClick={handleAddTool}
          className={clsx(
            'w-full flex items-center justify-center gap-2 py-2.5 rounded-lg',
            'border border-dashed border-default text-muted',
            'hover:border-accent hover:text-accent transition-fast',
            'text-sm font-medium btn-press',
          )}
        >
          <Plus className="w-4 h-4" />
          {t('add_tool')}
        </button>

        {/* Project Tools collapsible */}
        {projectId && (
          <ProjectTools
            projectId={projectId}
            inlineToolNames={inlineToolNames}
            onAddTool={handleAddProjectTool}
            importedTools={importedTools}
          />
        )}

        {/* Imported Tools (read-only from module dependencies) */}
        {importedTools.length > 0 && (
          <div className="mt-4 border-t border-default pt-4">
            <div className="flex items-center gap-2 mb-2">
              <Package className="h-4 w-4 text-purple" />
              <span className="text-sm font-medium">{t('imported_tools_label')}</span>
              <span className="text-xs text-muted">({importedTools.length})</span>
            </div>
            <div className="space-y-1">
              {importedTools.map((tool) => {
                const mountedName = buildMountedModuleToolName(tool.alias, tool.name);
                return (
                  <div
                    key={mountedName}
                    className="flex items-center gap-2 px-3 py-2 rounded border border-default bg-background-muted/20"
                  >
                    <Lock className="h-3 w-3 text-muted" />
                    <span className="font-mono text-xs">
                      {tool.alias}.{tool.name}
                    </span>
                    {tool.toolType && (
                      <span className="text-[10px] bg-background-muted px-1 py-0.5 rounded uppercase">
                        {tool.toolType}
                      </span>
                    )}
                    <Badge variant="accent" className="text-[10px] px-1 py-0.5">
                      {t('imported_badge')}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
