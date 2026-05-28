'use client';

import { useId, useMemo, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { ChevronDown, Ear, MessageCircle, MessageSquare, X } from 'lucide-react';
import { Badge } from '../ui/Badge';
import { SectionCard } from './SectionCard';
import {
  INLINE_INPUT_CLASSES,
  INLINE_SELECT_CLASSES,
  INLINE_TEXTAREA_CLASSES,
} from './inline-input-classes';
import type {
  BehaviorSectionData,
  ConversationBehaviorData,
  SaveStatus,
} from '@/store/agent-detail-store';

const BOOLEAN_OPTIONS = [
  { label: 'Inherit', value: '' },
  { label: 'Yes', value: 'true' },
  { label: 'No', value: 'false' },
] as const;

const LANGUAGE_POLICY_OPTIONS = [
  { label: 'Inherit', value: '' },
  { label: 'Interaction Context', value: 'interaction_context' },
  { label: 'Agent Default', value: 'agent_default' },
  { label: 'Fixed', value: 'fixed' },
] as const;

const TOOL_LEAD_IN_OPTIONS = [
  { label: 'Inherit', value: '' },
  { label: 'Silent', value: 'silent' },
  { label: 'Brief', value: 'brief' },
  { label: 'Explained', value: 'explained' },
] as const;

const LISTENING_OPTIONS = {
  bargeIn: ['', 'allow', 'disallow'],
  onPause: ['', 'wait_briefly', 'check_in'],
  onOverlap: ['', 'stop_and_listen', 'continue'],
  onUnclearAudio: ['', 'ask_to_repeat_or_confirm', 'best_effort'],
  onSelfCorrection: ['', 'follow_latest_intent', 'confirm_latest_intent'],
} as const;

const INTERACTION_OPTIONS = {
  answerShape: ['', 'answer_first', 'steps_first'],
  detail: ['', 'concise', 'balanced', 'expandable', 'thorough'],
  initiative: ['', 'reactive', 'guided', 'proactive'],
  groundingMode: ['', 'acknowledge_then_answer', 'answer_only'],
  clarificationMode: ['', 'ask_only_when_blocked', 'ask_to_disambiguate'],
  confirmationParameters: ['', 'never', 'when_ambiguous'],
  confirmationActions: ['', 'never', 'before_sensitive_actions'],
  uncertaintyMode: ['', 'say_when_unsure', 'offer_best_effort'],
  empathy: ['', 'brief_acknowledgement', 'acknowledge_when_emotional'],
  correction: ['', 'accept_and_update', 'confirm_and_update'],
  confusion: ['', 'rephrase_briefly', 'slow_down_and_rephrase'],
  misheard: ['', 'confirm_best_guess', 'ask_to_repeat'],
  closure: ['', 'summarize_outcome', 'invite_follow_up'],
  toolResultsStyle: ['', 'top_option_first', 'summary_first'],
  handoffInternal: ['', 'silent', 'brief', 'explicit'],
  handoffHuman: ['', 'silent', 'explicit'],
} as const;

const CATEGORY_VARIANTS = {
  instructions: 'accent',
  flow: 'purple',
  tools: 'success',
  constraints: 'warning',
  voice: 'info',
  gather: 'default',
  response_rules: 'info',
  conversation: 'accent',
} as const;

interface BehaviorSectionProps {
  data: BehaviorSectionData;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (data: BehaviorSectionData) => void;
  onArchClick?: () => void;
  saveStatus?: SaveStatus;
  showProfileReferences?: boolean;
  authoringNote?: string | null;
}

function normalizeConversationBehavior(
  behavior: ConversationBehaviorData | undefined,
): ConversationBehaviorData | undefined {
  if (!behavior) {
    return undefined;
  }

  const normalizeNode = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const normalizedItems = value.filter(
        (item) => item !== undefined && item !== null && item !== '',
      );
      return normalizedItems.length > 0 ? normalizedItems : undefined;
    }

    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .map(([key, nested]) => [key, normalizeNode(nested)] as const)
        .filter(([, nested]) => nested !== undefined);

      return entries.length > 0 ? Object.fromEntries(entries) : undefined;
    }

    if (value === '') {
      return undefined;
    }

    return value;
  };

  return normalizeNode(behavior) as ConversationBehaviorData | undefined;
}

