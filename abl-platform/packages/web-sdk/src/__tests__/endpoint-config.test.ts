import { describe, expect, test } from 'vitest';
import { AgentSDK } from '../core/AgentSDK.js';
import type { SDKConfig } from '../core/types.js';
import { normalizeHttpEndpoint, normalizeWebSocketEndpoint } from '../core/endpoint.js';

describe('browser SDK endpoint contract', () => {
  test('fails closed when projectId is missing', () => {
    const invalidConfig = {
      apiKey: 'pk_test',
      endpoint: 'https://runtime.example.com',
    } as unknown as SDKConfig;

    expect(() => {
      new AgentSDK(invalidConfig);
    }).toThrow('SDK config projectId is required.');
  });

  test('fails closed when apiKey is missing', () => {
    const invalidConfig = {
      projectId: 'project-1',
      endpoint: 'https://runtime.example.com',
    } as unknown as SDKConfig;

    expect(() => {
      new AgentSDK(invalidConfig);
    }).toThrow(
      'SDK config must provide exactly one bootstrap credential: apiKey or bootstrapToken.',
    );
  });

  test('fails closed when both bootstrap credentials are provided', () => {
    const invalidConfig = {
      projectId: 'project-1',
      endpoint: 'https://runtime.example.com',
      apiKey: 'pk_test',
      bootstrapToken: 'bootstrap_token',
    } as unknown as SDKConfig;

    expect(() => {
      new AgentSDK(invalidConfig);
    }).toThrow(
      'SDK config must provide exactly one bootstrap credential: apiKey or bootstrapToken.',
    );
  });

  test('fails closed when endpoint is missing', () => {
    const invalidConfig = {
      projectId: 'project-1',
      apiKey: 'pk_test',
    } as unknown as SDKConfig;

    expect(() => {
      new AgentSDK(invalidConfig);
    }).toThrow('SDK config endpoint is required');
  });

  test('fails closed when endpoint protocol is invalid', () => {
    expect(() => normalizeHttpEndpoint('runtime.internal')).toThrow(
      'SDK config endpoint must start with http://, https://, ws://, or wss://.',
    );
  });

  test('normalizes http and websocket endpoints without fallback defaults', () => {
    expect(normalizeHttpEndpoint('https://runtime.example.com/')).toBe(
      'https://runtime.example.com',
    );
    expect(normalizeHttpEndpoint('wss://runtime.example.com')).toBe('https://runtime.example.com');
    expect(normalizeWebSocketEndpoint('https://runtime.example.com')).toBe(
      'wss://runtime.example.com',
    );
  });

  test('passes CSP-safe VAD asset overrides through to the voice client', () => {
    const sdk = new AgentSDK({
      projectId: 'project-1',
      apiKey: 'pk_test',
      endpoint: 'https://runtime.example.com',
      voice: {
        vadConfig: {
          vadScriptUrl: '/sdk-assets/vad.bundle.min.js',
          onnxRuntimeScriptUrl: '/sdk-assets/ort.wasm.min.js',
          baseAssetPath: '/sdk-assets/vad/',
          onnxWASMBasePath: '/sdk-assets/onnx/',
          scriptNonce: 'nonce-from-config',
        },
      },
    });

    const voiceClient = sdk.voice() as unknown as {
      options: {
        vadConfig?: {
          vadScriptUrl?: string;
          onnxRuntimeScriptUrl?: string;
          baseAssetPath?: string;
          onnxWASMBasePath?: string;
          scriptNonce?: string;
        };
      };
    };

    expect(voiceClient.options.vadConfig).toEqual({
      vadScriptUrl: '/sdk-assets/vad.bundle.min.js',
      onnxRuntimeScriptUrl: '/sdk-assets/ort.wasm.min.js',
      baseAssetPath: '/sdk-assets/vad/',
      onnxWASMBasePath: '/sdk-assets/onnx/',
      scriptNonce: 'nonce-from-config',
    });
  });
});
