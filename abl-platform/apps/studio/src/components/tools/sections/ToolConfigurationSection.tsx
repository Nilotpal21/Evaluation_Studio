/**
 * ToolConfigurationSection Component
 *
 * Main configuration section: type-specific config first, advanced settings at bottom.
 */

import { InfoCard } from '../../ui/InfoCard';
import { AdvancedSettingsSection } from './config/AdvancedSettingsSection';
import { HttpConfigForm } from '../HttpConfigForm';
import { SandboxConfigForm } from '../SandboxConfigForm';
import { McpConfigForm } from '../McpConfigForm';
import { WorkflowConfigForm } from '../WorkflowConfigForm';
import type {
  ToolType,
  HttpConfig,
  SandboxConfig,
  McpConfig,
  WorkflowConfig,
  AnyToolConfig,
} from '../shared-types';

interface ToolConfigurationSectionProps {
  toolType: ToolType;
  timeoutMs: number;
  inputSchema: string;
  typeConfig: AnyToolConfig;
  configErrors: Record<string, string>;
  advancedEnabled: boolean;
  onTimeoutChange: (value: number) => void;
  onInputSchemaChange: (value: string) => void;
  onTypeConfigChange: (config: AnyToolConfig) => void;
  onAdvancedEnabledChange: (enabled: boolean) => void;
}

export function ToolConfigurationSection({
  toolType,
  timeoutMs,
  inputSchema,
  typeConfig,
  configErrors,
  advancedEnabled,
  onTimeoutChange,
  onInputSchemaChange,
  onTypeConfigChange,
  onAdvancedEnabledChange,
}: ToolConfigurationSectionProps) {
  const hasErrors = Object.keys(configErrors).length > 0;

  return (
    <div className="space-y-5">
      {/* Validation Error Summary */}
      {hasErrors && (
        <InfoCard
          variant="error"
          title="Configuration Errors"
          message={
            <ul className="list-disc list-inside space-y-1 text-xs">
              {Object.entries(configErrors).map(([field, error]) => (
                <li key={field}>
                  <strong className="font-medium">{field}:</strong> {error}
                </li>
              ))}
            </ul>
          }
          size="sm"
        />
      )}

      {toolType === 'http' && (
        <HttpConfigForm
          config={typeConfig as HttpConfig}
          onChange={onTypeConfigChange as (config: HttpConfig) => void}
          showTemplates={false}
        />
      )}

      {toolType === 'sandbox' && (
        <SandboxConfigForm
          config={typeConfig as SandboxConfig}
          onChange={onTypeConfigChange as (config: SandboxConfig) => void}
          showTemplates={false}
        />
      )}

      {toolType === 'mcp' && (
        <McpConfigForm
          config={typeConfig as McpConfig}
          onChange={onTypeConfigChange as (config: McpConfig) => void}
          readOnly
        />
      )}

      {toolType === 'workflow' && (
        <WorkflowConfigForm
          config={typeConfig as WorkflowConfig}
          onChange={onTypeConfigChange as (config: WorkflowConfig) => void}
        />
      )}

      {/* Advanced Settings — at bottom, collapsed by default (not for MCP/workflow — auto-managed) */}
      {toolType !== 'mcp' && toolType !== 'workflow' && (
        <AdvancedSettingsSection
          enabled={advancedEnabled}
          onEnabledChange={onAdvancedEnabledChange}
          timeoutMs={timeoutMs}
          inputSchema={inputSchema}
          toolType={toolType}
          onTimeoutChange={onTimeoutChange}
          onInputSchemaChange={onInputSchemaChange}
        />
      )}
    </div>
  );
}
