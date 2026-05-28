'use client';

import { SingleSelect } from './SingleSelect';
import { MultiSelect } from './MultiSelect';
import { TextInput } from './TextInput';
import { Confirmation } from './Confirmation';
import { FileUpload } from './FileUpload';
import { SecretInput } from './SecretInput';
import { GateRequestCard } from './GateRequestCard';
import { BlueprintConfirmCard } from './BlueprintConfirmCard';
import { TopologyApprovalCard } from './TopologyApprovalCard';
import { TopologyRevisionCard } from './TopologyRevisionCard';
import { ModelComparisonWidget } from './ModelComparisonWidget';
import { ConstraintCoverageWidget } from './ConstraintCoverageWidget';
import { OAuthLaunch, type OAuthLaunchInput } from './OAuthLaunch';
import { IntegrationPlan, type IntegrationPlanInput } from './IntegrationPlan';
import { BuildCompleteCard } from '../chat/BuildCompleteCard';
import { Lock } from 'lucide-react';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';
import type { FileUploadInput, WidgetInput } from './types';

interface WidgetRendererProps {
  toolCallId: string;
  toolName: string;
  input: WidgetInput | Record<string, unknown> | undefined;
  requestId?: string;
  onSubmit: (
    toolCallId: string,
    answer: unknown,
    secrets?: { flowId: string; values: Record<string, string> },
  ) => void;
  /** If set, the widget was already answered — render the submitted summary instead. */
  answeredResult?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function summarizeAnsweredResult(answeredResult: unknown): string | null {
  if (
    isObject(answeredResult) &&
    typeof answeredResult.summary === 'string' &&
    answeredResult.summary.trim().length > 0
  ) {
    return answeredResult.summary.trim();
  }

  return null;
}

function hasQuestion(value: unknown): value is Record<'question', string> {
  return isObject(value) && typeof value.question === 'string';
}

function displayQuestion(question: string): string {
  return question.replace(/draft topology/gi, (match) =>
    match === 'Draft topology' ? 'Draft blueprint' : 'draft blueprint',
  );
}

function displayBlueprintConfirmLabel(label: string): string {
  return label === 'Generate draft topology' ? 'Generate draft blueprint' : label;
}

function isFileUploadInput(value: unknown): value is FileUploadInput {
  return (
    isObject(value) &&
    typeof value.message === 'string' &&
    (value.widgetType === undefined || value.widgetType === 'FileUpload') &&
    (value.accept === undefined ||
      (Array.isArray(value.accept) && value.accept.every((entry) => typeof entry === 'string'))) &&
    (value.maxFiles === undefined || typeof value.maxFiles === 'number')
  );
}

function isSingleSelectInput(
  value: unknown,
): value is Extract<WidgetInput, { widgetType: 'SingleSelect' }> {
  return isObject(value) && value.widgetType === 'SingleSelect';
}

function isMultiSelectInput(
  value: unknown,
): value is Extract<WidgetInput, { widgetType: 'MultiSelect' }> {
  return isObject(value) && value.widgetType === 'MultiSelect';
}

function isTextInputInput(
  value: unknown,
): value is Extract<WidgetInput, { widgetType: 'TextInput' }> {
  return isObject(value) && value.widgetType === 'TextInput';
}

function isConfirmationInput(
  value: unknown,
): value is Extract<WidgetInput, { widgetType: 'Confirmation' }> {
  return isObject(value) && value.widgetType === 'Confirmation';
}

function isProposalConfirmationInput(
  value: Extract<WidgetInput, { widgetType: 'Confirmation' }>,
): boolean {
  const actionLooksLikeProposal =
    /\b(apply changes|approve plan|approve changes|create agent|apply)\b/i.test(value.confirmLabel);
  const promptLooksLikeProposal = /\b(proposal|proposed|change|agent|plan|apply)\b/i.test(
    value.question,
  );
  return actionLooksLikeProposal && promptLooksLikeProposal;
}

function isBlueprintConfirmInput(
  value: unknown,
): value is Extract<WidgetInput, { widgetType: 'BlueprintConfirm' }> {
  return isObject(value) && value.widgetType === 'BlueprintConfirm';
}

function isTopologyApprovalInput(
  value: unknown,
): value is Extract<WidgetInput, { widgetType: 'TopologyApproval' }> {
  return isObject(value) && value.widgetType === 'TopologyApproval';
}

function isTopologyRevisionInput(
  value: unknown,
): value is Extract<WidgetInput, { widgetType: 'TopologyRevision' }> {
  return isObject(value) && value.widgetType === 'TopologyRevision';
}

function isBuildCompleteInput(
  value: unknown,
): value is Extract<WidgetInput, { widgetType: 'BuildComplete' }> {
  return isObject(value) && value.widgetType === 'BuildComplete';
}

function isGateRequestInput(
  value: unknown,
): value is Extract<WidgetInput, { widgetType: 'GateRequest' }> {
  return isObject(value) && value.widgetType === 'GateRequest';
}

function isOAuthLaunchInput(value: unknown): value is OAuthLaunchInput {
  return (
    isObject(value) &&
    value.widgetType === 'OAuthLaunch' &&
    typeof value.authProfileId === 'string' &&
    typeof value.authProfileRef === 'string' &&
    typeof value.connectorName === 'string' &&
    typeof value.providerLabel === 'string' &&
    Array.isArray(value.scopes)
  );
}

function isIntegrationPlanInput(value: unknown): value is IntegrationPlanInput {
  return (
    isObject(value) &&
    value.widgetType === 'IntegrationPlan' &&
    Array.isArray((value as { steps: unknown }).steps)
  );
}

/**
 * WidgetRenderer — routes tool_call SSE events to the correct widget.
 *
 * Contract 4 (sse-protocol): Render Trigger Decision
 * - tool_call with toolName "ask_user" → render ask-user widget
 * - tool_call with toolName "collect_file" → render file upload widget
 *
 * Contract 5 (widget-interaction): widgetType determines component.
 *
 * On resume: if `answeredResult` is provided, render the submitted summary
 * instead of the interactive widget (avoids re-showing answered questions).
 */
export function WidgetRenderer({
  toolCallId,
  toolName,
  input,
  requestId,
  onSubmit,
  answeredResult,
}: WidgetRendererProps) {
  const safeInput: unknown = input;
  const pendingDiffTab = useArchAIStore((state) =>
    state.artifactTabs.find((tab) => {
      if (tab.type !== 'diff' || !isObject(tab.data)) {
        return false;
      }
      return tab.data.reviewStatus === 'pending';
    }),
  );
  const setActiveTab = useArchAIStore((state) => state.setActiveTab);
  const setOverlayState = useArchAIStore((state) => state.setOverlayState);

  // Already answered — show the summary view
  // Check both undefined AND null: pending widgets store result as null in the DB,
  // which should render the interactive widget, not the answered summary.
  if (answeredResult !== undefined && answeredResult !== null) {
    const question =
      toolName === 'ask_user' && hasQuestion(safeInput) ? displayQuestion(safeInput.question) : '';
    let displayValue: string;

    if (toolName === 'collect_file' && Array.isArray(answeredResult)) {
      const fileNames = answeredResult
        .filter(isObject)
        .map((file) => (typeof file.name === 'string' ? file.name : null))
        .filter((name): name is string => Boolean(name));
      displayValue = fileNames.length > 0 ? fileNames.join(', ') : 'Files uploaded';
    } else if (isBlueprintConfirmInput(safeInput) && typeof answeredResult === 'string') {
      displayValue = displayBlueprintConfirmLabel(
        safeInput.options.find((option) => option.value === answeredResult)?.label ??
          answeredResult,
      );
    } else if (typeof answeredResult === 'string') {
      displayValue = answeredResult;
    } else if (Array.isArray(answeredResult)) {
      displayValue = answeredResult.join(', ');
    } else if (typeof answeredResult === 'boolean') {
      displayValue = answeredResult
        ? isObject(safeInput) && typeof safeInput.confirmLabel === 'string'
          ? safeInput.confirmLabel
          : 'Yes'
        : isObject(safeInput) && typeof safeInput.denyLabel === 'string'
          ? safeInput.denyLabel
          : 'No';
    } else if (
      isTopologyApprovalInput(safeInput) &&
      isObject(answeredResult) &&
      typeof answeredResult.action === 'string'
    ) {
      const notes =
        typeof answeredResult.notes === 'string' && answeredResult.notes.trim().length > 0
          ? ` — ${answeredResult.notes.trim()}`
          : '';
      displayValue = `${answeredResult.action}${notes}`;
    } else if (
      isTopologyRevisionInput(safeInput) &&
      isObject(answeredResult) &&
      Array.isArray(answeredResult.targets)
    ) {
      const labels = answeredResult.targets
        .filter((target): target is string => typeof target === 'string')
        .map(
          (target) => safeInput.options.find((option) => option.value === target)?.label ?? target,
        );
      const notes =
        typeof answeredResult.notes === 'string' && answeredResult.notes.trim().length > 0
          ? ` — ${answeredResult.notes.trim()}`
          : '';
      displayValue = `${labels.join(', ')}${notes}`;
    } else if (summarizeAnsweredResult(answeredResult)) {
      displayValue = summarizeAnsweredResult(answeredResult)!;
    } else {
      displayValue = JSON.stringify(answeredResult);
    }

    // collect_secret answered summary — show lock icon, never the secret value
    if (toolName === 'collect_secret') {
      const secretLabel =
        isObject(safeInput) && typeof safeInput.label === 'string' ? safeInput.label : 'Secret';
      return (
        <div className="mt-1">
          <p className="mb-2 text-[15px] leading-relaxed text-foreground/80">{secretLabel}</p>
          <div className="flex items-center gap-2 rounded-xl border border-border/20 bg-background-subtle px-4 py-3 text-sm text-foreground-muted">
            <Lock className="h-3.5 w-3.5 flex-shrink-0" />
            <span>Secret collected</span>
          </div>
        </div>
      );
    }

    return (
      <div className="mt-1">
        {question && (
          <p className="mb-2 text-[15px] leading-relaxed text-foreground/80">{question}</p>
        )}
        <div className="rounded-xl border border-border/20 bg-background-subtle px-4 py-3 text-sm text-foreground-muted">
          {displayValue}
        </div>
      </div>
    );
  }

  const handleSubmit = (
    answer: unknown,
    secrets?: { flowId: string; values: Record<string, string> },
  ) => {
    onSubmit(toolCallId, answer, secrets);
  };

  // collect_file tool always renders FileUpload
  if (toolName === 'collect_file') {
    if (!isFileUploadInput(safeInput)) {
      return (
        <div className="mt-1 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-foreground-muted">
          Arch asked for a file upload, but the upload widget data could not be restored. Please
          retry the request.
        </div>
      );
    }

    return (
      <div className="mt-1">
        <p className="mb-2 text-[15px] leading-relaxed text-foreground/80">{safeInput.message}</p>
        <FileUpload input={safeInput} onSubmit={handleSubmit} />
      </div>
    );
  }

  // collect_secret tool — render password input
  if (toolName === 'collect_secret' && isObject(safeInput)) {
    const secretInput = safeInput as { flowId: string; field: string; label: string };
    return (
      <div className="mt-1">
        <SecretInput
          input={secretInput}
          onSubmit={(answer, secrets) => {
            handleSubmit(answer, secrets);
          }}
        />
      </div>
    );
  }

  // BuildComplete widget — full-panel layout, handled before generic ask_user routing
  if (toolName === 'ask_user' && isBuildCompleteInput(safeInput)) {
    return (
      <div className="my-4">
        <BuildCompleteCard
          toolCallId={toolCallId}
          input={safeInput}
          onSubmit={handleSubmit}
          answeredResult={answeredResult}
          requestId={requestId}
        />
      </div>
    );
  }

  // ask_user tool — switch on widgetType
  if (toolName === 'ask_user') {
    if (!isObject(safeInput) || typeof safeInput.widgetType !== 'string') {
      return (
        <div className="mt-1 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-foreground-muted">
          This question is waiting for input, but its widget data could not be restored. Please
          retry the request.
        </div>
      );
    }

    const question = hasQuestion(safeInput) ? displayQuestion(safeInput.question) : '';
    const widgetOwnsHeading =
      isBlueprintConfirmInput(safeInput) ||
      isTopologyApprovalInput(safeInput) ||
      isTopologyRevisionInput(safeInput);

    return (
      <div className="mt-1">
        {!widgetOwnsHeading && question ? (
          <p className="mb-2 text-[15px] leading-relaxed text-foreground/80">{question}</p>
        ) : null}
        {isSingleSelectInput(safeInput) && (
          <SingleSelect input={safeInput} onSubmit={handleSubmit} />
        )}
        {isMultiSelectInput(safeInput) && <MultiSelect input={safeInput} onSubmit={handleSubmit} />}
        {isTextInputInput(safeInput) && <TextInput input={safeInput} onSubmit={handleSubmit} />}
        {isConfirmationInput(safeInput) && (
          <Confirmation
            input={safeInput}
            onSubmit={handleSubmit}
            statusMirror={
              pendingDiffTab && isProposalConfirmationInput(safeInput)
                ? {
                    label: 'Proposal pending in the review panel.',
                    onJumpToPanel: () => {
                      setActiveTab(pendingDiffTab.id);
                      setOverlayState('artifacts');
                    },
                  }
                : undefined
            }
          />
        )}
        {isBlueprintConfirmInput(safeInput) && (
          <BlueprintConfirmCard input={safeInput} onSubmit={handleSubmit} />
        )}
        {isTopologyApprovalInput(safeInput) && (
          <TopologyApprovalCard input={safeInput} onSubmit={handleSubmit} />
        )}
        {isTopologyRevisionInput(safeInput) && (
          <TopologyRevisionCard input={safeInput} onSubmit={handleSubmit} />
        )}
        {isOAuthLaunchInput(safeInput) && <OAuthLaunch input={safeInput} onSubmit={handleSubmit} />}
        {isIntegrationPlanInput(safeInput) && (
          <IntegrationPlan input={safeInput} onSubmit={handleSubmit} />
        )}
      </div>
    );
  }

  if (toolName === 'gate_request' && isGateRequestInput(safeInput)) {
    return (
      <div className="mt-1">
        <GateRequestCard input={safeInput} onSubmit={handleSubmit} />
      </div>
    );
  }

  // B20: recommend_model tool — render rich comparison widget for answered results
  if (toolName === 'recommend_model' && answeredResult !== undefined && isObject(answeredResult)) {
    const data = answeredResult as Record<string, unknown>;
    if (data.primary || data.recommendations) {
      return (
        <ModelComparisonWidget
          data={data as unknown as Parameters<typeof ModelComparisonWidget>[0]['data']}
        />
      );
    }
  }

  // B23: analyze_constraints tool — render coverage matrix widget for answered results
  if (
    toolName === 'analyze_constraints' &&
    answeredResult !== undefined &&
    isObject(answeredResult)
  ) {
    const data = answeredResult as Record<string, unknown>;
    if (data.coverage && data.summary) {
      return (
        <ConstraintCoverageWidget
          data={data as unknown as Parameters<typeof ConstraintCoverageWidget>[0]['data']}
        />
      );
    }
  }

  return null;
}
