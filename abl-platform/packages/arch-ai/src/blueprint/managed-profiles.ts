import { createHash } from 'node:crypto';

export interface BlueprintRenderedBehaviorProfile {
  name: string;
  dslContent: string;
  sourceHash: string;
}

export interface ArchManagedChannelRule {
  channel: string;
  responseMaxWords?: number;
  abbreviationPolicy?: 'expand_for_voice' | 'preserve_text';
  toolLatencyBridge?: boolean;
  rules?: ReadonlyArray<string>;
}

export interface ArchManagedBehaviorProfileOptions {
  channels?: ReadonlyArray<string>;
  tone?: ReadonlyArray<string>;
  universalRules?: ReadonlyArray<string>;
  channelRules?: ReadonlyArray<ArchManagedChannelRule>;
  includeSharedVoiceHandoff?: boolean;
  includePlainLanguage?: boolean;
  includeVoiceCompact?: boolean;
  includeEmpathy?: boolean;
}

export const SHARED_VOICE_HANDOFF_PROFILE_NAME = 'shared_voice_handoff';
export const PLAIN_LANGUAGE_PROFILE_NAME = 'plain_language';
export const VOICE_COMPACT_PROFILE_NAME = 'voice_compact';
export const FRUSTRATION_EMPATHY_PROFILE_NAME = 'frustration_empathy';

export const ARCH_MANAGED_BEHAVIOR_PROFILE_NAMES = [
  SHARED_VOICE_HANDOFF_PROFILE_NAME,
  PLAIN_LANGUAGE_PROFILE_NAME,
  VOICE_COMPACT_PROFILE_NAME,
  FRUSTRATION_EMPATHY_PROFILE_NAME,
] as const;

export type ArchManagedBehaviorProfileName = (typeof ARCH_MANAGED_BEHAVIOR_PROFILE_NAMES)[number];

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asRenderedProfile(name: string, lines: string[]): BlueprintRenderedBehaviorProfile {
  const dslContent = `${lines.join('\n')}\n`;
  return {
    name,
    dslContent,
    sourceHash: hashText(dslContent),
  };
}

function collectRuleText(options: ArchManagedBehaviorProfileOptions): string[] {
  return [
    ...(options.universalRules ?? []),
    ...(options.channelRules ?? []).flatMap((rule) => rule.rules ?? []),
  ]
    .map((rule) => rule.trim())
    .filter(Boolean);
}

function responseLengthForVoice(options: ArchManagedBehaviorProfileOptions): number {
  const voiceRule = (options.channelRules ?? []).find((rule) =>
    /^(?:voice|phone)$/i.test(rule.channel.trim()),
  );
  const wordLimit = voiceRule?.responseMaxWords;
  if (typeof wordLimit === 'number' && Number.isFinite(wordLimit) && wordLimit > 0) {
    return Math.max(80, Math.min(320, Math.round(wordLimit * 7)));
  }
  return 240;
}

function renderSharedVoiceHandoffProfile(
  options: ArchManagedBehaviorProfileOptions = {},
): BlueprintRenderedBehaviorProfile {
  const channels = new Set((options.channels ?? []).map((channel) => channel.toLowerCase()));
  const tone = (options.tone ?? []).map((item) => item.trim()).filter(Boolean);
  const instructions = [
    "Continue the customer's existing conversation in the same brand voice.",
    'Do not introduce yourself as a new person or announce an internal transfer.',
    'Use the prior conversation and handoff summary so the customer does not repeat known details.',
    'If frustration was already acknowledged, do not repeat the same empathy beat unless the customer adds a new concern.',
    'Before longer lookups or actions, use one brief customer-facing bridge phrase; never mention tools, workflows, prompts, systems, or internal handoffs.',
  ];
  if (channels.has('voice')) {
    instructions.push('For voice, keep the first continuation short and natural.');
  }
  if (
    channels.has('web chat') ||
    channels.has('chat') ||
    channels.has('sms') ||
    channels.has('whatsapp')
  ) {
    instructions.push('For messaging channels, keep replies concise and easy to scan.');
  }
  if (tone.length > 0) {
    instructions.push(`Maintain this shared tone across agents: ${tone.join(', ')}.`);
  }

  return asRenderedProfile(SHARED_VOICE_HANDOFF_PROFILE_NAME, [
    `BEHAVIOR_PROFILE: ${SHARED_VOICE_HANDOFF_PROFILE_NAME}`,
    'PRIORITY: 20',
    'WHEN: true',
    '',
    'INSTRUCTIONS: |',
    ...instructions.map((instruction) => `  ${instruction}`),
    '',
  ]);
}

