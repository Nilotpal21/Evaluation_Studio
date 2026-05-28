import { validateSdkUserContext } from '../core/sdk-user-context-validation.js';
import type { SDKConfig, SDKUserContext } from '../core/types.js';

export const WIDGET_SDK_CONFIG_ATTRIBUTE_NAMES = [
  'project-id',
  'api-key',
  'bootstrap-token',
  'endpoint',
  'debug',
  'channel-id',
  'channel-name',
  'deployment-slug',
  'user-context',
  'vad-script-url',
  'onnx-runtime-script-url',
  'vad-base-asset-path',
  'onnx-wasm-base-path',
  'vad-script-nonce',
] as const;

export const WIDGET_SDK_CONFIG_ATTRIBUTES = new Set<string>(WIDGET_SDK_CONFIG_ATTRIBUTE_NAMES);

export const WIDGET_CAPABILITY_ATTRIBUTE_NAMES = ['chat-enabled', 'voice-enabled'] as const;
export const WIDGET_CAPABILITY_ATTRIBUTES = new Set<string>(WIDGET_CAPABILITY_ATTRIBUTE_NAMES);
export const WIDGET_DISPLAY_ATTRIBUTE_NAMES = [] as const;
export const WIDGET_DISPLAY_ATTRIBUTES = new Set<string>(WIDGET_DISPLAY_ATTRIBUTE_NAMES);

export interface WidgetCapabilityConfig {
  chatEnabled: boolean;
  voiceEnabled: boolean;
}

function requireAttribute(element: Element, attributeName: string): string {
  const value = element.getAttribute(attributeName)?.trim();
  if (!value) {
    throw new Error(`Missing ${attributeName} attribute`);
  }

  return value;
}

function readBooleanAttribute(
  element: Element,
  attributeName: string,
  defaultValue: boolean,
): boolean {
  const rawValue = element.getAttribute(attributeName)?.trim().toLowerCase();
  if (!rawValue) {
    return defaultValue;
  }

  if (rawValue === 'true') {
    return true;
  }

  if (rawValue === 'false') {
    return false;
  }

  throw new Error(`Invalid ${attributeName} attribute: expected "true" or "false"`);
}

function parseUserContextAttribute(element: Element): SDKUserContext | undefined {
  const rawValue = element.getAttribute('user-context')?.trim();
  if (!rawValue) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error('Invalid user-context attribute: expected a JSON object');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid user-context attribute: expected a JSON object');
  }

  const userContext = parsed as SDKUserContext;
  validateSdkUserContext(userContext);
  return userContext;
}

function readOptionalAttribute(element: Element, attributeName: string): string | undefined {
  const value = element.getAttribute(attributeName)?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readWidgetVoiceConfig(element: Element): SDKConfig['voice'] {
  const vadScriptUrl = readOptionalAttribute(element, 'vad-script-url');
  const onnxRuntimeScriptUrl = readOptionalAttribute(element, 'onnx-runtime-script-url');
  const baseAssetPath = readOptionalAttribute(element, 'vad-base-asset-path');
  const onnxWASMBasePath = readOptionalAttribute(element, 'onnx-wasm-base-path');
  const scriptNonce = readOptionalAttribute(element, 'vad-script-nonce');

  if (
    !vadScriptUrl &&
    !onnxRuntimeScriptUrl &&
    !baseAssetPath &&
    !onnxWASMBasePath &&
    !scriptNonce
  ) {
    return undefined;
  }

  return {
    vadConfig: {
      vadScriptUrl,
      onnxRuntimeScriptUrl,
      baseAssetPath,
      onnxWASMBasePath,
      scriptNonce,
    },
  };
}

export function readWidgetSdkConfig(element: Element): SDKConfig {
  const projectId = requireAttribute(element, 'project-id');
  const endpoint = requireAttribute(element, 'endpoint');
  const apiKey = element.getAttribute('api-key')?.trim();
  const bootstrapToken = element.getAttribute('bootstrap-token')?.trim();
  const channelId = element.getAttribute('channel-id')?.trim();
  const channelName = element.getAttribute('channel-name')?.trim();
  const deploymentSlug = element.getAttribute('deployment-slug')?.trim();
  const userContext = parseUserContextAttribute(element);
  const voice = readWidgetVoiceConfig(element);

  if (!!apiKey === !!bootstrapToken) {
    throw new Error('Provide exactly one of api-key or bootstrap-token');
  }

  if (bootstrapToken && (channelId || channelName || deploymentSlug || userContext)) {
    throw new Error(
      'bootstrap-token cannot be combined with channel-id, channel-name, deployment-slug, or user-context',
    );
  }

  return bootstrapToken
    ? {
        projectId,
        bootstrapToken,
        endpoint,
        debug: element.getAttribute('debug') === 'true',
        voice,
      }
    : {
        projectId,
        apiKey: apiKey!,
        endpoint,
        channelId: channelId || undefined,
        channelName: channelName || undefined,
        deploymentSlug: deploymentSlug || undefined,
        userContext,
        debug: element.getAttribute('debug') === 'true',
        voice,
      };
}

export function readWidgetCapabilityConfig(element: Element): WidgetCapabilityConfig {
  return {
    chatEnabled: readBooleanAttribute(element, 'chat-enabled', true),
    voiceEnabled: readBooleanAttribute(element, 'voice-enabled', false),
  };
}
