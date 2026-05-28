/**
 * StepEditor Component
 *
 * Right panel configuration editor for a selected workflow step.
 * Renders type-specific configuration forms based on the step type.
 * All text inputs support {{expression}} syntax (rendered as regular inputs;
 * ContextExplorer integration will be added separately).
 */

'use client';

import { useCallback, useState, useEffect } from 'react';
import { clsx } from 'clsx';
import useSWR from 'swr';
import {
  Plug,
  Globe,
  Bot,
  GitBranch,
  Clock,
  Repeat,
  GitMerge,
  UserCheck,
  Wand2,
  Wrench,
  Webhook,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { WorkflowStep } from '../../../api/workflows';
import { useNavigationStore } from '../../../store/navigation-store';

// =============================================================================
// TYPES
// =============================================================================

interface StepEditorProps {
  step: WorkflowStep;
  onChange: (step: WorkflowStep) => void;
  onDelete: (stepId: string) => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const DELAY_UNITS = [
  { value: 'seconds', label: 'Seconds' },
  { value: 'minutes', label: 'Minutes' },
  { value: 'hours', label: 'Hours' },
];

const stepTypeIcons: Record<string, LucideIcon> = {
  connector_action: Plug,
  http: Globe,
  agent_invocation: Bot,
  condition: GitBranch,
  delay: Clock,
  loop: Repeat,
  parallel: GitMerge,
  approval: UserCheck,
  transform: Wand2,
  tool_call: Wrench,
  async_webhook: Webhook,
};

const stepTypeLabels: Record<string, string> = {
  connector_action: 'Connector Action',
  http: 'HTTP Request',
  agent_invocation: 'Agent Invocation',
  condition: 'Condition',
  delay: 'Delay',
  loop: 'Loop',
  parallel: 'Parallel',
  approval: 'Approval',
  transform: 'Transform',
  tool_call: 'Tool Call',
  async_webhook: 'Async Webhook',
};

// =============================================================================
// SHARED INPUT STYLES
// =============================================================================

const inputClasses = clsx(
  'w-full rounded-lg border border-default bg-background-subtle text-foreground placeholder:text-subtle',
  'transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus',
  'text-sm py-2 px-3',
);

const labelClasses = 'block text-sm font-medium text-foreground mb-1.5';

const hintClasses = 'text-xs text-subtle mt-1';

// =============================================================================
// HELPERS
// =============================================================================

function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className={labelClasses}>{label}</label>
      {children}
      {hint && <p className={hintClasses}>{hint}</p>}
    </div>
  );
}

// =============================================================================
// TYPE-SPECIFIC CONFIG EDITORS
// =============================================================================

interface ConfigEditorProps {
  config: Record<string, unknown>;
  onConfigChange: (config: Record<string, unknown>) => void;
}

// -- Connector types -----------------------------------------------------------

interface ConnectorAction {
  name: string;
  displayName: string;
}

interface Connector {
  name: string;
  displayName: string;
  description?: string;
  actions: ConnectorAction[];
}

interface ConnectorsResponse {
  success: boolean;
  data: Connector[];
}

function ConnectorActionConfig({ config, onConfigChange }: ConfigEditorProps) {
  const { projectId } = useNavigationStore();

  const { data: connectorsData, isLoading } = useSWR<ConnectorsResponse>(
    projectId ? `/api/projects/${encodeURIComponent(projectId)}/connectors` : null,
  );

  const connectors: Connector[] = connectorsData?.data ?? [];
  const hasConnectors = connectors.length > 0;

  const selectedConnector = connectors.find((c) => c.name === (config.connector as string));
  const actions = selectedConnector?.actions ?? [];

  return (
    <div className="space-y-4">
      <FieldGroup label="Connector">
        <select
          value={(config.connector as string) ?? ''}
          onChange={(e) => {
            // Reset action when connector changes since actions differ per connector
            onConfigChange({ ...config, connector: e.target.value, action: '' });
          }}
          className={inputClasses}
          disabled={isLoading || !hasConnectors}
        >
          <option value="">
            {isLoading
              ? 'Loading connectors...'
              : hasConnectors
                ? 'Select a connector...'
                : 'No connectors available'}
          </option>
          {connectors.map((c) => (
            <option key={c.name} value={c.name}>
              {c.displayName}
            </option>
          ))}
        </select>
        {!isLoading && !hasConnectors && (
          <p className={hintClasses}>
            No connector catalog entries were returned. Check runtime/workflow-engine connectivity
            and connector installation.
          </p>
        )}
      </FieldGroup>

      <FieldGroup label="Action">
        <select
          value={(config.action as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, action: e.target.value })}
          className={inputClasses}
          disabled={!config.connector || !hasConnectors}
        >
          <option value="">
            {config.connector ? 'Select an action...' : 'Select a connector first'}
          </option>
          {actions.map((a) => (
            <option key={a.name} value={a.name}>
              {a.displayName}
            </option>
          ))}
        </select>
      </FieldGroup>

      <FieldGroup label="Parameters" hint="Use {{expression}} to reference previous step outputs">
        <textarea
          value={(config.params as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, params: e.target.value })}
          className={clsx(inputClasses, 'min-h-[80px] resize-y font-mono')}
          placeholder='{"key": "{{context.steps.previous.output.value}}"}'
          rows={3}
        />
      </FieldGroup>
    </div>
  );
}