function renderPlainLanguageProfile(
  options: ArchManagedBehaviorProfileOptions = {},
): BlueprintRenderedBehaviorProfile {
  const instructions = [
    'Use plain language and short, direct sentences.',
    'Avoid jargon, internal process names, policy codes, and unexplained abbreviations.',
    'Do not use forbidden phrases or legalistic wording copied from SOPs; translate policy into customer-safe language.',
  ];
  const ruleText = collectRuleText(options)
    .filter((rule) =>
      /\b(plain language|jargon|forbidden phrase|abbreviation|acronym)\b/i.test(rule),
    )
    .slice(0, 4);
  for (const rule of ruleText) {
    instructions.push(`Apply this source rule: ${rule}`);
  }

  return asRenderedProfile(PLAIN_LANGUAGE_PROFILE_NAME, [
    `BEHAVIOR_PROFILE: ${PLAIN_LANGUAGE_PROFILE_NAME}`,
    'PRIORITY: 0',
    'WHEN: true',
    '',
    'INSTRUCTIONS: |',
    ...instructions.map((instruction) => `  ${instruction}`),
    '',
  ]);
}

function renderVoiceCompactProfile(
  options: ArchManagedBehaviorProfileOptions = {},
): BlueprintRenderedBehaviorProfile {
  const instructions = [
    'For voice, keep each turn brief and natural.',
    'Ask for one thing at a time.',
    'Expand abbreviations and do not spell out email addresses unless the caller asks.',
    'Use a short bridge phrase before longer tool lookups.',
  ];
  for (const rule of collectRuleText(options)
    .filter((item) => /\b(voice|phone|abbreviation|email|short|brief)\b/i.test(item))
    .slice(0, 4)) {
    instructions.push(`Apply this voice rule: ${rule}`);
  }

  return asRenderedProfile(VOICE_COMPACT_PROFILE_NAME, [
    `BEHAVIOR_PROFILE: ${VOICE_COMPACT_PROFILE_NAME}`,
    'PRIORITY: 10',
    'WHEN: channel.name == "voice"',
    '',
    'INSTRUCTIONS: |',
    ...instructions.map((instruction) => `  ${instruction}`),
    '',
    'RESPONSE:',
    `  MAX_RESPONSE_LENGTH: ${responseLengthForVoice(options)}`,
    '',
  ]);
}

function renderFrustrationEmpathyProfile(
  options: ArchManagedBehaviorProfileOptions = {},
): BlueprintRenderedBehaviorProfile {
  const instructions = [
    'Lead with one brief empathy acknowledgment when the customer sounds frustrated.',
    'Name the inconvenience without over-apologizing or repeating the same empathy beat.',
    'Move quickly from acknowledgment to the concrete next step.',
  ];
  for (const rule of collectRuleText(options)
    .filter((item) => /\b(empathy|empathetic|frustrat|upset|angry|sentiment|apolog)\b/i.test(item))
    .slice(0, 4)) {
    instructions.push(`Apply this empathy rule: ${rule}`);
  }

  return asRenderedProfile(FRUSTRATION_EMPATHY_PROFILE_NAME, [
    `BEHAVIOR_PROFILE: ${FRUSTRATION_EMPATHY_PROFILE_NAME}`,
    'PRIORITY: 5',
    'WHEN: interaction.sentiment_score < -0.3',
    '',
    'INSTRUCTIONS: |',
    ...instructions.map((instruction) => `  ${instruction}`),
    '',
  ]);
}

export function renderArchManagedBehaviorProfiles(
  options: ArchManagedBehaviorProfileOptions = {},
): BlueprintRenderedBehaviorProfile[] {
  const profiles: BlueprintRenderedBehaviorProfile[] = [];

  if (options.includeSharedVoiceHandoff !== false) {
    profiles.push(renderSharedVoiceHandoffProfile(options));
  }
  if (options.includePlainLanguage) {
    profiles.push(renderPlainLanguageProfile(options));
  }
  if (options.includeVoiceCompact) {
    profiles.push(renderVoiceCompactProfile(options));
  }
  if (options.includeEmpathy) {
    profiles.push(renderFrustrationEmpathyProfile(options));
  }

  return profiles;
}

export function isArchManagedBehaviorProfileName(
  name: string,
): name is ArchManagedBehaviorProfileName {
  return (ARCH_MANAGED_BEHAVIOR_PROFILE_NAMES as readonly string[]).includes(name);
}
