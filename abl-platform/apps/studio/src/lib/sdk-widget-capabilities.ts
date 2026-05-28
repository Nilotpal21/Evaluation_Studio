import {
  resolveSdkWidgetCapabilityState,
  type SDKResolvedWidgetCapabilityState,
  type SDKWidgetConfiguredMode,
  type SDKWidgetInteractiveMode,
} from '@agent-platform/shared/sdk-widget-capabilities';

export interface StudioWidgetCapabilitySource {
  mode?: string | null;
  chatEnabled?: boolean | null;
  voiceEnabled?: boolean | null;
}

export interface StudioResolvedWidgetCapabilityState extends SDKResolvedWidgetCapabilityState {
  configuredMode: SDKWidgetConfiguredMode;
}

export function normalizeStudioWidgetConfiguredMode(mode: unknown): SDKWidgetConfiguredMode {
  if (mode === 'voice' || mode === 'unified') {
    return mode;
  }

  return 'chat';
}

export function normalizeStudioWidgetCapabilityConfig(source: StudioWidgetCapabilitySource): {
  configuredMode: SDKWidgetConfiguredMode;
  chatEnabled: boolean;
  voiceEnabled: boolean;
} {
  return {
    configuredMode: normalizeStudioWidgetConfiguredMode(source.mode),
    chatEnabled: source.chatEnabled !== false,
    voiceEnabled: source.voiceEnabled === true,
  };
}

export function resolveStudioWidgetCapabilityState(
  input: StudioWidgetCapabilitySource & {
    currentMode?: SDKWidgetInteractiveMode | null;
    voiceSupported: boolean;
  },
): StudioResolvedWidgetCapabilityState {
  const normalized = normalizeStudioWidgetCapabilityConfig(input);

  return {
    configuredMode: normalized.configuredMode,
    ...resolveSdkWidgetCapabilityState({
      configuredMode: normalized.configuredMode,
      currentMode: input.currentMode,
      chatEnabled: normalized.chatEnabled,
      voiceEnabled: normalized.voiceEnabled,
      voiceSupported: input.voiceSupported,
    }),
  };
}

export function resolveStudioProjectPreviewCapabilityState(
  source: StudioWidgetCapabilitySource,
): StudioResolvedWidgetCapabilityState {
  return resolveStudioWidgetCapabilityState({
    mode: source.mode,
    currentMode: 'chat',
    chatEnabled: source.chatEnabled,
    voiceEnabled: source.voiceEnabled,
    voiceSupported: false,
  });
}