function HttpRequestConfig({ config, onConfigChange }: ConfigEditorProps) {
  const headers = (config.headers as string) ?? '';
  const body = (config.body as string) ?? '';

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <div className="w-28 shrink-0">
          <FieldGroup label="Method">
            <select
              value={(config.method as string) ?? 'GET'}
              onChange={(e) => onConfigChange({ ...config, method: e.target.value })}
              className={inputClasses}
            >
              {HTTP_METHODS.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </select>
          </FieldGroup>
        </div>
        <div className="flex-1">
          <FieldGroup label="URL" hint="Supports {{expression}} syntax">
            <input
              type="text"
              value={(config.url as string) ?? ''}
              onChange={(e) => onConfigChange({ ...config, url: e.target.value })}
              className={inputClasses}
              placeholder="https://api.example.com/{{context.steps.prev.output.id}}"
            />
          </FieldGroup>
        </div>
      </div>

      <FieldGroup label="Headers" hint="JSON object of key-value pairs">
        <textarea
          value={headers}
          onChange={(e) => onConfigChange({ ...config, headers: e.target.value })}
          className={clsx(inputClasses, 'min-h-[60px] resize-y font-mono')}
          placeholder='{"Authorization": "Bearer {{context.token}}"}'
          rows={2}
        />
      </FieldGroup>

      <FieldGroup label="Body" hint="Request body (JSON). Use {{expression}} for dynamic values.">
        <textarea
          value={body}
          onChange={(e) => onConfigChange({ ...config, body: e.target.value })}
          className={clsx(inputClasses, 'min-h-[80px] resize-y font-mono')}
          placeholder='{"name": "{{context.trigger.payload.name}}"}'
          rows={3}
        />
      </FieldGroup>
    </div>
  );
}

function AgentInvocationConfig({ config, onConfigChange }: ConfigEditorProps) {
  const { projectId } = useNavigationStore();

  const { data: agentsData, isLoading } = useSWR<{
    agents: Array<{ id: string; name: string; description: string | null }>;
  }>(projectId ? `/api/projects/${encodeURIComponent(projectId)}/agents` : null);

  const agents = agentsData?.agents ?? [];
  const hasAgents = agents.length > 0;

  return (
    <div className="space-y-4">
      <FieldGroup label="Agent">
        <select
          value={(config.agentId as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, agentId: e.target.value })}
          className={inputClasses}
          disabled={isLoading || !hasAgents}
        >
          <option value="">
            {isLoading
              ? 'Loading agents...'
              : hasAgents
                ? 'Select an agent...'
                : 'No agents available'}
          </option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.description ? ` — ${a.description}` : ''}
            </option>
          ))}
        </select>
        {!isLoading && !hasAgents && (
          <p className={hintClasses}>No agents found in this project. Create an agent first.</p>
        )}
      </FieldGroup>

      <FieldGroup
        label="Message"
        hint="The message to send to the agent. Supports {{expression}} syntax."
      >
        <textarea
          value={(config.message as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, message: e.target.value })}
          className={clsx(inputClasses, 'min-h-[60px] resize-y')}
          placeholder="Process this request: {{context.trigger.payload.message}}"
          rows={2}
        />
      </FieldGroup>

      <FieldGroup label="Timeout (seconds)">
        <input
          type="number"
          value={(config.timeout as number) ?? 30}
          onChange={(e) =>
            onConfigChange({ ...config, timeout: parseInt(e.target.value, 10) || 30 })
          }
          className={inputClasses}
          min={1}
          max={300}
        />
      </FieldGroup>
    </div>
  );
}