function parseOptionalBoolean(value: string): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function summarizeBehavior(data: BehaviorSectionData): string {
  const summary: string[] = [];
  const style = data.conversationBehavior?.speaking?.style;
  const toolLeadIn = data.conversationBehavior?.speaking?.tool_lead_in;
  const answerShape = data.conversationBehavior?.interaction?.answer_shape;

  if (style) summary.push(style);
  if (toolLeadIn) summary.push(`tool ${toolLeadIn}`);
  if (answerShape) summary.push(answerShape.replace(/_/g, ' '));
  if (data.profiles.length > 0) {
    summary.push(
      `${data.profiles.length} profile${data.profiles.length === 1 ? '' : 's'} attached`,
    );
  }

  return summary.length > 0 ? summary.join(' • ') : 'No conversation behavior configured';
}

function hasConversationBehavior(data: BehaviorSectionData): boolean {
  return !!normalizeConversationBehavior(data.conversationBehavior);
}

function TextField({
  label,
  value,
  placeholder,
  onChange,
  className,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <label className="space-y-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={clsx(INLINE_INPUT_CLASSES, className)}
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: number | undefined;
  placeholder?: string;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <label className="space-y-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      <input
        type="number"
        min={1}
        value={value ?? ''}
        onChange={(event) =>
          onChange(event.target.value ? Number.parseInt(event.target.value, 10) : undefined)
        }
        placeholder={placeholder}
        className={INLINE_INPUT_CLASSES}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: readonly string[] | ReadonlyArray<{ label: string; value: string }>;
  onChange: (value: string | undefined) => void;
}) {
  const normalizedOptions = useMemo(
    () =>
      options.map((option) =>
        typeof option === 'string'
          ? { label: option === '' ? 'Inherit' : option.replace(/_/g, ' '), value: option }
          : option,
      ),
    [options],
  );

  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      <span className="relative block">
        <select
          value={value ?? ''}
          onChange={(event) => onChange(event.target.value || undefined)}
          className={INLINE_SELECT_CLASSES}
        >
          {normalizedOptions.map((option) => (
            <option key={`${label}-${option.value || 'inherit'}`} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
        />
      </span>
    </label>
  );
}

function BooleanField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | undefined;
  onChange: (value: boolean | undefined) => void;
}) {
  return (
    <SelectField
      label={label}
      value={value === undefined ? '' : value ? 'true' : 'false'}
      options={BOOLEAN_OPTIONS}
      onChange={(nextValue) => onChange(parseOptionalBoolean(nextValue ?? ''))}
    />
  );
}

