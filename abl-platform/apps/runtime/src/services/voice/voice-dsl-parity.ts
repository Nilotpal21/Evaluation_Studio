import {
  VOICE_BEHAVIOR_PROFILES,
  type VoiceBehaviorProfile,
} from '../../channels/channel-behavior-contract.js';
import { getVoiceChannelTypes } from '../../channels/manifest.js';
import type { ChannelType } from '../../channels/types.js';

export type VoiceConstructParityStatus = 'working' | 'partial' | 'gap';

export const VOICE_CONSTRUCT_IDS = [
  'on_start',
  'flow_step_respond',
  'voice_config',
  'gather_prompt',
  'digression',
  'sub_intent',
  'action_handler',
  'call_result_branch',
  'handoff_delegate_return',
  'escalation',
  'completion',
  'auth_error_outcome',
] as const;

export type VoiceConstructId = (typeof VOICE_CONSTRUCT_IDS)[number];

interface VoiceConstructDefinition {
  label: string;
  description: string;
  compilerEvidence: readonly string[];
  runtimeEvidence: readonly string[];
}

export const VOICE_DSL_CONSTRUCTS = {
  on_start: {
    label: 'ON_START',
    description: 'Session bootstrap, proactive greeting, and lifecycle-hook semantics.',
    compilerEvidence: [
      'packages/compiler/src/platform/ir/schema.ts',
      'packages/compiler/src/platform/ir/compiler.ts',
    ],
    runtimeEvidence: [
      'apps/runtime/src/services/execution/flow-step-executor.ts',
      'apps/runtime/src/websocket/sdk-handler.ts',
    ],
  },
  flow_step_respond: {
    label: 'Flow-step respond',
    description: 'Canonical RESPOND semantics for the active flow step.',
    compilerEvidence: [
      'packages/compiler/src/platform/ir/schema.ts',
      'packages/compiler/src/platform/ir/compiler.ts',
    ],
    runtimeEvidence: ['apps/runtime/src/services/execution/flow-step-executor.ts'],
  },
  voice_config: {
    label: 'voice_config',
    description:
      'Voice-specific response shaping attached to lifecycle hooks, steps, and branches.',
    compilerEvidence: [
      'packages/compiler/src/platform/ir/schema.ts',
      'packages/compiler/src/platform/ir/compiler.ts',
    ],
    runtimeEvidence: [
      'apps/runtime/src/services/execution/flow-step-executor.ts',
      'apps/runtime/src/channels/channel-behavior-contract.ts',
    ],
  },
  gather_prompt: {
    label: 'Gather prompt',
    description: 'Prompting and retry behavior for gather fields and voice-aware gather formats.',
    compilerEvidence: ['packages/compiler/src/platform/ir/schema.ts'],
    runtimeEvidence: ['apps/runtime/src/services/execution/flow-step-executor.ts'],
  },
  digression: {
    label: 'Digression',
    description: 'Intent-based escapes and return handling during flow execution.',
    compilerEvidence: [
      'packages/compiler/src/platform/ir/schema.ts',
      'packages/compiler/src/platform/ir/compiler.ts',
    ],
    runtimeEvidence: ['apps/runtime/src/services/execution/flow-step-executor.ts'],
  },
  sub_intent: {
    label: 'Sub-intent',
    description: 'Intent-matched sub-intent routing within the current flow step.',
    compilerEvidence: [
      'packages/compiler/src/platform/ir/schema.ts',
      'packages/compiler/src/platform/ir/compiler.ts',
    ],
    runtimeEvidence: ['apps/runtime/src/services/execution/flow-step-executor.ts'],
  },
  action_handler: {
    label: 'Action handler',
    description: 'Interactive action-handler semantics and voice-aware handler payloads.',
    compilerEvidence: [
      'packages/compiler/src/platform/ir/schema.ts',
      'packages/compiler/src/platform/ir/compiler.ts',
    ],
    runtimeEvidence: ['apps/runtime/src/services/execution/flow-step-executor.ts'],
  },
  call_result_branch: {
    label: 'CALL result branch',
    description: 'Branching semantics after tool/CALL success and failure blocks.',
    compilerEvidence: [
      'packages/compiler/src/platform/ir/schema.ts',
      'packages/compiler/src/platform/ir/compiler.ts',
    ],
    runtimeEvidence: [
      'apps/runtime/src/services/execution/flow-step-executor.ts',
      'apps/runtime/src/services/runtime-executor.ts',
    ],
  },
  handoff_delegate_return: {
    label: 'Handoff/delegate/return',
    description: 'Cross-agent routing, delegate return, and active-agent refresh semantics.',
    compilerEvidence: ['packages/compiler/src/platform/ir/schema.ts'],
    runtimeEvidence: ['apps/runtime/src/services/runtime-executor.ts'],
  },
  escalation: {
    label: 'Escalation',
    description: 'Escalate and suspension/resume semantics for voice sessions.',
    compilerEvidence: ['packages/compiler/src/platform/ir/schema.ts'],
    runtimeEvidence: ['apps/runtime/src/services/runtime-executor.ts'],
  },
  completion: {
    label: 'Completion',
    description: 'Completion checks, completion messages, and terminal voice outcomes.',
    compilerEvidence: ['packages/compiler/src/platform/ir/schema.ts'],
    runtimeEvidence: ['apps/runtime/src/services/runtime-executor.ts'],
  },
  auth_error_outcome: {
    label: 'Auth/error outcomes',
    description: 'Auth-required and error outcome shaping before delivery to voice channels.',
    compilerEvidence: ['packages/compiler/src/platform/ir/schema.ts'],
    runtimeEvidence: [
      'apps/runtime/src/services/channel/outcome.ts',
      'apps/runtime/src/services/auth-profile/auth-preflight.ts',
    ],
  },
} as const satisfies Record<VoiceConstructId, VoiceConstructDefinition>;

