/**
 * Auto-reply policy for arch-eval harness.
 *
 * Inspects an interactive_tool event and returns the answer payload to send back.
 * Falls back to `null` (skip) when no answer is appropriate; the orchestrator
 * treats that as a stop condition.
 *
 * Patterns are matched on widget kind, tool name, question text, and option
 * values. Designed for the ONBOARDING happy path; intentionally permissive so a
 * prompt change in arch-ai doesn't immediately break the harness.
 */

import type { Scenario } from './scenarios.js';

export interface InteractiveToolEvent {
  type: 'interactive_tool';
  tool: string;
  toolCallId: string;
  kind: 'tool' | 'gate';
  payload: Record<string, unknown>;
}

export type AutoReplyResult =
  | { kind: 'answer'; toolCallId: string; answer: unknown }
  | { kind: 'skip'; reason: string }
  | { kind: 'stop'; reason: string };

const ASK_USER_FIELDS = [
  'question',
  'widgetType',
  'options',
  'allowCustom',
  'defaultValue',
  'defaultValues',
  'multiline',
  'minSelect',
  'maxSelect',
] as const;

interface AskUserPayload {
  question?: string;
  widgetType?: string;
  options?: Array<{ label: string; value: string }>;
  allowCustom?: boolean;
  defaultValue?: string;
  defaultValues?: string[];
  multiline?: boolean;
  minSelect?: number;
  maxSelect?: number;
}

interface CollectFilePayload {
  message?: string;
  accept?: string[];
  maxFiles?: number;
}

function pickOptionByValue(
  options: Array<{ label: string; value: string }> | undefined,
  preferredValues: string[],
): string | null {
  if (!options) return null;
  for (const v of preferredValues) {
    const hit = options.find((o) => o.value === v);
    if (hit) return hit.value;
  }
  return null;
}

