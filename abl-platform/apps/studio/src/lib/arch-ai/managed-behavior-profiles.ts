import {
  FRUSTRATION_EMPATHY_PROFILE_NAME,
  PLAIN_LANGUAGE_PROFILE_NAME,
  VOICE_COMPACT_PROFILE_NAME,
  isArchManagedBehaviorProfileName,
  renderArchManagedBehaviorProfiles,
  SHARED_VOICE_HANDOFF_PROFILE_NAME,
} from '@agent-platform/arch-ai/blueprint/managed-profiles';
import type { SourceArchitectureContract } from '@agent-platform/arch-ai/blueprint';

const SHARED_VOICE_PROFILE_REFERENCE_PATTERN =
  /^\s*USE(?:_|\s+)BEHAVIOR_PROFILE:\s*shared_voice_handoff\b/m;

export interface ManagedProfileTopology {
  edges?: ReadonlyArray<{
    to?: string;
    type?: string;
    experienceMode?: string;
  }>;
  entryPoint?: string;
}

export interface ManagedProfileDomainContext {
  channels?: ReadonlyArray<string>;
  tone?: ReadonlyArray<string> | string;
  universalRules?: ReadonlyArray<string>;
  channelRules?: ReadonlyArray<{
    channel: string;
    responseMaxWords?: number;
    abbreviationPolicy?: 'expand_for_voice' | 'preserve_text';
    toolLatencyBridge?: boolean;
    rules?: ReadonlyArray<string>;
  }>;
}

export interface ManagedBehaviorProfileFile {
  content: string;
}

export function renderSourceBehaviorProfileFiles(
  sourceContract: SourceArchitectureContract | null | undefined,
): Record<string, ManagedBehaviorProfileFile> {
  return Object.fromEntries(
    (sourceContract?.behaviorProfiles ?? []).map((profile) => [
      profile.name,
      {
        content: profile.dslContent.endsWith('\n') ? profile.dslContent : `${profile.dslContent}\n`,
      },
    ]),
  );
}

export function topologyUsesSharedVoiceHandoff(
  topology: ManagedProfileTopology | null | undefined,
): boolean {
  return (topology?.edges ?? []).some((edge) => edge.experienceMode === 'shared_voice_handoff');
}

export function agentUsesSharedVoiceHandoff(
  topology: ManagedProfileTopology | null | undefined,
  agentName: string,
): boolean {
  if (!topology || topology.entryPoint === agentName) {
    return false;
  }
  return (topology.edges ?? []).some(
    (edge) => edge.to === agentName && edge.experienceMode === 'shared_voice_handoff',
  );
}

function normalizeTone(domain: ManagedProfileDomainContext): string[] {
  const tone = Array.isArray(domain.tone)
    ? domain.tone
    : typeof domain.tone === 'string' && domain.tone.trim().length > 0
      ? [domain.tone]
      : [];
  return tone;
}

function channelNames(domain: ManagedProfileDomainContext): Set<string> {
  return new Set([
    ...(domain.channels ?? []).map((channel) => channel.trim().toLowerCase()),
    ...(domain.channelRules ?? []).map((rule) => rule.channel.trim().toLowerCase()),
  ]);
}

function sourceRuleText(domain: ManagedProfileDomainContext): string {
  return [
    ...(domain.universalRules ?? []),
    ...(domain.channelRules ?? []).flatMap((rule) => rule.rules ?? []),
  ].join(' ');
}

function shouldUsePlainLanguageProfile(domain: ManagedProfileDomainContext): boolean {
  return /\b(plain language|jargon|forbidden phrase|abbreviation|acronym)\b/i.test(
    sourceRuleText(domain),
  );
}

function shouldUseVoiceCompactProfile(domain: ManagedProfileDomainContext): boolean {
  return channelNames(domain).has('voice') || channelNames(domain).has('phone');
}

function shouldUseEmpathyProfile(domain: ManagedProfileDomainContext): boolean {
  return /\b(empathy|empathetic|frustrat|upset|angry|sentiment|apolog)\b/i.test(
    sourceRuleText(domain),
  );
}

function isCustomerFacingManagedProfileTarget(
  topology: ManagedProfileTopology | null | undefined,
  agentName: string,
): boolean {
  if (topology?.entryPoint === agentName) {
    return true;
  }

  const incomingEdges = topology?.edges?.filter((edge) => edge.to === agentName) ?? [];
  if (incomingEdges.some((edge) => edge.experienceMode === 'silent_delegate')) {
    return false;
  }
  if (incomingEdges.some((edge) => edge.experienceMode === 'human_escalation')) {
    return false;
  }

  return incomingEdges.some(
    (edge) =>
      edge.experienceMode === 'shared_voice_handoff' ||
      edge.experienceMode === 'visible_handoff' ||
      edge.type === 'transfer',
  );
}

