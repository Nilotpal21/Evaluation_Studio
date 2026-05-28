import type {
  RealtimeProviderType,
  RealtimeVoiceProviderCapabilityProfile,
} from '@abl/compiler/platform/llm/realtime/types.js';

export type VoicePromptProviderOverlay = RealtimeProviderType | 'grok_realtime';

const GEMINI_LIVE_RUNTIME_INSTRUCTION_APPENDIX = [
  '## Gemini Live Tool Result Contract',
  'If a tool result includes `runtime_instructions`, treat that field as the authoritative session context from that point forward.',
  'If the same tool result also includes `text`, speak the `text` field to the caller before continuing.',
  'If a tool result includes `continue_current_turn: true` without `text`, silently apply the new runtime instructions and continue answering the caller in the same turn.',
  'Do not announce internal transfer mechanics or mention tool execution.',
].join('\n');

const PROVIDER_PROMPT_OVERLAY_APPENDICES: Record<VoicePromptProviderOverlay, string | null> = {
  openai_realtime: null,
  gemini_live: GEMINI_LIVE_RUNTIME_INSTRUCTION_APPENDIX,
  ultravox: null,
  grok_realtime: null,
};

const PROVIDER_PROMPT_OVERLAY_NOTES: Partial<Record<VoicePromptProviderOverlay, string>> = {
  gemini_live:
    'Gemini Live keeps session instructions immutable after connect, so tool results may carry runtime instruction refresh payloads.',
};

export function resolveVoicePromptProviderOverlay(options: {
  providerPromptOverlay?: VoicePromptProviderOverlay;
  providerCapabilityProfile?: RealtimeVoiceProviderCapabilityProfile;
}): VoicePromptProviderOverlay | undefined {
  return options.providerPromptOverlay ?? options.providerCapabilityProfile?.providerType;
}

export function applyVoicePromptProviderOverlay(
  systemPrompt: string,
  providerPromptOverlay: VoicePromptProviderOverlay | undefined,
): string {
  const appendix = providerPromptOverlay
    ? PROVIDER_PROMPT_OVERLAY_APPENDICES[providerPromptOverlay]
    : null;
  if (!appendix) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\n${appendix}`;
}

export function describeVoicePromptProviderOverlay(
  providerPromptOverlay: VoicePromptProviderOverlay | undefined,
): string[] {
  if (!providerPromptOverlay) {
    return [];
  }

  const note = PROVIDER_PROMPT_OVERLAY_NOTES[providerPromptOverlay];
  return note ? [note] : [];
}

export function toVoicePromptProviderOverlay(
  providerType: RealtimeProviderType,
): VoicePromptProviderOverlay {
  return providerType;
}
