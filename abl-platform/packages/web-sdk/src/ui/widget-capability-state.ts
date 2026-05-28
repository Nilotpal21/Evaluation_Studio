import {
  type SDKResolvedWidgetCapabilityState,
  type SDKWidgetConfiguredMode,
  type SDKWidgetInteractiveMode,
  resolveSdkWidgetCapabilityState,
} from '../internal/sdk-widget-capabilities.js';
import { isVoiceBrowserSupported } from '../voice/browser-support.js';
import { readWidgetCapabilityConfig } from './widget-sdk-config.js';

export function resolveElementWidgetCapabilityState(
  element: Element,
  configuredMode: SDKWidgetConfiguredMode,
  currentMode?: SDKWidgetInteractiveMode | null,
): SDKResolvedWidgetCapabilityState {
  const capabilityConfig = readWidgetCapabilityConfig(element);
  return resolveSdkWidgetCapabilityState({
    configuredMode,
    currentMode,
    chatEnabled: capabilityConfig.chatEnabled,
    voiceEnabled: capabilityConfig.voiceEnabled,
    voiceSupported: isVoiceBrowserSupported(),
  });
}