export function resolveManagedBehaviorProfileUses(
  topology: ManagedProfileTopology | null | undefined,
  agentName: string,
  domain: ManagedProfileDomainContext = {},
): string[] {
  const uses: string[] = [];
  if (agentUsesSharedVoiceHandoff(topology, agentName)) {
    uses.push(SHARED_VOICE_HANDOFF_PROFILE_NAME);
  }

  if (!isCustomerFacingManagedProfileTarget(topology, agentName)) {
    return uses;
  }

  if (shouldUsePlainLanguageProfile(domain)) {
    uses.push(PLAIN_LANGUAGE_PROFILE_NAME);
  }
  if (shouldUseVoiceCompactProfile(domain)) {
    uses.push(VOICE_COMPACT_PROFILE_NAME);
  }
  if (shouldUseEmpathyProfile(domain)) {
    uses.push(FRUSTRATION_EMPATHY_PROFILE_NAME);
  }

  return [...new Set(uses)];
}

function renderManagedProfileFiles(input: {
  profileNames: ReadonlyArray<string>;
  domain: ManagedProfileDomainContext;
}): Record<string, ManagedBehaviorProfileFile> {
  if (input.profileNames.length === 0) {
    return {};
  }

  const profileNameSet = new Set(input.profileNames);
  return Object.fromEntries(
    renderArchManagedBehaviorProfiles({
      channels: input.domain.channels ?? [],
      tone: normalizeTone(input.domain),
      universalRules: input.domain.universalRules,
      channelRules: input.domain.channelRules,
      includeSharedVoiceHandoff: profileNameSet.has(SHARED_VOICE_HANDOFF_PROFILE_NAME),
      includePlainLanguage: profileNameSet.has(PLAIN_LANGUAGE_PROFILE_NAME),
      includeVoiceCompact: profileNameSet.has(VOICE_COMPACT_PROFILE_NAME),
      includeEmpathy: profileNameSet.has(FRUSTRATION_EMPATHY_PROFILE_NAME),
    }).map((profile) => [profile.name, { content: profile.dslContent }]),
  );
}

export function renderManagedBehaviorProfileFilesForTopology(
  topology: ManagedProfileTopology | null | undefined,
  domain: ManagedProfileDomainContext = {},
): Record<string, ManagedBehaviorProfileFile> {
  const profileNames = new Set<string>();
  if (topologyUsesSharedVoiceHandoff(topology)) {
    profileNames.add(SHARED_VOICE_HANDOFF_PROFILE_NAME);
  }
  if (shouldUseVoiceCompactProfile(domain)) {
    profileNames.add(VOICE_COMPACT_PROFILE_NAME);
  }
  if (shouldUsePlainLanguageProfile(domain)) {
    profileNames.add(PLAIN_LANGUAGE_PROFILE_NAME);
  }
  if (shouldUseEmpathyProfile(domain)) {
    profileNames.add(FRUSTRATION_EMPATHY_PROFILE_NAME);
  }

  return renderManagedProfileFiles({ profileNames: [...profileNames], domain });
}

export function renderManagedBehaviorProfileFilesForReferences(
  agentFiles: Record<string, { content?: string }> | null | undefined,
  domain: ManagedProfileDomainContext = {},
): Record<string, ManagedBehaviorProfileFile> {
  const profileNames = new Set<string>();
  for (const file of Object.values(agentFiles ?? {})) {
    if (typeof file.content !== 'string') {
      continue;
    }
    if (SHARED_VOICE_PROFILE_REFERENCE_PATTERN.test(file.content)) {
      profileNames.add(SHARED_VOICE_HANDOFF_PROFILE_NAME);
    }
    for (const match of file.content.matchAll(
      /^\s*USE(?:_|\s+)BEHAVIOR_PROFILE:\s*([A-Za-z_][A-Za-z0-9_-]*)\b/gm,
    )) {
      const profileName = match[1];
      if (profileName && isArchManagedBehaviorProfileName(profileName)) {
        profileNames.add(profileName);
      }
    }
  }

  return renderManagedProfileFiles({ profileNames: [...profileNames], domain });
}

export function renderManagedBehaviorProfileDocumentsForTopology(
  topology: ManagedProfileTopology | null | undefined,
  domain: ManagedProfileDomainContext = {},
): string[] {
  return Object.values(renderManagedBehaviorProfileFilesForTopology(topology, domain)).map(
    (file) => file.content,
  );
}

export function renderSourceBehaviorProfileDocuments(
  sourceContract: SourceArchitectureContract | null | undefined,
): string[] {
  return Object.values(renderSourceBehaviorProfileFiles(sourceContract)).map(
    (file) => file.content,
  );
}