function Panel({
  title,
  icon,
  children,
  defaultOpen = true,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return (
    <div className="rounded-lg border border-default bg-background-subtle">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-4 py-3 text-left transition-fast hover:bg-background-muted/40"
        aria-expanded={open}
        aria-controls={panelId}
      >
        <span className="flex items-center gap-2">
          {icon}
          <span className="text-sm font-semibold text-foreground">{title}</span>
        </span>
        <ChevronDown
          aria-hidden
          className={clsx('h-4 w-4 text-muted transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div id={panelId} className="space-y-4 border-t border-default/60 px-4 pb-4 pt-4">
          {children}
        </div>
      )}
    </div>
  );
}

export function BehaviorSection({
  data,
  isExpanded,
  onToggle,
  onChange,
  onArchClick,
  saveStatus,
  showProfileReferences = true,
  authoringNote = 'Behavior profiles are removable here, but creating and editing separate profile documents still happens through raw ABL today.',
}: BehaviorSectionProps) {
  const updateConversation = (
    updater: (current: ConversationBehaviorData) => ConversationBehaviorData,
  ) => {
    const current = data.conversationBehavior ?? {};
    onChange({
      ...data,
      conversationBehavior: normalizeConversationBehavior(updater(current)),
    });
  };

  const removeProfile = (name: string) => {
    onChange({
      ...data,
      profiles: data.profiles.filter((profile) => profile.name !== name),
    });
  };

  // Auto-open panels that already have configured values so the user is
  // not surprised by a collapsed section containing edited content.
  const listeningConfigured = !!normalizeConversationBehavior({
    listening: data.conversationBehavior?.listening,
  });
  const interactionConfigured = !!normalizeConversationBehavior({
    interaction: data.conversationBehavior?.interaction,
  });

  return (
    <SectionCard
      title="Behavior"
      sectionId="BEHAVIOR"
      count={showProfileReferences && data.profiles.length > 0 ? data.profiles.length : undefined}
      isExpanded={isExpanded}
      onToggle={onToggle}
      onArchClick={onArchClick}
      saveStatus={saveStatus}
      summary={summarizeBehavior(data)}
      isEmpty={!hasConversationBehavior(data) && data.profiles.length === 0}
    >
      <div className="space-y-6">
        <Panel title="Speaking" icon={<MessageSquare className="h-4 w-4 text-accent" />}>
          <div className="grid gap-3 md:grid-cols-2">
            <TextField
              label="Style"
              value={data.conversationBehavior?.speaking?.style ?? ''}
              placeholder="warm and concise"
              onChange={(style) =>
                updateConversation((current) => ({
                  ...current,
                  speaking: { ...current.speaking, style: style || undefined },
                }))
              }
            />
            <TextField
              label="Tone"
              value={data.conversationBehavior?.speaking?.tone ?? ''}
              placeholder="reassuring"
              onChange={(tone) =>
                updateConversation((current) => ({
                  ...current,
                  speaking: { ...current.speaking, tone: tone || undefined },
                }))
              }
            />
            <TextField
              label="Emotion"
              value={data.conversationBehavior?.speaking?.emotion ?? ''}
              placeholder="calm"
              onChange={(emotion) =>
                updateConversation((current) => ({
                  ...current,
                  speaking: { ...current.speaking, emotion: emotion || undefined },
                }))
              }
            />
            <TextField
              label="Pace"
              value={data.conversationBehavior?.speaking?.pace ?? ''}
              placeholder="steady"
              onChange={(pace) =>
                updateConversation((current) => ({
                  ...current,
                  speaking: { ...current.speaking, pace: pace || undefined },
                }))
              }
            />
            <SelectField
              label="Language Policy"
              value={data.conversationBehavior?.speaking?.language_policy}
              options={LANGUAGE_POLICY_OPTIONS}
              onChange={(languagePolicy) =>
                updateConversation((current) => ({
                  ...current,
                  speaking: {
                    ...current.speaking,
                    language_policy: languagePolicy as
                      | 'interaction_context'
                      | 'agent_default'
                      | 'fixed'
                      | undefined,
                    fixed_language:
                      languagePolicy === 'fixed' ? current.speaking?.fixed_language : undefined,
                  },
                }))
              }
            />
            <TextField
              label="Fixed Language"
              value={data.conversationBehavior?.speaking?.fixed_language ?? ''}
              placeholder="en-US"
              onChange={(fixedLanguage) =>
                updateConversation((current) => ({
                  ...current,
                  speaking: {
                    ...current.speaking,
                    fixed_language: fixedLanguage || undefined,
                  },
                }))
              }
            />
            <NumberField
              label="Max Sentences"
              value={data.conversationBehavior?.speaking?.max_sentences}
              placeholder="2"
              onChange={(maxSentences) =>
                updateConversation((current) => ({
                  ...current,
                  speaking: { ...current.speaking, max_sentences: maxSentences },
                }))
              }
            />
            <BooleanField
              label="One Thing At A Time"
              value={data.conversationBehavior?.speaking?.one_thing_at_a_time}
              onChange={(oneThingAtATime) =>
                updateConversation((current) => ({
                  ...current,
                  speaking: {
                    ...current.speaking,
                    one_thing_at_a_time: oneThingAtATime,
                  },
                }))
              }
            />
            <SelectField
              label="Tool Lead-In"
              value={data.conversationBehavior?.speaking?.tool_lead_in}
              options={TOOL_LEAD_IN_OPTIONS}
              onChange={(toolLeadIn) =>
                updateConversation((current) => ({
                  ...current,
                  speaking: {
                    ...current.speaking,
                    tool_lead_in: toolLeadIn,
                  },
                }))
              }
            />
            <SelectField
              label="Tool Results Style"
              value={data.conversationBehavior?.speaking?.tool_results?.style}
              options={INTERACTION_OPTIONS.toolResultsStyle}
              onChange={(style) =>
                updateConversation((current) => ({
                  ...current,
                  speaking: {
                    ...current.speaking,
                    tool_results: {
                      ...current.speaking?.tool_results,
                      style,
                    },
                  },
                }))
              }
            />
            <NumberField
              label="Tool Result Points"
              value={data.conversationBehavior?.speaking?.tool_results?.max_points}
              placeholder="2"
              onChange={(maxPoints) =>
                updateConversation((current) => ({
                  ...current,
                  speaking: {
                    ...current.speaking,
                    tool_results: {
                      ...current.speaking?.tool_results,
                      max_points: maxPoints,
                    },
                  },
                }))
              }
            />
            <SelectField
              label="Internal Handoffs"
              value={data.conversationBehavior?.speaking?.handoffs?.internal}
              options={INTERACTION_OPTIONS.handoffInternal}
              onChange={(internal) =>
                updateConversation((current) => ({
                  ...current,
                  speaking: {
                    ...current.speaking,
                    handoffs: { ...current.speaking?.handoffs, internal },
                  },
                }))
              }
            />
            <SelectField
              label="Human Handoffs"
              value={data.conversationBehavior?.speaking?.handoffs?.human}
              options={INTERACTION_OPTIONS.handoffHuman}
              onChange={(human) =>
                updateConversation((current) => ({
                  ...current,
                  speaking: {
                    ...current.speaking,
                    handoffs: { ...current.speaking?.handoffs, human },
                  },
                }))
              }
            />
          </div>
        </Panel>

        <Panel
          title="Listening"
          icon={<Ear className="h-4 w-4 text-info" />}
          defaultOpen={listeningConfigured}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <SelectField
              label="Barge-In"
              value={data.conversationBehavior?.listening?.barge_in}
              options={LISTENING_OPTIONS.bargeIn}
              onChange={(bargeIn) =>
                updateConversation((current) => ({
                  ...current,
                  listening: { ...current.listening, barge_in: bargeIn },
                }))
              }
            />
            <SelectField
              label="On Pause"
              value={data.conversationBehavior?.listening?.on_pause}
              options={LISTENING_OPTIONS.onPause}
              onChange={(onPause) =>
                updateConversation((current) => ({
                  ...current,
                  listening: { ...current.listening, on_pause: onPause },
                }))
              }
            />
            <SelectField
              label="On Overlap"
              value={data.conversationBehavior?.listening?.on_overlap}
              options={LISTENING_OPTIONS.onOverlap}
              onChange={(onOverlap) =>
                updateConversation((current) => ({
                  ...current,
                  listening: { ...current.listening, on_overlap: onOverlap },
                }))
              }
            />
            <SelectField
              label="Unclear Audio"
              value={data.conversationBehavior?.listening?.on_unclear_audio}
              options={LISTENING_OPTIONS.onUnclearAudio}
              onChange={(onUnclearAudio) =>
                updateConversation((current) => ({
                  ...current,
                  listening: {
                    ...current.listening,
                    on_unclear_audio: onUnclearAudio,
                  },
                }))
              }
            />
            <SelectField
              label="Self-Correction"
              value={data.conversationBehavior?.listening?.on_self_correction}
              options={LISTENING_OPTIONS.onSelfCorrection}
              onChange={(onSelfCorrection) =>
                updateConversation((current) => ({
                  ...current,
                  listening: {
                    ...current.listening,
                    on_self_correction: onSelfCorrection,
                  },
                }))
              }
            />
          </div>
        </Panel>

        <Panel
          title="Interaction"
          icon={<MessageCircle className="h-4 w-4 text-purple" />}
          defaultOpen={interactionConfigured}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <SelectField
              label="Answer Shape"
              value={data.conversationBehavior?.interaction?.answer_shape}
              options={INTERACTION_OPTIONS.answerShape}
              onChange={(answerShape) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: { ...current.interaction, answer_shape: answerShape },
                }))
              }
            />
            <SelectField
              label="Detail"
              value={data.conversationBehavior?.interaction?.detail}
              options={INTERACTION_OPTIONS.detail}
              onChange={(detail) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: { ...current.interaction, detail },
                }))
              }
            />
            <SelectField
              label="Initiative"
              value={data.conversationBehavior?.interaction?.initiative}
              options={INTERACTION_OPTIONS.initiative}
              onChange={(initiative) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: { ...current.interaction, initiative },
                }))
              }
            />
            <SelectField
              label="Grounding"
              value={data.conversationBehavior?.interaction?.grounding?.mode}
              options={INTERACTION_OPTIONS.groundingMode}
              onChange={(mode) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: {
                    ...current.interaction,
                    grounding: { ...current.interaction?.grounding, mode },
                  },
                }))
              }
            />
            <SelectField
              label="Clarification"
              value={data.conversationBehavior?.interaction?.clarification?.mode}
              options={INTERACTION_OPTIONS.clarificationMode}
              onChange={(mode) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: {
                    ...current.interaction,
                    clarification: { ...current.interaction?.clarification, mode },
                  },
                }))
              }
            />
            <NumberField
              label="Max Clarification Questions"
              value={data.conversationBehavior?.interaction?.clarification?.max_questions}
              placeholder="1"
              onChange={(maxQuestions) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: {
                    ...current.interaction,
                    clarification: {
                      ...current.interaction?.clarification,
                      max_questions: maxQuestions,
                    },
                  },
                }))
              }
            />
            <BooleanField
              label="Assume When Low Risk"
              value={data.conversationBehavior?.interaction?.clarification?.assume_when_low_risk}
              onChange={(assumeWhenLowRisk) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: {
                    ...current.interaction,
                    clarification: {
                      ...current.interaction?.clarification,
                      assume_when_low_risk: assumeWhenLowRisk,
                    },
                  },
                }))
              }
            />
            <SelectField
              label="Confirm Parameters"
              value={data.conversationBehavior?.interaction?.confirmation?.parameters}
              options={INTERACTION_OPTIONS.confirmationParameters}
              onChange={(parameters) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: {
                    ...current.interaction,
                    confirmation: {
                      ...current.interaction?.confirmation,
                      parameters,
                    },
                  },
                }))
              }
            />
            <SelectField
              label="Confirm Actions"
              value={data.conversationBehavior?.interaction?.confirmation?.actions}
              options={INTERACTION_OPTIONS.confirmationActions}
              onChange={(actions) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: {
                    ...current.interaction,
                    confirmation: { ...current.interaction?.confirmation, actions },
                  },
                }))
              }
            />
            <SelectField
              label="Uncertainty"
              value={data.conversationBehavior?.interaction?.uncertainty?.mode}
              options={INTERACTION_OPTIONS.uncertaintyMode}
              onChange={(mode) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: {
                    ...current.interaction,
                    uncertainty: { ...current.interaction?.uncertainty, mode },
                  },
                }))
              }
            />
            <BooleanField
              label="Offer Next Step"
              value={data.conversationBehavior?.interaction?.uncertainty?.offer_next_step}
              onChange={(offerNextStep) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: {
                    ...current.interaction,
                    uncertainty: {
                      ...current.interaction?.uncertainty,
                      offer_next_step: offerNextStep,
                    },
                  },
                }))
              }
            />
            <SelectField
              label="Empathy"
              value={data.conversationBehavior?.interaction?.empathy}
              options={INTERACTION_OPTIONS.empathy}
              onChange={(empathy) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: { ...current.interaction, empathy },
                }))
              }
            />
            <SelectField
              label="On Correction"
              value={data.conversationBehavior?.interaction?.repair?.on_correction}
              options={INTERACTION_OPTIONS.correction}
              onChange={(onCorrection) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: {
                    ...current.interaction,
                    repair: {
                      ...current.interaction?.repair,
                      on_correction: onCorrection,
                    },
                  },
                }))
              }
            />
            <SelectField
              label="On Confusion"
              value={data.conversationBehavior?.interaction?.repair?.on_confusion}
              options={INTERACTION_OPTIONS.confusion}
              onChange={(onConfusion) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: {
                    ...current.interaction,
                    repair: {
                      ...current.interaction?.repair,
                      on_confusion: onConfusion,
                    },
                  },
                }))
              }
            />
            <SelectField
              label="On Misheard"
              value={data.conversationBehavior?.interaction?.repair?.on_misheard}
              options={INTERACTION_OPTIONS.misheard}
              onChange={(onMisheard) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: {
                    ...current.interaction,
                    repair: {
                      ...current.interaction?.repair,
                      on_misheard: onMisheard,
                    },
                  },
                }))
              }
            />
            <NumberField
              label="Repair Attempts"
              value={data.conversationBehavior?.interaction?.repair?.max_attempts}
              placeholder="2"
              onChange={(maxAttempts) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: {
                    ...current.interaction,
                    repair: {
                      ...current.interaction?.repair,
                      max_attempts: maxAttempts,
                    },
                  },
                }))
              }
            />
            <BooleanField
              label="Avoid Re-Asking"
              value={data.conversationBehavior?.interaction?.context?.avoid_reasking}
              onChange={(avoidReasking) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: {
                    ...current.interaction,
                    context: {
                      ...current.interaction?.context,
                      avoid_reasking: avoidReasking,
                    },
                  },
                }))
              }
            />
            <BooleanField
              label="Remember Constraints"
              value={data.conversationBehavior?.interaction?.context?.remember_recent_constraints}
              onChange={(rememberRecentConstraints) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: {
                    ...current.interaction,
                    context: {
                      ...current.interaction?.context,
                      remember_recent_constraints: rememberRecentConstraints,
                    },
                  },
                }))
              }
            />
            <SelectField
              label="Closure"
              value={data.conversationBehavior?.interaction?.closure}
              options={INTERACTION_OPTIONS.closure}
              onChange={(closure) =>
                updateConversation((current) => ({
                  ...current,
                  interaction: { ...current.interaction, closure },
                }))
              }
            />
          </div>
        </Panel>

        {showProfileReferences && (
          <div className="rounded-lg border border-default bg-background-subtle p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Attached Profiles</h3>
                <p className="text-xs text-muted">
                  Attached behavior profiles still layer on top of the baseline conversation
                  behavior.
                </p>
              </div>
              {data.profiles.length > 0 && (
                <Badge variant="accent">{data.profiles.length} attached</Badge>
              )}
            </div>

            {data.profiles.length === 0 ? (
              <p className="text-sm text-muted">No behavior profiles attached.</p>
            ) : (
              <div className="space-y-3">
                {data.profiles.map((profile) => (
                  <div
                    key={profile.name}
                    className="rounded-lg border border-default bg-background-muted p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {profile.name}
                          </span>
                          <Badge variant="accent">P{profile.priority}</Badge>
                        </div>
                        {profile.whenSummary && (
                          <p className="mt-1 truncate font-mono text-xs text-muted">
                            WHEN {profile.whenSummary}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeProfile(profile.name)}
                        className="rounded p-1 text-muted transition-default hover:bg-error-subtle hover:text-error"
                        aria-label={`Remove ${profile.name}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {profile.overrideCategories.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {profile.overrideCategories.map((category) => (
                          <Badge
                            key={`${profile.name}-${category}`}
                            variant={
                              CATEGORY_VARIANTS[category as keyof typeof CATEGORY_VARIANTS] ??
                              'default'
                            }
                            className="text-xs"
                          >
                            {category.replace(/_/g, ' ')}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {authoringNote && (
          <div className="rounded-lg border border-dashed border-default bg-background-subtle p-4">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted">Authoring Note</span>
              <textarea
                readOnly
                value={authoringNote}
                className={clsx(INLINE_TEXTAREA_CLASSES, 'text-muted')}
                rows={3}
              />
            </label>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