export const VOICE_PARITY_FAMILY_IDS = [
  'sdk_voice_pipeline',
  'sdk_voice_realtime',
  'twilio_voice',
  'livekit_voice',
  'bridge_voice',
] as const;

export type VoiceParityFamily = (typeof VOICE_PARITY_FAMILY_IDS)[number];

export interface VoiceConditionalChannelCoverage {
  channelType: ChannelType;
  when: string;
}

interface VoiceParityOverride {
  status: VoiceConstructParityStatus;
  rationale: string;
}

interface VoiceParityFamilyDefinition {
  label: string;
  description: string;
  behaviorProfiles: readonly VoiceBehaviorProfile[];
  directChannelTypes: readonly ChannelType[];
  conditionalChannelTypes: readonly VoiceConditionalChannelCoverage[];
  defaultStatus: VoiceConstructParityStatus;
  defaultRationale: string;
  evidence: readonly string[];
  constructOverrides: Partial<Record<VoiceConstructId, VoiceParityOverride>>;
}

export const VOICE_PARITY_FAMILIES = {
  sdk_voice_pipeline: {
    label: 'SDK voice (pipeline)',
    description:
      'Finalized SDK/browser voice utterances that run through canonical RuntimeExecutor turn execution.',
    behaviorProfiles: ['sdk_voice'],
    directChannelTypes: ['voice_pipeline'],
    conditionalChannelTypes: [
      {
        channelType: 'voice',
        when: 'resolveVoiceMode() returns pipeline',
      },
    ],
    defaultStatus: 'working',
    defaultRationale:
      'Pipeline SDK voice runs through initializeSession()/executeMessage() and canonical outcome shaping.',
    evidence: [
      'apps/runtime/src/websocket/sdk-handler.ts',
      'apps/runtime/src/services/channel/outcome.ts',
    ],
    constructOverrides: {
      voice_config: {
        status: 'partial',
        rationale:
          'SDK pipeline voice preserves voice-aware text output, but the current channel contract only guarantees plain-text voiceConfig delivery.',
      },
    },
  },
  sdk_voice_realtime: {
    label: 'SDK voice (realtime)',
    description:
      'SDK/browser voice sessions backed by provider-native realtime models and RealtimeVoiceExecutor.',
    behaviorProfiles: ['sdk_voice'],
    directChannelTypes: ['voice_realtime'],
    conditionalChannelTypes: [
      {
        channelType: 'voice',
        when: 'resolveVoiceMode() returns realtime',
      },
    ],
    defaultStatus: 'partial',
    defaultRationale:
      'Supported realtime SDK providers now route finalized turns through the canonical voice-turn coordinator via a dedicated realtime tool, while providers without tool-result injection remain explicit capability-gated partials.',
    evidence: [
      'apps/runtime/src/services/voice/realtime-voice-executor.ts',
      'apps/runtime/src/websocket/sdk-handler.ts',
      'apps/runtime/src/services/runtime-executor.ts',
    ],
    constructOverrides: {
      on_start: {
        status: 'partial',
        rationale:
          'SDK bootstrap can still fire ON_START before realtime startup, but ON_START remains a bootstrap surface rather than a per-turn coordinator outcome.',
      },
      call_result_branch: {
        status: 'partial',
        rationale:
          'CALL success/failure handling is canonical on coordinator-tool providers, but the family remains partial because providers without tool-result injection stay on the legacy path.',
      },
      handoff_delegate_return: {
        status: 'partial',
        rationale:
          'Handoff, delegate, and return semantics now flow through the canonical voice-turn coordinator on supported providers, but unsupported providers still degrade explicitly by capability.',
      },
      escalation: {
        status: 'partial',
        rationale:
          'Escalation is canonical on coordinator-tool providers, but the overall family remains partial because capability-limited providers stay on the legacy realtime surface.',
      },
      completion: {
        status: 'partial',
        rationale:
          'Completion runs through the canonical voice-turn coordinator on supported providers, but the family remains partial until every provider can honor the same coordinator tool contract.',
      },
      auth_error_outcome: {
        status: 'partial',
        rationale:
          'Auth/error outcomes are canonical on coordinator-tool providers, but providers without tool-result injection still fall back to explicit partial behavior.',
      },
    },
  },
  twilio_voice: {
    label: 'Twilio voice',
    description:
      'Twilio PSTN/media sessions with a pipeline baseline and an optional realtime branch selected at runtime.',
    behaviorProfiles: ['voice_core'],
    directChannelTypes: ['voice_twilio'],
    conditionalChannelTypes: [],
    defaultStatus: 'partial',
    defaultRationale:
      'Twilio pipeline voice and supported Twilio realtime providers both use the canonical voice-turn coordinator, but the family remains partial because voice delivery is still plain-text-only and unsupported realtime providers degrade explicitly by capability.',
    evidence: [
      'apps/runtime/src/websocket/twilio-media-handler.ts',
      'apps/runtime/src/services/voice/voice-session-resolver.ts',
      'apps/runtime/src/channels/channel-behavior-contract.ts',
    ],
    constructOverrides: {},
  },
  livekit_voice: {
    label: 'LiveKit voice',
    description:
      'LiveKit voice sessions that forward finalized transcripts through canonical RuntimeExecutor execution.',
    behaviorProfiles: ['voice_core'],
    directChannelTypes: ['voice_livekit'],
    conditionalChannelTypes: [],
    defaultStatus: 'working',
    defaultRationale:
      'LiveKit already delegates finalized turns through executeMessage() and buildExecutionOutcome().',
    evidence: [
      'apps/runtime/src/services/voice/livekit/runtime-llm-adapter.ts',
      'apps/runtime/src/services/channel/outcome.ts',
    ],
    constructOverrides: {
      on_start: {
        status: 'partial',
        rationale:
          'LiveKit uses canonical turn execution after the first utterance, but it does not run the SDK websocket fireOnStart bootstrap path on room join.',
      },
      voice_config: {
        status: 'partial',
        rationale:
          'LiveKit preserves canonical outcome shaping, but the current voice channel contract is plain-text-only for voiceConfig.',
      },
    },
  },
  bridge_voice: {
    label: 'Bridge voice',
    description:
      'Voice bridge surfaces spanning VXML, AudioCodes, and KoreVG, including pipeline and custom realtime-adjacent paths.',
    behaviorProfiles: ['voice_core'],
    directChannelTypes: ['voice_vxml', 'audiocodes', 'korevg'],
    conditionalChannelTypes: [],
    defaultStatus: 'partial',
    defaultRationale:
      'VXML, AudioCodes, and the KoreVG pipeline turn path now use the shared voice-turn coordinator and plain-text voice delivery, but the family remains partial because KoreVG still includes custom S2S/realtime paths and streaming token delivery cannot always wait for final voiceConfig shaping.',
    evidence: [
      'apps/runtime/src/routes/channel-vxml.ts',
      'apps/runtime/src/routes/channel-audiocodes.ts',
      'apps/runtime/src/services/voice/korevg/korevg-router.ts',
      'apps/runtime/src/channels/channel-behavior-contract.ts',
      'apps/runtime/src/services/channel/channel-adapter.ts',
    ],
    constructOverrides: {
      voice_config: {
        status: 'partial',
        rationale:
          'Bridge channels now resolve plain_text voiceConfig on final delivery, but KoreVG streaming turns can still emit raw response chunks before the final voiceConfig override is available.',
      },
    },
  },
} as const satisfies Record<VoiceParityFamily, VoiceParityFamilyDefinition>;

