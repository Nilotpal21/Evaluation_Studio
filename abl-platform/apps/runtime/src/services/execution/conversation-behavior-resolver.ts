import type { BehaviorProfileIR } from '@abl/compiler';
import type {
  ConversationBehaviorIR,
  ConversationInteractionIR,
  ConversationListeningIR,
  ConversationSpeakingIR,
} from '@abl/compiler/platform/ir/schema.js';
import { getVoiceBehaviorProfileForChannelType } from '../../channels/channel-behavior-contract.js';
import { isKnownChannelType } from '../../channels/manifest.js';
import type { ChannelType } from '../../channels/types.js';

export interface ConversationBehaviorCapabilityDrop {
  fieldPath: string;
  reason: 'voice_channel_required';
  message: string;
}

export interface ResolvedConversationBehavior extends ConversationBehaviorIR {
  sourceChain: string[];
  capabilityDrops: ConversationBehaviorCapabilityDrop[];
}

export interface ConversationBehaviorVoiceRuntimeConfig {
  bargeIn?: boolean;
  bargeInPolicy?: string;
  pauseTimeoutMs?: number;
  onPause?: string;
  onOverlap?: string;
  onUnclearAudio?: string;
  onSelfCorrection?: string;
  internalHandoffSpeech?: string;
  humanHandoffSpeech?: string;
}

const PAUSE_TIMEOUT_BRIEF_MS = 800;
const PAUSE_TIMEOUT_DEFAULT_MS = 1500;
const PAUSE_TIMEOUT_LONG_MS = 2500;

export interface ResolveConversationBehaviorOptions {
  baseBehavior?: ConversationBehaviorIR;
  activeProfiles: BehaviorProfileIR[];
  channelType: string;
}

export function resolveConversationBehavior(
  options: ResolveConversationBehaviorOptions,
): ResolvedConversationBehavior | undefined {
  const { baseBehavior, activeProfiles, channelType } = options;
  let merged = cloneConversationBehavior(baseBehavior);
  const sourceChain: string[] = [];

  if (merged) {
    sourceChain.push('agent');
  }

  for (const profile of activeProfiles) {
    if (!profile.conversation_behavior) {
      continue;
    }

    merged = mergeConversationBehavior(merged, profile.conversation_behavior);
    sourceChain.push(`profile:${profile.name}`);
  }

  if (!merged) {
    return undefined;
  }

  const capabilityDrops: ConversationBehaviorCapabilityDrop[] = [];
  const gatedBehavior = applyCapabilityGates(merged, channelType, capabilityDrops);

  if (!gatedBehavior) {
    return capabilityDrops.length > 0
      ? {
          sourceChain,
          capabilityDrops,
        }
      : undefined;
  }

  return {
    ...gatedBehavior,
    sourceChain,
    capabilityDrops,
  };
}

export interface ConversationBehaviorPromptContext {
  interactionLanguage?: string;
  interactionLocale?: string;
  interactionTimezone?: string;
}