function questionMatches(question: string | undefined, keywords: string[]): boolean {
  if (!question) return false;
  const lower = question.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

export function decideReply(
  event: InteractiveToolEvent,
  scenario: Scenario,
  history: { tool: string; question: string | undefined }[],
): AutoReplyResult {
  const payload = event.payload as Record<string, unknown> | undefined;
  const options = (payload?.options as Array<{ label: string; value: string }> | undefined) ?? [];

  // Build-complete widgets advance to project creation only when the BUILD
  // result actually offers that action. Error-state build cards may offer only
  // retry/modify/back; answering "create" there produces a false harness
  // failure rather than a real product failure.
  if (event.toolCallId.startsWith('build-complete-')) {
    const create = pickOptionByValue(options, ['create', 'create_project']);
    if (create) {
      return { kind: 'answer', toolCallId: event.toolCallId, answer: create };
    }
    const retry = pickOptionByValue(options, ['retry', 'retry_failed_agents']);
    if (retry) {
      return { kind: 'answer', toolCallId: event.toolCallId, answer: retry };
    }
    return { kind: 'stop', reason: 'BuildComplete did not offer create or retry' };
  }

  // Topology-approval gate widgets always accept.
  if (event.toolCallId.startsWith('widget_')) {
    if (payload && (payload.topology || payload.agents || payload.entryPoint)) {
      return { kind: 'answer', toolCallId: event.toolCallId, answer: 'accept' };
    }
  }

  if (event.tool === 'collect_file') {
    return { kind: 'answer', toolCallId: event.toolCallId, answer: { blobIds: [] } };
  }

  if (event.tool !== 'ask_user') {
    return { kind: 'skip', reason: `Unsupported interactive tool: ${event.tool}` };
  }

  const p = event.payload as AskUserPayload;
  const question = p.question ?? '';

  // Confirmation widgets — accept by default.
  if (p.widgetType === 'Confirmation') {
    return { kind: 'answer', toolCallId: event.toolCallId, answer: true };
  }

  // BlueprintConfirm — emitted at start of BLUEPRINT to pick concept-vs-draft.
  if (p.widgetType === 'BlueprintConfirm') {
    const generate = pickOptionByValue(p.options, [
      'generate_draft_topology',
      'generate',
      'draft',
      'proceed',
    ]);
    if (generate) {
      return { kind: 'answer', toolCallId: event.toolCallId, answer: generate };
    }
    if (p.options?.length) {
      return { kind: 'answer', toolCallId: event.toolCallId, answer: p.options[0].value };
    }
  }

  // TopologyApprove / BuildApprove gate widgets (legacy emit as ask_user
  // tool_call with widget_<...> id and a topology/agents payload — the caller
  // already handled those by toolCallId prefix; this branch covers any other
  // widgetType that the legacy stream might emit).
  if (
    p.widgetType === 'TopologyApprove' ||
    p.widgetType === 'TopologyApproval' ||
    p.widgetType === 'BlueprintApprove'
  ) {
    return { kind: 'answer', toolCallId: event.toolCallId, answer: 'accept' };
  }

  if (p.widgetType === 'BuildComplete' || p.widgetType === 'CreateProjectConfirm') {
    return { kind: 'answer', toolCallId: event.toolCallId, answer: 'create' };
  }

  // SingleSelect that includes 'proceed' / 'accept' / create values.
  if (p.widgetType === 'SingleSelect') {
    const proceed = pickOptionByValue(p.options, [
      'proceed',
      'accept',
      'create',
      'create_project',
      'generate_draft_topology',
    ]);
    if (proceed) {
      return { kind: 'answer', toolCallId: event.toolCallId, answer: proceed };
    }

    if (questionMatches(question, ['call your project', 'project name', 'name your project'])) {
      // Always use scenario's preferred project name (allowCustom should be true).
      // If the LLM is re-asking because the name was taken, append a unique suffix
      // so we don't loop forever. Detect repeat-asks via prior history.
      const askedBefore = history.filter((h) =>
        (h.question ?? '').toLowerCase().match(/project name|call your project|name your project/),
      ).length;
      const taken =
        question.toLowerCase().includes('already taken') ||
        question.toLowerCase().includes('still taken');
      const suffix = taken || askedBefore > 0 ? ` ${Date.now().toString(36).slice(-5)}` : '';
      return {
        kind: 'answer',
        toolCallId: event.toolCallId,
        answer: `${scenario.projectName}${suffix}`,
      };
    }

    if (questionMatches(question, ['language'])) {
      const opt = pickOptionByValue(p.options, [scenario.language]);
      return { kind: 'answer', toolCallId: event.toolCallId, answer: opt ?? scenario.language };
    }

    // Fallback: pick defaultValue if set, else first option.
    if (p.defaultValue) {
      return { kind: 'answer', toolCallId: event.toolCallId, answer: p.defaultValue };
    }
    if (p.options?.length) {
      return { kind: 'answer', toolCallId: event.toolCallId, answer: p.options[0].value };
    }
    return { kind: 'stop', reason: 'SingleSelect with no options or default' };
  }

  if (p.widgetType === 'MultiSelect') {
    if (questionMatches(question, ['channel'])) {
      return {
        kind: 'answer',
        toolCallId: event.toolCallId,
        answer: scenario.channels,
      };
    }
    if (p.defaultValues?.length) {
      return { kind: 'answer', toolCallId: event.toolCallId, answer: p.defaultValues };
    }
    if (p.options?.length) {
      return {
        kind: 'answer',
        toolCallId: event.toolCallId,
        answer: [p.options[0].value],
      };
    }
    return { kind: 'stop', reason: 'MultiSelect with no options or defaults' };
  }

  if (p.widgetType === 'TextInput') {
    if (questionMatches(question, ['capabilit', 'feature', 'workflow'])) {
      return {
        kind: 'answer',
        toolCallId: event.toolCallId,
        answer: scenario.capabilities,
      };
    }
    if (questionMatches(question, ['name'])) {
      return { kind: 'answer', toolCallId: event.toolCallId, answer: scenario.projectName };
    }
    if (p.defaultValue) {
      return { kind: 'answer', toolCallId: event.toolCallId, answer: p.defaultValue };
    }
    return {
      kind: 'answer',
      toolCallId: event.toolCallId,
      answer: scenario.capabilities,
    };
  }

  return {
    kind: 'skip',
    reason: `Unhandled widgetType ${p.widgetType ?? 'unknown'}`,
  };
}

export type { AskUserPayload, CollectFilePayload };
export { ASK_USER_FIELDS };
