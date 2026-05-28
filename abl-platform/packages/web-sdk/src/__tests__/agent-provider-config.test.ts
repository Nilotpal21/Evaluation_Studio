import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { SDKPublicKeyConfig } from '../core/types.js';

const connectMock = vi.fn(async () => undefined);
const disconnectMock = vi.fn();
const onMock = vi.fn(() => () => {});
const constructorConfigs: unknown[] = [];

vi.mock('../core/AgentSDK.js', () => {
  class AgentSDK {
    constructor(config: unknown) {
      constructorConfigs.push(config);
    }

    on = onMock;
    connect = connectMock;
    disconnect = disconnectMock;
    chat = vi.fn();
    voice = vi.fn();
  }

  return { AgentSDK };
});

import { AgentProvider } from '../react/AgentProvider.js';

function createConfig(overrides: Partial<SDKPublicKeyConfig> = {}): SDKPublicKeyConfig {
  return {
    projectId: 'project-1',
    apiKey: 'pk_test',
    endpoint: 'https://runtime.example.com',
    ...overrides,
  };
}

async function renderProvider(root: Root, props: SDKPublicKeyConfig): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(AgentProvider, {
        ...props,
        children: React.createElement('div', { 'data-testid': 'child' }),
      }),
    );
    await Promise.resolve();
  });
}

describe('AgentProvider config lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    connectMock.mockReset();
    connectMock.mockResolvedValue(undefined);
    disconnectMock.mockReset();
    onMock.mockReset();
    onMock.mockReturnValue(() => {});
    constructorConfigs.length = 0;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    vi.restoreAllMocks();
  });

  test('recreates the SDK when userContext changes', async () => {
    await renderProvider(
      root,
      createConfig({
        userContext: {
          userId: 'anonymous-1',
        },
      }),
    );

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(constructorConfigs).toHaveLength(1);

    await renderProvider(
      root,
      createConfig({
        userContext: {
          userId: 'anonymous-2',
        },
      }),
    );

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(constructorConfigs).toHaveLength(2);
    expect(
      (constructorConfigs[1] as { userContext?: { userId?: string } }).userContext?.userId,
    ).toBe('anonymous-2');
  });

  test('recreates the SDK when channel-shaping config changes', async () => {
    await renderProvider(
      root,
      createConfig({
        channelName: 'default',
      }),
    );

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(constructorConfigs).toHaveLength(1);

    await renderProvider(
      root,
      createConfig({
        channelName: 'voice-preview',
      }),
    );

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(constructorConfigs).toHaveLength(2);
    expect((constructorConfigs[1] as { channelName?: string }).channelName).toBe('voice-preview');
  });

  test('recreates the SDK when channelId changes', async () => {
    await renderProvider(
      root,
      createConfig({
        channelId: 'channel-a',
      }),
    );

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(constructorConfigs).toHaveLength(1);

    await renderProvider(
      root,
      createConfig({
        channelId: 'channel-b',
      }),
    );

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(constructorConfigs).toHaveLength(2);
    expect((constructorConfigs[1] as { channelId?: string }).channelId).toBe('channel-b');
  });

  test('recreates the SDK when voice asset config changes', async () => {
    await renderProvider(
      root,
      createConfig({
        voice: {
          vadConfig: {
            vadScriptUrl: '/sdk-assets/vad-v1.bundle.min.js',
            onnxRuntimeScriptUrl: '/sdk-assets/ort.wasm.min.js',
            scriptNonce: 'nonce-v1',
          },
        },
      }),
    );

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(constructorConfigs).toHaveLength(1);

    await renderProvider(
      root,
      createConfig({
        voice: {
          vadConfig: {
            vadScriptUrl: '/sdk-assets/vad-v2.bundle.min.js',
            onnxRuntimeScriptUrl: '/sdk-assets/ort.wasm.min.js',
            scriptNonce: 'nonce-v2',
          },
        },
      }),
    );

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(constructorConfigs).toHaveLength(2);
    expect(
      (
        constructorConfigs[1] as {
          voice?: {
            vadConfig?: {
              vadScriptUrl?: string;
              onnxRuntimeScriptUrl?: string;
              scriptNonce?: string;
            };
          };
        }
      ).voice?.vadConfig,
    ).toEqual({
      vadScriptUrl: '/sdk-assets/vad-v2.bundle.min.js',
      onnxRuntimeScriptUrl: '/sdk-assets/ort.wasm.min.js',
      scriptNonce: 'nonce-v2',
    });
  });

  test('passes idle disconnect settings through to AgentSDK', async () => {
    await renderProvider(
      root,
      createConfig({
        idleDisconnect: {
          timeoutMs: 900_000,
          behavior: 'end_session',
        },
      }),
    );

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(constructorConfigs).toHaveLength(1);
    expect(
      (
        constructorConfigs[0] as {
          idleDisconnect?: { timeoutMs?: number; behavior?: string };
        }
      ).idleDisconnect,
    ).toEqual({
      timeoutMs: 900_000,
      behavior: 'end_session',
    });
  });
});