export interface VoiceConstructParityRecord {
  family: VoiceParityFamily;
  construct: VoiceConstructId;
  status: VoiceConstructParityStatus;
  rationale: string;
  evidence: readonly string[];
  behaviorProfiles: readonly VoiceBehaviorProfile[];
}

function getVoiceParityFamilyDefinition(family: VoiceParityFamily): VoiceParityFamilyDefinition {
  return VOICE_PARITY_FAMILIES[family];
}

export function getVoiceConstructParityRecord(
  family: VoiceParityFamily,
  construct: VoiceConstructId,
): VoiceConstructParityRecord {
  const familyDefinition = getVoiceParityFamilyDefinition(family);
  const override = familyDefinition.constructOverrides[construct];

  return {
    family,
    construct,
    status: override?.status ?? familyDefinition.defaultStatus,
    rationale: override?.rationale ?? familyDefinition.defaultRationale,
    evidence: familyDefinition.evidence,
    behaviorProfiles: familyDefinition.behaviorProfiles,
  };
}

export function listVoiceConstructParityRecords(): VoiceConstructParityRecord[] {
  return VOICE_PARITY_FAMILY_IDS.flatMap((family) =>
    VOICE_CONSTRUCT_IDS.map((construct) => getVoiceConstructParityRecord(family, construct)),
  );
}