export function buildConversationBehaviorPromptLines(
  behavior: ResolvedConversationBehavior,
  context: ConversationBehaviorPromptContext = {},
): string[] {
  const lines: string[] = [];
  const { interactionLanguage, interactionLocale, interactionTimezone } = context;

  if (behavior.speaking) {
    const speaking = behavior.speaking;
    if (speaking.style) {
      lines.push(`Adopt a ${speaking.style} speaking style.`);
    }
    if (speaking.tone) {
      lines.push(`Use a ${speaking.tone} tone.`);
    }
    if (speaking.emotion) {
      lines.push(`Keep an emotional register that feels ${speaking.emotion}.`);
    }
    if (speaking.pace) {
      lines.push(`Maintain a ${humanizeEnum(speaking.pace)} pace.`);
    }
    if (speaking.language_policy === 'interaction_context') {
      lines.push(
        buildInteractionContextLanguageInstruction(
          interactionLanguage,
          interactionLocale,
          interactionTimezone,
        ),
      );
    } else if (speaking.language_policy === 'fixed' && speaking.fixed_language) {
      lines.push(`Respond in ${speaking.fixed_language}.`);
    } else if (speaking.language_policy === 'agent_default') {
      lines.push(`Use the agent's default language behavior.`);
    }
    if (speaking.max_sentences !== undefined) {
      lines.push(
        `Keep most replies to ${speaking.max_sentences} sentence${speaking.max_sentences === 1 ? '' : 's'} or fewer.`,
      );
    }
    if (speaking.one_thing_at_a_time) {
      lines.push(`Ask for or present one thing at a time.`);
    }
    if (speaking.tool_lead_in) {
      lines.push(`Use ${humanizeEnum(speaking.tool_lead_in)} tool lead-ins.`);
    }
    if (speaking.readback?.numbers) {
      lines.push(`Read back numbers using ${humanizeEnum(speaking.readback.numbers)}.`);
    }
    if (speaking.readback?.codes) {
      lines.push(`Read back codes using ${humanizeEnum(speaking.readback.codes)}.`);
    }
    if (speaking.readback?.critical_details) {
      lines.push(
        `Read back critical details using ${humanizeEnum(speaking.readback.critical_details)}.`,
      );
    }
    if (speaking.tool_results?.style) {
      lines.push(`Present tool results with ${humanizeEnum(speaking.tool_results.style)}.`);
    }
    if (speaking.tool_results?.max_points !== undefined) {
      lines.push(
        `Limit tool-result summaries to ${speaking.tool_results.max_points} key point${speaking.tool_results.max_points === 1 ? '' : 's'}.`,
      );
    }
    if (speaking.handoffs?.internal) {
      lines.push(`Internal handoffs should be ${humanizeEnum(speaking.handoffs.internal)}.`);
    }
    if (speaking.handoffs?.human) {
      lines.push(`Human handoffs should be ${humanizeEnum(speaking.handoffs.human)}.`);
    }
  }

  if (behavior.listening) {
    const listening = behavior.listening;
    if (listening.barge_in) {
      lines.push(`For voice turns, barge-in should ${humanizeEnum(listening.barge_in)}.`);
    }
    if (listening.on_pause) {
      lines.push(`On user pauses, ${humanizeEnum(listening.on_pause)}.`);
    }
    if (listening.on_overlap) {
      lines.push(`When the user overlaps speech, ${humanizeEnum(listening.on_overlap)}.`);
    }
    if (listening.on_unclear_audio) {
      lines.push(`If audio is unclear, ${humanizeEnum(listening.on_unclear_audio)}.`);
    }
    if (listening.on_self_correction) {
      lines.push(`When the user self-corrects, ${humanizeEnum(listening.on_self_correction)}.`);
    }
  }

  if (behavior.interaction) {
    const interaction = behavior.interaction;
    if (interaction.answer_shape) {
      lines.push(`Structure answers with ${humanizeEnum(interaction.answer_shape)}.`);
    }
    if (interaction.detail) {
      lines.push(`Aim for ${humanizeEnum(interaction.detail)} detail.`);
    }
    if (interaction.initiative) {
      lines.push(`Take a ${humanizeEnum(interaction.initiative)} level of initiative.`);
    }
    if (interaction.grounding?.mode) {
      lines.push(`Ground responses with ${humanizeEnum(interaction.grounding.mode)}.`);
    }
    if (interaction.clarification?.mode) {
      lines.push(`Clarify using ${humanizeEnum(interaction.clarification.mode)}.`);
    }
    if (interaction.clarification?.max_questions !== undefined) {
      lines.push(
        `Ask at most ${interaction.clarification.max_questions} clarification question${interaction.clarification.max_questions === 1 ? '' : 's'} before answering.`,
      );
    }
    if (interaction.clarification?.assume_when_low_risk) {
      lines.push(`Make low-risk assumptions instead of over-clarifying.`);
    }
    if (interaction.confirmation?.parameters) {
      lines.push(`Confirm parameters ${humanizeEnum(interaction.confirmation.parameters)}.`);
    }
    if (interaction.confirmation?.actions) {
      lines.push(`Confirm actions ${humanizeEnum(interaction.confirmation.actions)}.`);
    }
    if (interaction.uncertainty?.mode) {
      lines.push(`Handle uncertainty with ${humanizeEnum(interaction.uncertainty.mode)}.`);
    }
    if (interaction.uncertainty?.offer_next_step) {
      lines.push(`When unsure, offer a sensible next step.`);
    }
    if (interaction.empathy) {
      lines.push(`Show empathy using ${humanizeEnum(interaction.empathy)}.`);
    }
    if (interaction.repair?.on_correction) {
      lines.push(`When corrected, ${humanizeEnum(interaction.repair.on_correction)}.`);
    }
    if (interaction.repair?.on_confusion) {
      lines.push(`When the user is confused, ${humanizeEnum(interaction.repair.on_confusion)}.`);
    }
    if (interaction.repair?.on_misheard) {
      lines.push(`If you may have misheard, ${humanizeEnum(interaction.repair.on_misheard)}.`);
    }
    if (interaction.repair?.max_attempts !== undefined) {
      lines.push(
        `Keep repair attempts to ${interaction.repair.max_attempts} before changing strategy.`,
      );
    }
    if (interaction.context?.avoid_reasking) {
      lines.push(`Avoid re-asking for information the user already provided.`);
    }
    if (interaction.context?.remember_recent_constraints) {
      lines.push(`Keep recent user constraints in mind as you answer.`);
    }
    if (interaction.closure) {
      lines.push(`Close turns with ${humanizeEnum(interaction.closure)}.`);
    }
  }

  return lines;
}

