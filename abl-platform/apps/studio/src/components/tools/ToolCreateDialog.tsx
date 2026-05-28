/**
 * ToolCreateDialog Component
 *
 * Modal dialog for creating a new tool with dropdown selector and inline form.
 */

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { X, Check, Loader2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { HttpConfigForm, validateHttpConfig } from './HttpConfigForm';
import { McpConfigForm, validateMcpConfig } from './McpConfigForm';
import { SandboxConfigForm, validateSandboxConfig } from './SandboxConfigForm';
import { WorkflowConfigForm, validateWorkflowConfig } from './WorkflowConfigForm';
import {
  buildHttpCreatePayload,
  buildSandboxCreatePayload,
  buildMcpCreatePayload,
  buildWorkflowCreatePayload,
} from './form-adapters';
import { useProjectStore } from '../../store/project-store';
import { useNavigationStore } from '../../store/navigation-store';
import { useToolStore } from '../../store/tool-store';
import { createTool } from '../../api/tools';
import { sanitizeErrors } from '../../lib/sanitize-error';
import { ErrorAlert } from '../ui/ErrorAlert';
import { useFeatures } from '../../hooks/use-features';
import type {
  ToolType,
  HttpConfig,
  SandboxConfig,
  McpConfig,
  WorkflowConfig,
  AnyToolConfig,
} from './shared-types';

interface ToolCreateDialogProps {
  open: boolean;
  onClose: () => void;
  /** Pre-select a tool type and hide the type selector */
  defaultToolType?: ToolType;
}

export function ToolCreateDialog({ open, onClose, defaultToolType }: ToolCreateDialogProps) {
  const t = useTranslations('tools.create_dialog');
  const { currentProject } = useProjectStore();
  const { navigate } = useNavigationStore();
  const { addTool } = useToolStore();
  const { hasCodeTools } = useFeatures();

  const TOOL_TYPE_OPTIONS = useMemo(
    () =>
      [
        { value: '', label: t('select_tool_type') },
        { value: 'http', label: t('type_http') },
        { value: 'sandbox', label: t('type_sandbox') },
        { value: 'mcp', label: t('type_mcp') },
        { value: 'lambda', label: t('type_lambda') },
        { value: 'workflow', label: t('type_workflow'), testid: 'tool-type-option-workflow' },
      ].filter((opt) => opt.value !== 'sandbox' || hasCodeTools),
    [t, hasCodeTools],
  );

  const projectId = currentProject?.id;
  const [error, setError] = useState<string | string[] | null>(null);
  const [creating, setCreating] = useState(false);

  // Form state
  const [toolType, setToolType] = useState<ToolType | null>(defaultToolType ?? null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [typeConfig, setTypeConfig] = useState<AnyToolConfig | Record<string, unknown>>({});

  // Reset config when tool type changes to prevent cross-type field leakage
  const handleToolTypeSelect = (type: ToolType) => {
    setToolType(type);
    setTypeConfig({});
  };

  const getConfigErrors = (): Record<string, string> => {
    if (!toolType) return {};
    switch (toolType) {
      case 'http':
        return validateHttpConfig(typeConfig as HttpConfig);
      case 'mcp':
        return validateMcpConfig(typeConfig as McpConfig);
      case 'sandbox':
        return validateSandboxConfig(typeConfig as SandboxConfig);
      case 'workflow':
        return validateWorkflowConfig(typeConfig as WorkflowConfig);
      default:
        return {};
    }
  };

  // Must match backend TOOL_NAME_REGEX in
  // packages/shared/src/validation/project-tool-schemas.ts:17
  const TOOL_NAME_REGEX = /^[a-z][a-z0-9_]{0,62}[a-z0-9]$/;

  const getNameError = (): string | undefined => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed.length < 2) return t('name_min_length');
    if (!TOOL_NAME_REGEX.test(trimmed)) return t('name_invalid_format');
    return undefined;
  };

  const canCreate = () => {
    if (!toolType) return false;
    const trimmed = name.trim();
    if (trimmed.length < 2) return false;
    if (!TOOL_NAME_REGEX.test(trimmed)) return false;
    return Object.keys(getConfigErrors()).length === 0;
  };

  const handleCreate = async () => {
    if (!projectId || !toolType) return;

    setCreating(true);
    setError(null);

    try {
      const trimmedName = name.trim();
      const trimmedDesc = description.trim();

      let payload;
      switch (toolType) {
        case 'http':
          payload = buildHttpCreatePayload(trimmedName, trimmedDesc, typeConfig as HttpConfig);
          break;
        case 'sandbox':
          payload = buildSandboxCreatePayload(
            trimmedName,
            trimmedDesc,
            typeConfig as SandboxConfig,
          );
          break;
        case 'mcp':
          payload = buildMcpCreatePayload(trimmedName, trimmedDesc, typeConfig as McpConfig);
          break;
        case 'workflow':
          payload = buildWorkflowCreatePayload(
            trimmedName,
            trimmedDesc,
            typeConfig as WorkflowConfig,
          );
          break;
        default:
          return;
      }

      const result = await createTool(projectId, payload);
      addTool(result.tool);

      onClose();
      navigate(`/projects/${projectId}/tools/${result.tool.id}`);
    } catch (err) {
      setError(sanitizeErrors(err, 'Failed to create tool'));
    } finally {
      setCreating(false);
    }
  };

  const handleConfigChange = (cfg: AnyToolConfig) => setTypeConfig(cfg);

  const renderConfigForm = () => {
    if (!toolType) return null;

    switch (toolType) {
      case 'http':
        return (
          <HttpConfigForm
            config={typeConfig as HttpConfig}
            onChange={handleConfigChange as (config: HttpConfig) => void}
            projectId={projectId}
          />
        );
      case 'mcp':
        return (
          <McpConfigForm
            config={typeConfig as McpConfig}
            onChange={handleConfigChange as (config: McpConfig) => void}
          />
        );
      case 'sandbox':
        return (
          <SandboxConfigForm
            config={typeConfig as SandboxConfig}
            onChange={handleConfigChange as (config: SandboxConfig) => void}
          />
        );
      case 'workflow':
        return (
          <WorkflowConfigForm
            config={typeConfig as WorkflowConfig}
            onChange={handleConfigChange as (config: WorkflowConfig) => void}
            persistAutoSelectedVersion
          />
        );
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-overlay backdrop-blur-sm">
      <div className="relative w-full max-w-3xl max-h-[90vh] bg-background rounded-xl border border-default shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-default shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              {defaultToolType === 'workflow' ? t('workflow_title') : t('title')}
            </h2>
            <p className="text-sm text-muted mt-0.5">
              {defaultToolType === 'workflow' ? t('workflow_subtitle') : t('subtitle')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-muted hover:text-foreground hover:bg-background-muted rounded-lg transition-default"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {error && <ErrorAlert error={error} onDismiss={() => setError(null)} className="mb-4" />}

          {/* Tool Type Selector (hidden when defaultToolType is provided) */}
          {!defaultToolType && (
            <div className="mb-6">
              <Select
                label={t('tool_type_label')}
                options={TOOL_TYPE_OPTIONS}
                value={toolType || ''}
                onChange={(v) => handleToolTypeSelect(v as ToolType)}
              />
              <p className="text-xs text-muted mt-1.5">{t('choose_type_hint')}</p>
            </div>
          )}

          {/* Basic Info & Config (shown when type selected) */}
          {toolType && (
            <>
              <div className="mb-6 space-y-4">
                <Input
                  label={t('tool_name_label')}
                  placeholder={t('tool_name_placeholder')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  error={getNameError()}
                  data-testid="tool-create-name-input"
                />
                <Input
                  label={t('description_label')}
                  placeholder={t('description_placeholder')}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              {/* Type-specific Configuration */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-3">
                  {t('configuration_label')}
                </label>
                {renderConfigForm()}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-default shrink-0 bg-background-subtle">
          <p className="text-xs text-muted">{toolType ? t('footer_hint') : ''}</p>
          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              icon={
                creating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )
              }
              onClick={handleCreate}
              loading={creating}
              disabled={!canCreate()}
            >
              {defaultToolType === 'workflow' ? t('workflow_create') : t('create')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