function ConditionConfig({ config, onConfigChange }: ConfigEditorProps) {
  return (
    <div className="space-y-4">
      <FieldGroup
        label="Condition Expression"
        hint="JavaScript expression that evaluates to true or false"
      >
        <textarea
          value={(config.expression as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, expression: e.target.value })}
          className={clsx(inputClasses, 'min-h-[60px] resize-y font-mono')}
          placeholder="{{context.steps.previous.output.status}} === 'approved'"
          rows={2}
        />
      </FieldGroup>

      {/* Branch indicators */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-success/30 bg-success-subtle p-3">
          <p className="text-xs font-medium text-success mb-1">Then Branch</p>
          <p className="text-xs text-muted">Executes when condition is true</p>
        </div>
        <div className="rounded-lg border border-warning/30 bg-warning-subtle p-3">
          <p className="text-xs font-medium text-warning mb-1">Else Branch</p>
          <p className="text-xs text-muted">Executes when condition is false</p>
        </div>
      </div>
    </div>
  );
}

function DelayConfig({ config, onConfigChange }: ConfigEditorProps) {
  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <div className="flex-1">
          <FieldGroup label="Duration">
            <input
              type="number"
              value={(config.duration as number) ?? 1}
              onChange={(e) =>
                onConfigChange({ ...config, duration: parseInt(e.target.value, 10) || 1 })
              }
              className={inputClasses}
              min={1}
            />
          </FieldGroup>
        </div>
        <div className="w-36 shrink-0">
          <FieldGroup label="Unit">
            <select
              value={(config.unit as string) ?? 'seconds'}
              onChange={(e) => onConfigChange({ ...config, unit: e.target.value })}
              className={inputClasses}
            >
              {DELAY_UNITS.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </select>
          </FieldGroup>
        </div>
      </div>
    </div>
  );
}

function LoopConfig({ config, onConfigChange }: ConfigEditorProps) {
  return (
    <div className="space-y-4">
      <FieldGroup
        label="Collection Expression"
        hint="Expression that resolves to an array to iterate over"
      >
        <input
          type="text"
          value={(config.collection as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, collection: e.target.value })}
          className={clsx(inputClasses, 'font-mono')}
          placeholder="{{context.steps.fetch_items.output.items}}"
        />
      </FieldGroup>

      <FieldGroup
        label="Item Variable Name"
        hint="Variable name to reference the current item within the loop body"
      >
        <input
          type="text"
          value={(config.itemVariable as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, itemVariable: e.target.value })}
          className={clsx(inputClasses, 'font-mono')}
          placeholder="item"
        />
      </FieldGroup>
    </div>
  );
}

