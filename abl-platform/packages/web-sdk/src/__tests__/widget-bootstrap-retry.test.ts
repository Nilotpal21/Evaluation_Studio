import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const connectMock = vi.fn();
const disconnectMock = vi.fn();
const isConnectedMock = vi.fn(() => true);
const onMock = vi.fn(() => () => {});
const chatOnMock = vi.fn();
const chatSendMock = vi.fn();
const voiceOnMock = vi.fn();
const voiceStartMock = vi.fn();
const voiceStopMock = vi.fn();
const voiceToggleMuteMock = vi.fn(() => false);
const voiceGetInfoMock = vi.fn(() => ({ isMuted: false }));
const voiceGetLastThoughtMock = vi.fn(() => null);
const constructorConfigs: unknown[] = [];

vi.mock('../core/AgentSDK.js', () => {
  class AgentSDK {
    constructor(config: unknown) {
      constructorConfigs.push(config);
    }

    on = onMock;
    connect = connectMock;
    disconnect = disconnectMock;
    isConnected = isConnectedMock;
    chat = () => ({
      on: chatOnMock,
      send: chatSendMock,
    });
    voice = () => ({
      on: voiceOnMock,
      start: voiceStartMock,
      stop: voiceStopMock,
      toggleMute: voiceToggleMuteMock,
      getInfo: voiceGetInfoMock,
      getLastThought: voiceGetLastThoughtMock,
    });
  }

  return { AgentSDK };
});

import { ChatWidget } from '../ui/ChatWidget.js';
import { UnifiedWidget } from '../ui/UnifiedWidget.js';
import { VoiceWidget } from '../ui/VoiceWidget.js';

async function flushMicrotasks(iterations = 6): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function configureWidgetAttributes(widget: HTMLElement): void {
  widget.setAttribute('project-id', 'project-1');
  widget.setAttribute('api-key', 'pk_test');
  widget.setAttribute('endpoint', 'https://runtime.example.com');
}

function enableVoiceBrowserSupport(): void {
  vi.stubGlobal('AudioContext', class MockAudioContext {});
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      getUserMedia: vi.fn(),
    },
  });
}

function configureVoiceWidgetAttributes(widget: HTMLElement): void {
  configureWidgetAttributes(widget);
  widget.setAttribute('voice-enabled', 'true');
}

function expectSdkConfigAt(index: number): {
  projectId: string;
  apiKey: string;
  endpoint: string;
  channelName?: string;
  deploymentSlug?: string;
  voice?: {
    vadConfig?: {
      vadScriptUrl?: string;
      onnxRuntimeScriptUrl?: string;
      baseAssetPath?: string;
      onnxWASMBasePath?: string;
      scriptNonce?: string;
    };
  };
  userContext?: {
    userId?: string;
    customAttributes?: Record<string, unknown>;
  };
} {
  return constructorConfigs[index] as {
    projectId: string;
    apiKey: string;
    endpoint: string;
    channelName?: string;
    deploymentSlug?: string;
    voice?: {
      vadConfig?: {
        vadScriptUrl?: string;
        onnxRuntimeScriptUrl?: string;
        baseAssetPath?: string;
        onnxWASMBasePath?: string;
        scriptNonce?: string;
      };
    };
    userContext?: {
      userId?: string;
      customAttributes?: Record<string, unknown>;
    };
  };
}