export function getVoiceParityFamiliesForChannelType(
  channelType: ChannelType,
): VoiceParityFamily[] {
  return VOICE_PARITY_FAMILY_IDS.filter((family) => {
    const definition = getVoiceParityFamilyDefinition(family);
    return (
      definition.directChannelTypes.includes(channelType) ||
      definition.conditionalChannelTypes.some((coverage) => coverage.channelType === channelType)
    );
  });
}

export function getVoiceConstructParityTraceSnapshot(): VoiceConstructParityRecord[] {
  return listVoiceConstructParityRecords();
}

export function validateVoiceDslParity(): string[] {
  const diagnostics: string[] = [];
  const voiceBehaviorProfiles = new Set<VoiceBehaviorProfile>(VOICE_BEHAVIOR_PROFILES);

  for (const family of VOICE_PARITY_FAMILY_IDS) {
    const definition = getVoiceParityFamilyDefinition(family);
    if (
      definition.directChannelTypes.length === 0 &&
      definition.conditionalChannelTypes.length === 0
    ) {
      diagnostics.push(`Voice family "${family}" does not cover any voice channel types.`);
    }

    for (const behaviorProfile of definition.behaviorProfiles) {
      if (!voiceBehaviorProfiles.has(behaviorProfile)) {
        diagnostics.push(
          `Voice family "${family}" references non-voice behavior profile "${behaviorProfile}".`,
        );
      }
    }
  }

  const manifestVoiceChannelTypes = getVoiceChannelTypes() as ChannelType[];
  for (const channelType of manifestVoiceChannelTypes) {
    const families = getVoiceParityFamiliesForChannelType(channelType);
    if (families.length === 0) {
      diagnostics.push(`Voice channel "${channelType}" is missing parity-family coverage.`);
    }
  }

  const expectedRecordCount = VOICE_PARITY_FAMILY_IDS.length * VOICE_CONSTRUCT_IDS.length;
  const records = listVoiceConstructParityRecords();
  if (records.length !== expectedRecordCount) {
    diagnostics.push(
      `Expected ${expectedRecordCount} voice parity records, but found ${records.length}.`,
    );
  }

  for (const record of records) {
    if (record.rationale.trim().length === 0) {
      diagnostics.push(
        `Voice parity record "${record.family}/${record.construct}" is missing a rationale.`,
      );
    }
  }

  return diagnostics;
}