export function resolveConversationBehaviorVoiceRuntimeConfig(
  behavior: ResolvedConversationBehavior | undefined,
): ConversationBehaviorVoiceRuntimeConfig {
  const listening = behavior?.listening;
  const speaking = behavior?.speaking;
  if (!listening && !speaking) {
    return {};
  }

  return removeUndefined({
    bargeIn: listening
      ? (parseBargeInPolicy(listening.barge_in) ??
        parseOverlapInterruptionPolicy(listening.on_overlap))
      : undefined,
    bargeInPolicy: listening?.barge_in,
    pauseTimeoutMs: listening ? parsePauseTimeoutMs(listening.on_pause) : undefined,
    onPause: listening?.on_pause,
    onOverlap: listening?.on_overlap,
    onUnclearAudio: listening?.on_unclear_audio,
    onSelfCorrection: listening?.on_self_correction,
    internalHandoffSpeech: speaking?.handoffs?.internal,
    humanHandoffSpeech: speaking?.handoffs?.human,
  });
}

export function buildConversationBehaviorTraceSummary(
  behavior: ResolvedConversationBehavior | undefined,
  context: ConversationBehaviorPromptContext = {},
): Record<string, unknown> | null {
  if (!behavior) {
    return null;
  }

  const voiceRuntime = resolveConversationBehaviorVoiceRuntimeConfig(behavior);

  return {
    sourceChain: behavior.sourceChain,
    capabilityDrops: behavior.capabilityDrops,
    hasSpeaking: !!behavior.speaking,
    hasListening: !!behavior.listening,
    hasInteraction: !!behavior.interaction,
    phrasesRef: behavior.speaking?.phrases_ref,
    pronunciationsRef: behavior.speaking?.pronunciations_ref,
    hasReadback: !!behavior.speaking?.readback,
    voiceRuntime,
    interactionContext: removeUndefined({
      language: context.interactionLanguage,
      locale: context.interactionLocale,
      timezone: context.interactionTimezone,
    }),
  };
}

function buildInteractionContextLanguageInstruction(
  language: string | undefined,
  locale: string | undefined,
  timezone: string | undefined,
): string {
  const base =
    typeof language === 'string' && language.length > 0
      ? `Match the current interaction language (${language})`
      : `Match the current interaction language`;
  const hints = [
    typeof locale === 'string' && locale.length > 0 ? `locale ${locale}` : undefined,
    typeof timezone === 'string' && timezone.length > 0 ? `timezone ${timezone}` : undefined,
  ].filter((value): value is string => !!value);

  if (hints.length === 0) {
    return `${base}.`;
  }

  return `${base} and respect ${hints.join(' and ')} when phrasing responses.`;
}

