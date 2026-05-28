import { normalizeSdkWidgetTheme } from '@/lib/sdk-widget-theme';

export type StudioSdkWidgetMode = 'chat' | 'voice' | 'unified';
export type StudioSdkWidgetPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface StudioSdkWidgetConfigSource {
  mode?: unknown;
  position?: unknown;
  theme?: unknown;
  welcomeMessage?: unknown;
  placeholderText?: unknown;
  voiceEnabled?: unknown;
  chatEnabled?: unknown;
}

export interface ResolvedStudioSdkWidgetConfig {
  mode: StudioSdkWidgetMode;
  position: StudioSdkWidgetPosition;
  theme: Record<string, string>;
  welcomeMessage: string | null;
  placeholderText: string;
  voiceEnabled: boolean;
  chatEnabled: boolean;
}

const SDK_WIDGET_MODES = new Set<StudioSdkWidgetMode>(['chat', 'voice', 'unified']);
const SDK_WIDGET_POSITIONS = new Set<StudioSdkWidgetPosition>([
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
]);
const DEFAULT_PLACEHOLDER_TEXT = 'Type a message...';

function readMode(value: unknown): StudioSdkWidgetMode {
  return typeof value === 'string' && SDK_WIDGET_MODES.has(value as StudioSdkWidgetMode)
    ? (value as StudioSdkWidgetMode)
    : 'chat';
}

function readPosition(value: unknown): StudioSdkWidgetPosition {
  return typeof value === 'string' && SDK_WIDGET_POSITIONS.has(value as StudioSdkWidgetPosition)
    ? (value as StudioSdkWidgetPosition)
    : 'bottom-right';
}

function readWelcomeMessage(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readPlaceholderText(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_PLACEHOLDER_TEXT;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? value : DEFAULT_PLACEHOLDER_TEXT;
}

function isConfigSourceRecord(value: unknown): value is StudioSdkWidgetConfigSource {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveStudioSdkWidgetConfigValues(
  source: unknown,
  options: { themeFallback?: Record<string, string> } = {},
): ResolvedStudioSdkWidgetConfig {
  const configSource = isConfigSourceRecord(source) ? source : {};

  return {
    mode: readMode(configSource.mode),
    position: readPosition(configSource.position),
    theme: normalizeSdkWidgetTheme(configSource.theme, options.themeFallback),
    welcomeMessage: readWelcomeMessage(configSource.welcomeMessage),
    placeholderText: readPlaceholderText(configSource.placeholderText),
    voiceEnabled: configSource.voiceEnabled === true,
    chatEnabled: configSource.chatEnabled !== false,
  };
}
