'use client';

/**
 * WorkflowOverviewTab Component
 *
 * Displays editable workflow name, description, metadata,
 * trigger summary, and step count. Save button persists edits.
 */

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import { Check, Calendar, Clock, Zap, ListOrdered, Bot } from 'lucide-react';
import clsx from 'clsx';
import type { WorkflowDetail, WorkflowUsage } from '../../../api/workflows';
import { updateWorkflow, getWorkflowUsage } from '../../../api/workflows';
import { sanitizeError } from '../../../lib/sanitize-error';
import { Button } from '../../ui/Button';
import { Badge } from '../../ui/Badge';

// =============================================================================
// HELPERS
// =============================================================================

function formatDate(dateStr: string | undefined | null): string {
  if (!dateStr) return '—';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function triggerTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    webhook: 'Webhook',
    cron: 'Cron Schedule',
    event: 'Event',
  };
  return labels[type] ?? type;
}

// =============================================================================
// PROPS
// =============================================================================

interface WorkflowOverviewTabProps {
  workflow: WorkflowDetail;
  projectId: string;
  onSaved: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function WorkflowOverviewTab({ workflow, projectId, onSaved }: WorkflowOverviewTabProps) {
  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Phase 1 usage rollup — which `type: workflow` project tools wrap this
  // workflow. Fetched once per visit (no polling); `toolCount > 0` is how
  // we currently detect "used by agents" since agents consume workflows
  // exclusively through tool bindings.
  const { data: usage } = useSWR<WorkflowUsage>(
    projectId && workflow.id ? `workflow-usage:${projectId}:${workflow.id}` : null,
    () => getWorkflowUsage(projectId, workflow.id),
  );

  const isDirty = name !== workflow.name || description !== (workflow.description ?? '');

  const handleSave = useCallback(async () => {
    if (!isDirty) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await updateWorkflow(projectId, workflow.id, { name, description });
      onSaved();
    } catch (err) {
      const message = sanitizeError(err, 'Failed to save workflow');
      setSaveError(message);
    } finally {
      setIsSaving(false);
    }
  }, [projectId, workflow.id, name, description, isDirty, onSaved]);

  return (
    <div className="space-y-6">
      {/* Editable fields card */}
      <div className="rounded-xl border border-default bg-background-elevated p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-foreground mb-4">Details</h2>

        <div className="space-y-4">
          {/* Name */}
          <div>
            <label
              htmlFor="workflow-name"
              className="block text-sm font-medium text-foreground mb-1.5"
            >
              Name
            </label>
            <input
              id="workflow-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={30}
              className={clsx(
                'w-full px-3 py-2 rounded-lg text-sm',
                'bg-background border border-default text-foreground',
                'placeholder:text-muted',
                'focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus/30',
                'transition-default',
              )}
              placeholder="Workflow name"
            />
            <p className="text-xs text-subtle text-right mt-0.5">{name.length} / 30</p>
          </div>

          {/* Description */}
          <div>
            <label
              htmlFor="workflow-description"
              className="block text-sm font-medium text-foreground mb-1.5"
            >
              Description
            </label>
            <textarea
              id="workflow-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={500}
              className={clsx(
                'w-full px-3 py-2 rounded-lg text-sm resize-none',
                'bg-background border border-default text-foreground',
                'placeholder:text-muted',
                'focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus/30',
                'transition-default',
              )}
              placeholder="Describe what this workflow does..."
            />
            <p className="text-xs text-subtle text-right mt-0.5">{description.length} / 500</p>
          </div>

          {/* Save button + error */}
          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={!isDirty}
              loading={isSaving}
              icon={<Check className="w-3.5 h-3.5" />}
            >
              Save Changes
            </Button>
            {saveError && <span className="text-xs text-error">{saveError}</span>}
          </div>
        </div>
      </div>

      {/* Metadata card */}
      <div className="rounded-xl border border-default bg-background-elevated p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-foreground mb-4">Metadata</h2>

        <div className="grid grid-cols-2 gap-4">
          {/* Created */}
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-background-muted flex items-center justify-center shrink-0">
              <Calendar className="w-4 h-4 text-muted" />
            </div>
            <div>
              <p className="text-xs text-muted">Created</p>
              <p className="text-sm text-foreground">{formatDate(workflow.createdAt)}</p>
            </div>
          </div>

          {/* Updated */}
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-background-muted flex items-center justify-center shrink-0">
              <Clock className="w-4 h-4 text-muted" />
            </div>
            <div>
              <p className="text-xs text-muted">Last Updated</p>
              <p className="text-sm text-foreground">{formatDate(workflow.updatedAt)}</p>
            </div>
          </div>

          {/* Trigger summary — reads from the denormalized workflow.triggers[]
              array (synced by TriggerEngine on register/deregister). For the
              full canonical trigger state, see WorkflowTriggersTab which reads
              from the TriggerRegistration collection directly. */}
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-background-muted flex items-center justify-center shrink-0">
              <Zap className="w-4 h-4 text-muted" />
            </div>
            <div>
              <p className="text-xs text-muted">Triggers</p>
              <div className="flex items-center gap-1.5 mt-0.5">
                {workflow.triggers.length > 0 ? (
                  workflow.triggers.map((trigger) => (
                    <Badge key={trigger.id} variant="info">
                      {triggerTypeLabel(trigger.triggerType)}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted">No triggers configured</span>
                )}
              </div>
            </div>
          </div>

          {/* Step count */}
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-background-muted flex items-center justify-center shrink-0">
              <ListOrdered className="w-4 h-4 text-muted" />
            </div>
            <div>
              <p className="text-xs text-muted">Steps</p>
              <p className="text-sm text-foreground">
                {(() => {
                  const count =
                    workflow.steps?.length ||
                    ((workflow as any).nodes ?? []).filter(
                      (n: any) => n.type !== 'startNode' && n.type !== 'endNode',
                    ).length ||
                    0;
                  return `${count} ${count === 1 ? 'step' : 'steps'}`;
                })()}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Used by — tools that wrap this workflow. The count here matches the
          "N agents" chip on the workflow card in the list page, with the
          caveat that we count tools, not agents themselves. Phase 2 will
          walk from tools to the agents binding them. */}
      <div className="rounded-xl border border-default bg-background-elevated p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-foreground mb-4">Used by</h2>
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-background-muted flex items-center justify-center shrink-0">
            <Bot className="w-4 h-4 text-muted" />
          </div>
          <div className="flex-1">
            <p className="text-xs text-muted">Workflow tools referencing this workflow</p>
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              {usage === undefined ? (
                <span className="text-sm text-muted">Loading...</span>
              ) : usage.tools.length > 0 ? (
                usage.tools.map((tool) => (
                  <span key={tool.id} title={tool.description ?? undefined} className="inline-flex">
                    <Badge variant="info">{tool.name}</Badge>
                  </span>
                ))
              ) : (
                <span className="text-sm text-muted">
                  No tools reference this workflow yet. Agents use workflows via{' '}
                  <code className="font-mono text-xs">type: workflow</code> tools.
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Last run info */}
      {workflow.lastRunAt && (
        <div className="rounded-xl border border-default bg-background-elevated p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-accent-subtle flex items-center justify-center shrink-0">
              <Clock className="w-4 h-4 text-accent" />
            </div>
            <div>
              <p className="text-xs text-muted">Last Run</p>
              <p className="text-sm text-foreground">{formatDate(workflow.lastRunAt)}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