function applyCapabilityGates(
  behavior: ConversationBehaviorIR,
  channelType: string,
  capabilityDrops: ConversationBehaviorCapabilityDrop[],
): ConversationBehaviorIR | undefined {
  const isVoiceSurface = isConversationBehaviorVoiceChannel(channelType);
  const gated = cloneConversationBehavior(behavior);

  if (gated?.listening && !isVoiceSurface) {
    for (const field of Object.keys(gated.listening)) {
      capabilityDrops.push({
        fieldPath: `listening.${field}`,
        reason: 'voice_channel_required',
        message: `Listening behavior requires a voice-capable channel, but "${channelType}" is not voice-capable.`,
      });
    }
    delete gated.listening;
  }

  if (!gated) {
    return undefined;
  }

  return isConversationBehaviorEmpty(gated) ? undefined : gated;
}

function isConversationBehaviorVoiceChannel(channelType: string): boolean {
  return (
    isKnownChannelType(channelType) &&
    getVoiceBehaviorProfileForChannelType(channelType as ChannelType) !== null
  );
}

function cloneConversationBehavior(
  behavior: ConversationBehaviorIR | undefined,
): ConversationBehaviorIR | undefined {
  if (!behavior) {
    return undefined;
  }

  return {
    ...(behavior.speaking ? { speaking: cloneSpeaking(behavior.speaking) } : {}),
    ...(behavior.listening ? { listening: { ...behavior.listening } } : {}),
    ...(behavior.interaction ? { interaction: cloneInteraction(behavior.interaction) } : {}),
  };
}

function mergeConversationBehavior(
  base: ConversationBehaviorIR | undefined,
  overlay: ConversationBehaviorIR,
): ConversationBehaviorIR {
  return {
    ...(base?.speaking || overlay.speaking
      ? { speaking: mergeSpeaking(base?.speaking, overlay.speaking) }
      : {}),
    ...(base?.listening || overlay.listening
      ? { listening: mergeListening(base?.listening, overlay.listening) }
      : {}),
    ...(base?.interaction || overlay.interaction
      ? { interaction: mergeInteraction(base?.interaction, overlay.interaction) }
      : {}),
  };
}

function cloneSpeaking(speaking: ConversationSpeakingIR): ConversationSpeakingIR {
  return {
    ...speaking,
    ...(speaking.readback ? { readback: { ...speaking.readback } } : {}),
    ...(speaking.tool_results ? { tool_results: { ...speaking.tool_results } } : {}),
    ...(speaking.handoffs ? { handoffs: { ...speaking.handoffs } } : {}),
  };
}

function cloneInteraction(interaction: ConversationInteractionIR): ConversationInteractionIR {
  return {
    ...interaction,
    ...(interaction.grounding ? { grounding: { ...interaction.grounding } } : {}),
    ...(interaction.clarification ? { clarification: { ...interaction.clarification } } : {}),
    ...(interaction.confirmation ? { confirmation: { ...interaction.confirmation } } : {}),
    ...(interaction.uncertainty ? { uncertainty: { ...interaction.uncertainty } } : {}),
    ...(interaction.repair ? { repair: { ...interaction.repair } } : {}),
    ...(interaction.context ? { context: { ...interaction.context } } : {}),
  };
}

function mergeSpeaking(
  base: ConversationSpeakingIR | undefined,
  overlay: ConversationSpeakingIR | undefined,
): ConversationSpeakingIR | undefined {
  if (!base && !overlay) {
    return undefined;
  }

  const merged: ConversationSpeakingIR = {
    ...(base ? cloneSpeaking(base) : {}),
    ...(overlay ? cloneSpeaking(overlay) : {}),
  };

  if (base?.tool_results || overlay?.tool_results) {
    merged.tool_results = {
      ...(base?.tool_results ?? {}),
      ...(overlay?.tool_results ?? {}),
    };
  }

  if (base?.readback || overlay?.readback) {
    merged.readback = {
      ...(base?.readback ?? {}),
      ...(overlay?.readback ?? {}),
    };
  }

  if (base?.handoffs || overlay?.handoffs) {
    merged.handoffs = {
      ...(base?.handoffs ?? {}),
      ...(overlay?.handoffs ?? {}),
    };
  }

  return removeEmptyNestedSections(merged, ['readback', 'tool_results', 'handoffs']);
}

