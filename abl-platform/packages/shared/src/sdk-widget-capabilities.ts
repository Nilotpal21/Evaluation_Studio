export type SDKWidgetConfiguredMode = 'chat' | 'voice' | 'unified';
export type SDKWidgetInteractiveMode = 'chat' | 'voice';

export interface SDKWidgetCapabilityInput {
  configuredMode: SDKWidgetConfiguredMode;
  currentMode?: SDKWidgetInteractiveMode | null;
  chatEnabled: boolean;
  voiceEnabled: boolean;
  voiceSupported: boolean;
}

export interface SDKResolvedWidgetCapabilityState {
  chatEnabled: boolean;
  voiceEnabled: boolean;
  chatAvailable: boolean;
  voiceAvailable: boolean;
  allowedModes: SDKWidgetInteractiveMode[];
  effectiveMode: SDKWidgetInteractiveMode | null;
  showModeToggle: boolean;
}

type BrowserVoiceSupportWindowLike = {
  AudioContext?: unknown;
  webkitAudioContext?: unknown;
};

type BrowserVoiceSupportNavigatorLike = {
  mediaDevices?: {
    getUserMedia?: unknown;
  };
};

type BrowserVoiceSupportGlobalLike = typeof globalThis & {
  window?: BrowserVoiceSupportWindowLike;
  navigator?: BrowserVoiceSupportNavigatorLike;
};

function defaultModeForConfiguredMode(
  configuredMode: SDKWidgetConfiguredMode,
): SDKWidgetInteractiveMode {
  return configuredMode === 'voice' ? 'voice' : 'chat';
}

export function resolveSdkWidgetCapabilityState(
  input: SDKWidgetCapabilityInput,
): SDKResolvedWidgetCapabilityState {
  const chatAvailable = input.chatEnabled;
  const voiceAvailable = input.voiceEnabled && input.voiceSupported;
  const allowedModes: SDKWidgetInteractiveMode[] = [];

  if (chatAvailable) {
    allowedModes.push('chat');
  }

  if (voiceAvailable) {
    allowedModes.push('voice');
  }

  const preferredMode = input.currentMode ?? defaultModeForConfiguredMode(input.configuredMode);
  const effectiveMode = allowedModes.includes(preferredMode)
    ? preferredMode
    : (allowedModes[0] ?? null);

  return {
    chatEnabled: input.chatEnabled,
    voiceEnabled: input.voiceEnabled,
    chatAvailable,
    voiceAvailable,
    allowedModes,
    effectiveMode,
    showModeToggle: input.configuredMode === 'unified' && chatAvailable && voiceAvailable,
  };
}

export function isBrowserVoiceCaptureSupported(
  browserWindow?: BrowserVoiceSupportWindowLike | null,
  browserNavigator?: BrowserVoiceSupportNavigatorLike | null,
): boolean {
  const browserGlobal = globalThis as BrowserVoiceSupportGlobalLike;
  const resolvedWindow =
    browserWindow ?? browserGlobal.window ?? (browserGlobal as BrowserVoiceSupportWindowLike);
  const resolvedNavigator =
    browserNavigator ??
    browserGlobal.navigator ??
    (browserGlobal as BrowserVoiceSupportNavigatorLike);

  if (!resolvedWindow || !resolvedNavigator) {
    return false;
  }

  const hasAudioContext =
    typeof resolvedWindow.AudioContext === 'function' ||
    typeof resolvedWindow.webkitAudioContext === 'function';

  return typeof resolvedNavigator.mediaDevices?.getUserMedia === 'function' && hasAudioContext;
}