function ParallelConfig({ config, onConfigChange }: ConfigEditorProps) {
  const branches = (config.branches as Array<{ name: string }>) ?? [];

  const handleAddBranch = () => {
    const newBranches = [...branches, { name: `Branch ${branches.length + 1}` }];
    onConfigChange({ ...config, branches: newBranches });
  };

  const handleBranchNameChange = (index: number, name: string) => {
    const newBranches = branches.map((b, i) => (i === index ? { ...b, name } : b));
    onConfigChange({ ...config, branches: newBranches });
  };

  const handleRemoveBranch = (index: number) => {
    const newBranches = branches.filter((_, i) => i !== index);
    onConfigChange({ ...config, branches: newBranches });
  };

  return (
    <div className="space-y-4">
      <FieldGroup label="Branches">
        <div className="space-y-2">
          {branches.map((branch, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                type="text"
                value={branch.name}
                onChange={(e) => handleBranchNameChange(idx, e.target.value)}
                className={clsx(inputClasses, 'flex-1')}
                placeholder={`Branch ${idx + 1}`}
              />
              <button
                onClick={() => handleRemoveBranch(idx)}
                className="p-2 text-subtle hover:text-error transition-fast rounded-lg hover:bg-error-subtle"
                aria-label={`Remove branch ${idx + 1}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <button
            onClick={handleAddBranch}
            className={clsx(
              'w-full py-2 rounded-lg border border-dashed border-default',
              'text-xs text-muted hover:text-accent hover:border-accent hover:bg-accent-subtle',
              'transition-default',
            )}
          >
            + Add Branch
          </button>
        </div>
      </FieldGroup>

      <FieldGroup label="Failure Strategy" hint="How to handle failures across parallel branches">
        <select
          value={(config.failureStrategy as string) ?? 'fail_fast'}
          onChange={(e) => onConfigChange({ ...config, failureStrategy: e.target.value })}
          className={inputClasses}
        >
          <option value="fail_fast">Fail Fast - Stop all branches on first failure</option>
          <option value="wait_all">Wait All - Continue until all branches complete</option>
        </select>
      </FieldGroup>
    </div>
  );
}

function ApprovalConfig({ config, onConfigChange }: ConfigEditorProps) {
  return (
    <div className="space-y-4">
      <FieldGroup label="Title" hint="Displayed to approvers in the approval request">
        <input
          type="text"
          value={(config.title as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, title: e.target.value })}
          className={inputClasses}
          placeholder="Review and approve order #{{context.trigger.payload.orderId}}"
        />
      </FieldGroup>

      <FieldGroup label="Description">
        <textarea
          value={(config.description as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, description: e.target.value })}
          className={clsx(inputClasses, 'min-h-[60px] resize-y')}
          placeholder="Please review the following details before approving..."
          rows={2}
        />
      </FieldGroup>

      <FieldGroup label="Approvers" hint="Comma-separated list of approver emails or user IDs">
        <input
          type="text"
          value={(config.approvers as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, approvers: e.target.value })}
          className={inputClasses}
          placeholder="admin@company.com, manager@company.com"
        />
      </FieldGroup>

      <FieldGroup label="Timeout (hours)" hint="How long to wait for approval before timing out">
        <input
          type="number"
          value={(config.timeoutHours as number) ?? 24}
          onChange={(e) =>
            onConfigChange({ ...config, timeoutHours: parseInt(e.target.value, 10) || 24 })
          }
          className={inputClasses}
          min={1}
          max={720}
        />
      </FieldGroup>
    </div>
  );
}

function TransformConfig({ config, onConfigChange }: ConfigEditorProps) {
  return (
    <div className="space-y-4">
      <FieldGroup
        label="Input Expression"
        hint="Expression to transform. Supports {{expression}} syntax."
      >
        <textarea
          value={(config.inputExpression as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, inputExpression: e.target.value })}
          className={clsx(inputClasses, 'min-h-[80px] resize-y font-mono')}
          placeholder="{{context.steps.fetch_data.output.items}}.filter(i => i.active)"
          rows={3}
        />
      </FieldGroup>

      <FieldGroup label="Output Variable Name" hint="Variable name to store the transformed result">
        <input
          type="text"
          value={(config.outputVariable as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, outputVariable: e.target.value })}
          className={clsx(inputClasses, 'font-mono')}
          placeholder="filteredItems"
        />
      </FieldGroup>
    </div>
  );
}

function ToolCallConfig({ config, onConfigChange }: ConfigEditorProps) {
  return (
    <div className="space-y-4">
      <FieldGroup label="Tool Name">
        <input
          type="text"
          value={(config.toolName as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, toolName: e.target.value })}
          className={inputClasses}
          placeholder="e.g. search_documents"
        />
      </FieldGroup>
      <FieldGroup
        label="Parameters (JSON)"
        hint="Use {{expression}} to reference previous step outputs"
      >
        <textarea
          value={(config.params as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, params: e.target.value })}
          className={clsx(inputClasses, 'min-h-[80px] resize-y font-mono')}
          placeholder='{"query": "search term"}'
          rows={4}
        />
      </FieldGroup>
    </div>
  );
}

function AsyncWebhookConfig({ config, onConfigChange }: ConfigEditorProps) {
  return (
    <div className="space-y-4">
      <FieldGroup label="URL" hint="Supports {{expression}} syntax">
        <input
          type="text"
          value={(config.url as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, url: e.target.value })}
          className={inputClasses}
          placeholder="https://api.example.com/webhook"
        />
      </FieldGroup>
      <FieldGroup label="Method">
        <select
          value={(config.method as string) ?? 'POST'}
          onChange={(e) => onConfigChange({ ...config, method: e.target.value })}
          className={inputClasses}
        >
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="PATCH">PATCH</option>
        </select>
      </FieldGroup>
      <FieldGroup label="Headers (JSON)" hint="JSON object of key-value pairs">
        <textarea
          value={(config.headers as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, headers: e.target.value })}
          className={clsx(inputClasses, 'min-h-[60px] resize-y font-mono')}
          rows={3}
        />
      </FieldGroup>
      <FieldGroup label="Body (JSON)" hint="Request body. Use {{expression}} for dynamic values.">
        <textarea
          value={(config.body as string) ?? ''}
          onChange={(e) => onConfigChange({ ...config, body: e.target.value })}
          className={clsx(inputClasses, 'min-h-[80px] resize-y font-mono')}
          rows={4}
        />
      </FieldGroup>
      <FieldGroup
        label="Callback URL Field"
        hint="Field name in the response that contains the callback URL"
      >
        <input
          type="text"
          value={(config.callbackUrlField as string) ?? 'callbackUrl'}
          onChange={(e) => onConfigChange({ ...config, callbackUrlField: e.target.value })}
          className={inputClasses}
          placeholder="callbackUrl"
        />
      </FieldGroup>
    </div>
  );
}

// =============================================================================
// CONFIG EDITOR DISPATCH
// =============================================================================

const configEditors: Record<string, React.ComponentType<ConfigEditorProps>> = {
  connector_action: ConnectorActionConfig,
  http: HttpRequestConfig,
  agent_invocation: AgentInvocationConfig,
  condition: ConditionConfig,
  delay: DelayConfig,
  loop: LoopConfig,
  parallel: ParallelConfig,
  approval: ApprovalConfig,
  transform: TransformConfig,
  tool_call: ToolCallConfig,
  async_webhook: AsyncWebhookConfig,
};

// =============================================================================
// MAIN COMPONENT
// =============================================================================

const DELETE_CONFIRM_TIMEOUT_MS = 3000;

export function StepEditor({ step, onChange, onDelete }: StepEditorProps) {
  const IconComponent = stepTypeIcons[step.type] ?? Wand2;
  const typeLabel = stepTypeLabels[step.type] ?? step.type;
  const ConfigEditor = configEditors[step.type];
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Auto-reset confirmation after timeout
  useEffect(() => {
    if (!confirmingDelete) return;
    const timer = setTimeout(() => setConfirmingDelete(false), DELETE_CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [confirmingDelete]);

  // Reset confirmation when step changes
  useEffect(() => {
    setConfirmingDelete(false);
  }, [step.id]);

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange({ ...step, name: e.target.value });
    },
    [step, onChange],
  );

  const handleConfigChange = useCallback(
    (config: Record<string, unknown>) => {
      onChange({ ...step, config });
    },
    [step, onChange],
  );

  const handleDelete = useCallback(() => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    onDelete(step.id);
  }, [step.id, onDelete, confirmingDelete]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-default">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-accent-subtle text-accent">
          <IconComponent className="w-4 h-4" />
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground">{typeLabel}</p>
          <p className="text-xs text-muted">Step Configuration</p>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-5 space-y-6">
        {/* Step Name */}
        <FieldGroup label="Step Name">
          <input
            type="text"
            value={step.name}
            onChange={handleNameChange}
            className={inputClasses}
            placeholder={typeLabel}
          />
        </FieldGroup>

        {/* Divider */}
        <div className="border-t border-default" />

        {/* Type-specific configuration */}
        {ConfigEditor ? (
          <ConfigEditor config={step.config ?? {}} onConfigChange={handleConfigChange} />
        ) : (
          <div className="text-center py-8">
            <p className="text-sm text-muted">
              No configuration editor available for step type: {step.type}
            </p>
          </div>
        )}
      </div>

      {/* Footer: Delete button with confirmation */}
      <div className="px-5 py-4 border-t border-default">
        <button
          onClick={handleDelete}
          className={clsx(
            'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium',
            'transition-default focus-ring',
            confirmingDelete
              ? 'bg-error text-error-foreground hover:bg-error/90'
              : 'text-error hover:bg-error-subtle',
          )}
        >
          <Trash2 className="w-4 h-4" />
          {confirmingDelete ? 'Confirm Delete?' : 'Delete Step'}
        </button>
      </div>
    </div>
  );
}