function mergeListening(
  base: ConversationListeningIR | undefined,
  overlay: ConversationListeningIR | undefined,
): ConversationListeningIR | undefined {
  if (!base && !overlay) {
    return undefined;
  }

  return {
    ...(base ? { ...base } : {}),
    ...(overlay ? { ...overlay } : {}),
  };
}

function mergeInteraction(
  base: ConversationInteractionIR | undefined,
  overlay: ConversationInteractionIR | undefined,
): ConversationInteractionIR | undefined {
  if (!base && !overlay) {
    return undefined;
  }

  const merged: ConversationInteractionIR = {
    ...(base ? cloneInteraction(base) : {}),
    ...(overlay ? cloneInteraction(overlay) : {}),
  };

  if (base?.grounding || overlay?.grounding) {
    merged.grounding = {
      ...(base?.grounding ?? {}),
      ...(overlay?.grounding ?? {}),
    };
  }
  if (base?.clarification || overlay?.clarification) {
    merged.clarification = {
      ...(base?.clarification ?? {}),
      ...(overlay?.clarification ?? {}),
    };
  }
  if (base?.confirmation || overlay?.confirmation) {
    merged.confirmation = {
      ...(base?.confirmation ?? {}),
      ...(overlay?.confirmation ?? {}),
    };
  }
  if (base?.uncertainty || overlay?.uncertainty) {
    merged.uncertainty = {
      ...(base?.uncertainty ?? {}),
      ...(overlay?.uncertainty ?? {}),
    };
  }
  if (base?.repair || overlay?.repair) {
    merged.repair = {
      ...(base?.repair ?? {}),
      ...(overlay?.repair ?? {}),
    };
  }
  if (base?.context || overlay?.context) {
    merged.context = {
      ...(base?.context ?? {}),
      ...(overlay?.context ?? {}),
    };
  }

  return removeEmptyNestedSections(merged, [
    'grounding',
    'clarification',
    'confirmation',
    'uncertainty',
    'repair',
    'context',
  ]);
}

function removeEmptyNestedSections<T extends object>(
  value: T,
  nestedKeys: Array<keyof T & string>,
): T {
  const record = value as Record<string, unknown>;

  for (const key of nestedKeys) {
    const nested = record[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested) && isEmptyObject(nested)) {
      delete record[key];
    }
  }

  return value;
}

function parseBargeInPolicy(policy: string | undefined): boolean | undefined {
  if (!policy) {
    return undefined;
  }

  const normalized = policy.trim().toLowerCase();
  if (['allow', 'allowed', 'enable', 'enabled', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (
    ['disallow', 'disabled', 'disable', 'false', 'no', 'off', 'deny', 'block'].includes(normalized)
  ) {
    return false;
  }

  return undefined;
}

function parseOverlapInterruptionPolicy(policy: string | undefined): boolean | undefined {
  if (!policy) {
    return undefined;
  }

  const normalized = policy.trim().toLowerCase();
  if (['stop_and_listen', 'listen', 'yield', 'yield_to_user'].includes(normalized)) {
    return true;
  }
  if (['ignore_overlap', 'continue', 'talk_over'].includes(normalized)) {
    return false;
  }

  return undefined;
}

function parsePauseTimeoutMs(policy: string | undefined): number | undefined {
  if (!policy) {
    return undefined;
  }

  const normalized = policy.trim().toLowerCase();
  if (['wait_briefly', 'brief', 'short', 'respond_quickly'].includes(normalized)) {
    return PAUSE_TIMEOUT_BRIEF_MS;
  }
  if (['wait_longer', 'long', 'patient'].includes(normalized)) {
    return PAUSE_TIMEOUT_LONG_MS;
  }

  return PAUSE_TIMEOUT_DEFAULT_MS;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function isConversationBehaviorEmpty(behavior: ConversationBehaviorIR): boolean {
  return (
    !behavior.speaking && !behavior.listening && !behavior.interaction && isEmptyObject(behavior)
  );
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.keys(value).length === 0;
}

function humanizeEnum(value: string): string {
  return value.replace(/_/g, ' ');
}