function mountWidget<T extends HTMLElement>(widget: T): T {
  document.body.appendChild(widget);
  return widget;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe('widget bootstrap retry safety', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    connectMock.mockReset();
    disconnectMock.mockReset();
    isConnectedMock.mockReset();
    isConnectedMock.mockReturnValue(true);
    onMock.mockReset();
    onMock.mockReturnValue(() => {});
    chatOnMock.mockReset();
    chatSendMock.mockReset();
    voiceOnMock.mockReset();
    voiceStartMock.mockReset();
    voiceStartMock.mockResolvedValue(undefined);
    voiceStopMock.mockReset();
    voiceToggleMuteMock.mockReset();
    voiceToggleMuteMock.mockReturnValue(false);
    voiceGetInfoMock.mockReset();
    voiceGetInfoMock.mockReturnValue({ isMuted: false });
    voiceGetLastThoughtMock.mockReset();
    voiceGetLastThoughtMock.mockReturnValue(null);
    constructorConfigs.length = 0;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('ChatWidget recovers from initial connect failure without element recreation', async () => {
    connectMock
      .mockRejectedValueOnce(new Error('first connect failed'))
      .mockResolvedValue(undefined);

    const widget = new ChatWidget();
    configureWidgetAttributes(widget);
    mountWidget(widget);

    await widget.open();
    expect(widget.getSDK()).toBeNull();
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(disconnectMock).toHaveBeenCalledTimes(1);

    await widget.open();
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(widget.getSDK()).not.toBeNull();
    expect(constructorConfigs).toHaveLength(2);
  });

  test('ChatWidget keeps the composer disabled until connect resolves', async () => {
    const connectDeferred = createDeferred<void>();
    connectMock.mockImplementation(() => connectDeferred.promise);
    isConnectedMock.mockReturnValue(false);

    const widget = new ChatWidget();
    configureWidgetAttributes(widget);
    mountWidget(widget);

    const openPromise = widget.open();
    await flushMicrotasks();

    const input = widget.shadowRoot?.querySelector('.input-field') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.disabled).toBe(true);

    isConnectedMock.mockReturnValue(true);
    connectDeferred.resolve();
    await openPromise;

    expect(
      (widget.shadowRoot?.querySelector('.input-field') as HTMLInputElement | null)?.disabled,
    ).toBe(false);
  });

  test('UnifiedWidget recovers from initial connect failure without element recreation', async () => {
    connectMock
      .mockRejectedValueOnce(new Error('first connect failed'))
      .mockResolvedValue(undefined);

    const widget = new UnifiedWidget();
    configureWidgetAttributes(widget);
    mountWidget(widget);

    await widget.open();
    expect(widget.getSDK()).toBeNull();
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(disconnectMock).toHaveBeenCalledTimes(1);

    await widget.open();
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(widget.getSDK()).not.toBeNull();
    expect(constructorConfigs).toHaveLength(2);
  });

  test('UnifiedWidget keeps the chat composer disabled until connect resolves', async () => {
    const connectDeferred = createDeferred<void>();
    connectMock.mockImplementation(() => connectDeferred.promise);
    isConnectedMock.mockReturnValue(false);

    const widget = new UnifiedWidget();
    configureWidgetAttributes(widget);
    widget.setAttribute('mode', 'unified');
    widget.setAttribute('chat-enabled', 'true');
    widget.setAttribute('voice-enabled', 'false');
    mountWidget(widget);

    const openPromise = widget.open();
    await flushMicrotasks();

    const input = widget.shadowRoot?.querySelector('.input-field') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.disabled).toBe(true);

    isConnectedMock.mockReturnValue(true);
    connectDeferred.resolve();
    await openPromise;

    expect(
      (widget.shadowRoot?.querySelector('.input-field') as HTMLInputElement | null)?.disabled,
    ).toBe(false);
  });

  test('ChatWidget reinitializes the SDK when endpoint changes while open', async () => {
    connectMock.mockResolvedValue(undefined);

    const widget = new ChatWidget();
    configureWidgetAttributes(widget);
    mountWidget(widget);

    await widget.open();
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(constructorConfigs).toHaveLength(1);

    widget.setAttribute('endpoint', 'https://runtime-2.example.com');
    await flushMicrotasks();

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(constructorConfigs).toHaveLength(2);
    expect((constructorConfigs[1] as { endpoint: string }).endpoint).toBe(
      'https://runtime-2.example.com',
    );
  });

  test('ChatWidget reinitializes the SDK when channel-name changes while open', async () => {
    connectMock.mockResolvedValue(undefined);

    const widget = new ChatWidget();
    configureWidgetAttributes(widget);
    widget.setAttribute('channel-name', 'primary-channel');
    mountWidget(widget);

    await widget.open();
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(constructorConfigs).toHaveLength(1);
    expect((constructorConfigs[0] as { channelName?: string }).channelName).toBe('primary-channel');

    widget.setAttribute('channel-name', 'secondary-channel');
    await flushMicrotasks();

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(constructorConfigs).toHaveLength(2);
    expect((constructorConfigs[1] as { channelName?: string }).channelName).toBe(
      'secondary-channel',
    );
  });

  test('UnifiedWidget reinitializes the SDK when endpoint changes while open', async () => {
    connectMock.mockResolvedValue(undefined);

    const widget = new UnifiedWidget();
    configureWidgetAttributes(widget);
    mountWidget(widget);

    await widget.open();
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(constructorConfigs).toHaveLength(1);

    widget.setAttribute('endpoint', 'https://runtime-2.example.com');
    await flushMicrotasks();

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(constructorConfigs).toHaveLength(2);
    expect((constructorConfigs[1] as { endpoint: string }).endpoint).toBe(
      'https://runtime-2.example.com',
    );
  });

  test('UnifiedWidget reinitializes the SDK when channel-name changes while open', async () => {
    connectMock.mockResolvedValue(undefined);

    const widget = new UnifiedWidget();
    configureWidgetAttributes(widget);
    widget.setAttribute('channel-name', 'primary-channel');
    mountWidget(widget);

    await widget.open();
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(constructorConfigs).toHaveLength(1);
    expect((constructorConfigs[0] as { channelName?: string }).channelName).toBe('primary-channel');

    widget.setAttribute('channel-name', 'secondary-channel');
    await flushMicrotasks();

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(constructorConfigs).toHaveLength(2);
    expect((constructorConfigs[1] as { channelName?: string }).channelName).toBe(
      'secondary-channel',
    );
  });

  test('ChatWidget fails closed when chat capability is disabled', async () => {
    connectMock.mockResolvedValue(undefined);

    const widget = new ChatWidget();
    configureWidgetAttributes(widget);
    widget.setAttribute('chat-enabled', 'false');
    mountWidget(widget);

    await widget.open();

    expect(connectMock).not.toHaveBeenCalled();
    expect(widget.getSDK()).toBeNull();
    expect(widget.shadowRoot?.textContent).toContain(
      'This widget is not configured for chat in this browser.',
    );
  });

  test('VoiceWidget fails closed when voice capability is disabled', async () => {
    connectMock.mockResolvedValue(undefined);

    const widget = new VoiceWidget();
    configureWidgetAttributes(widget);
    mountWidget(widget);
    await flushMicrotasks();

    expect(connectMock).not.toHaveBeenCalled();
    expect(widget.getSDK()).toBeNull();
  });

  test('VoiceWidget does not bootstrap when the browser lacks voice support', async () => {
    connectMock.mockResolvedValue(undefined);

    const widget = new VoiceWidget();
    configureWidgetAttributes(widget);
    widget.setAttribute('voice-enabled', 'true');
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: undefined,
    });
    mountWidget(widget);
    await flushMicrotasks();

    expect(connectMock).not.toHaveBeenCalled();
    expect(widget.getSDK()).toBeNull();
    expect(widget.shadowRoot?.textContent).toContain(
      'Voice is not available for this widget in this browser.',
    );
  });

  test('VoiceWidget fails closed when required SDK config is missing', async () => {
    connectMock.mockResolvedValue(undefined);

    enableVoiceBrowserSupport();
    const widget = new VoiceWidget();
    widget.setAttribute('project-id', 'project-1');
    widget.setAttribute('api-key', 'pk_test');
    widget.setAttribute('voice-enabled', 'true');
    mountWidget(widget);
    await flushMicrotasks();

    expect(connectMock).not.toHaveBeenCalled();
    expect(widget.getSDK()).toBeNull();
    expect(
      (widget.shadowRoot?.querySelector('.voice-btn') as HTMLButtonElement | null)?.disabled,
    ).toBe(true);
    expect(widget.shadowRoot?.textContent).toContain(
      'Voice widget is unavailable: Missing endpoint attribute',
    );
  });

  test('VoiceWidget retries initialization on start after a failed bootstrap attempt', async () => {
    connectMock
      .mockRejectedValueOnce(new Error('first connect failed'))
      .mockResolvedValue(undefined);

    enableVoiceBrowserSupport();
    const widget = new VoiceWidget();
    configureVoiceWidgetAttributes(widget);
    mountWidget(widget);
    await flushMicrotasks();

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(widget.getSDK()).toBeNull();
    expect(disconnectMock).toHaveBeenCalledTimes(1);

    await widget.start();
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(widget.getSDK()).not.toBeNull();
    expect(voiceStartMock).toHaveBeenCalledTimes(1);
    expect(constructorConfigs).toHaveLength(2);
  });

  test('VoiceWidget reinitializes the SDK when endpoint changes after bootstrap', async () => {
    connectMock.mockResolvedValue(undefined);

    enableVoiceBrowserSupport();
    const widget = new VoiceWidget();
    configureVoiceWidgetAttributes(widget);
    mountWidget(widget);
    await flushMicrotasks();

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(constructorConfigs).toHaveLength(1);

    widget.setAttribute('endpoint', 'https://runtime-2.example.com');
    await flushMicrotasks();

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(constructorConfigs).toHaveLength(2);
    expect((constructorConfigs[1] as { endpoint: string }).endpoint).toBe(
      'https://runtime-2.example.com',
    );
  });

  test('VoiceWidget reinitializes the SDK when channel-name changes after bootstrap', async () => {
    connectMock.mockResolvedValue(undefined);

    enableVoiceBrowserSupport();
    const widget = new VoiceWidget();
    configureVoiceWidgetAttributes(widget);
    widget.setAttribute('channel-name', 'primary-channel');
    mountWidget(widget);
    await flushMicrotasks();

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(constructorConfigs).toHaveLength(1);
    expect((constructorConfigs[0] as { channelName?: string }).channelName).toBe('primary-channel');

    widget.setAttribute('channel-name', 'secondary-channel');
    await flushMicrotasks();

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(constructorConfigs).toHaveLength(2);
    expect((constructorConfigs[1] as { channelName?: string }).channelName).toBe(
      'secondary-channel',
    );
  });

  test('VoiceWidget forwards self-hosted VAD asset attributes into AgentSDK config', async () => {
    connectMock.mockResolvedValue(undefined);

    enableVoiceBrowserSupport();
    const widget = new VoiceWidget();
    configureVoiceWidgetAttributes(widget);
    widget.setAttribute('vad-script-url', '/sdk-assets/vad.bundle.min.js');
    widget.setAttribute('onnx-runtime-script-url', '/sdk-assets/ort.wasm.min.js');
    widget.setAttribute('vad-base-asset-path', '/sdk-assets/vad/');
    widget.setAttribute('onnx-wasm-base-path', '/sdk-assets/onnx/');
    widget.setAttribute('vad-script-nonce', 'nonce-from-widget');
    mountWidget(widget);
    await flushMicrotasks();

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(expectSdkConfigAt(0).voice?.vadConfig).toEqual({
      vadScriptUrl: '/sdk-assets/vad.bundle.min.js',
      onnxRuntimeScriptUrl: '/sdk-assets/ort.wasm.min.js',
      baseAssetPath: '/sdk-assets/vad/',
      onnxWASMBasePath: '/sdk-assets/onnx/',
      scriptNonce: 'nonce-from-widget',
    });
  });

  test('widgets pass deployment-slug and user-context bootstrap fields through to AgentSDK', async () => {
    connectMock.mockResolvedValue(undefined);
    enableVoiceBrowserSupport();
    const widgets: Array<[string, HTMLElement, () => Promise<void>]> = [
      ['chat', new ChatWidget(), async () => (widgets[0][1] as ChatWidget).open()],
      ['unified', new UnifiedWidget(), async () => (widgets[1][1] as UnifiedWidget).open()],
      ['voice', new VoiceWidget(), async () => flushMicrotasks()],
    ];

    for (const [kind, widget, openWidget] of widgets) {
      configureWidgetAttributes(widget);
      if (kind === 'voice') {
        widget.setAttribute('voice-enabled', 'true');
      }
      widget.setAttribute('deployment-slug', 'customer-facing');
      widget.setAttribute(
        'user-context',
        JSON.stringify({
          userId: 'user-42',
          customAttributes: { tier: 'enterprise' },
        }),
      );
      mountWidget(widget);
      await openWidget();
    }

    expect(constructorConfigs).toHaveLength(3);
    for (let index = 0; index < constructorConfigs.length; index += 1) {
      const config = expectSdkConfigAt(index);
      expect(config.deploymentSlug).toBe('customer-facing');
      expect(config.userContext).toEqual({
        userId: 'user-42',
        customAttributes: { tier: 'enterprise' },
      });
    }
  });

  test('UnifiedWidget keeps voice mode available when pipeline voice is supported without RTCPeerConnection', async () => {
    connectMock.mockResolvedValue(undefined);
    vi.stubGlobal('AudioContext', class MockAudioContext {});
    vi.stubGlobal('RTCPeerConnection', undefined);
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn(),
      },
    });

    const widget = new UnifiedWidget();
    configureWidgetAttributes(widget);
    widget.setAttribute('mode', 'unified');
    widget.setAttribute('voice-enabled', 'true');
    mountWidget(widget);

    await widget.open();

    const modeToggle = widget.shadowRoot?.querySelector('.mode-toggle');
    const voiceButton = widget.shadowRoot?.querySelector('[data-mode="voice"]');
    expect(modeToggle).not.toBeNull();
    expect(voiceButton).not.toBeNull();
  });
});
