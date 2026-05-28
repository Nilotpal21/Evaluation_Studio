import { afterEach, describe, expect, test, vi } from 'vitest';
import { VADAdapter } from '../voice/VADAdapter.js';

type TestGlobal = typeof globalThis & {
  ort?: unknown;
  vad?: {
    MicVAD?: {
      new: (options: CapturedMicVADOptions) => Promise<FakeVADInstance>;
    };
  };
};

interface CapturedMicVADOptions {
  baseAssetPath: string;
  onnxWASMBasePath: string;
  onSpeechStart: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  onVADMisfire: () => void;
}

interface FakeVADInstance {
  start: () => void;
  pause: () => void;
  destroy: () => void;
}

const testGlobal = globalThis as TestGlobal;

async function flushMicrotasks(turns = 5): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  delete testGlobal.ort;
  delete testGlobal.vad;
  document
    .querySelectorAll('script[data-vad-adapter-test="true"]')
    .forEach((script) => script.remove());
  vi.restoreAllMocks();
});

describe('VADAdapter', () => {
  test('loads CSP-compatible browser bundles and wires speech callbacks', async () => {
    const loadedScripts: string[] = [];
    const loadedScriptNonces: string[] = [];
    const fakeVad = {
      start: vi.fn(),
      pause: vi.fn(),
      destroy: vi.fn(),
    };
    const createMicVAD = vi.fn(async (_options: CapturedMicVADOptions) => fakeVad);

    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      if (node instanceof HTMLScriptElement) {
        loadedScripts.push(node.src);
        loadedScriptNonces.push(node.nonce || node.getAttribute('nonce') || '');
        queueMicrotask(() => {
          if (node.src.includes('/ort.wasm.min.js')) {
            testGlobal.ort = {};
          }
          if (node.src.includes('/vad.bundle.min.js')) {
            testGlobal.vad = { MicVAD: { new: createMicVAD } };
          }
          node.dispatchEvent(new Event('load'));
        });
      }
      return node;
    });

    const adapter = new VADAdapter({
      onnxRuntimeScriptUrl: 'https://cdn.example.test/ort.wasm.min.js?case=success',
      vadScriptUrl: 'https://cdn.example.test/vad.bundle.min.js?case=success',
      scriptNonce: 'nonce-from-host',
    });
    const initializedEvents: boolean[] = [];
    const speechStarts: number[] = [];

    adapter.on('initialized', ({ available }) => initializedEvents.push(available));
    adapter.on('speechStart', () => speechStarts.push(1));

    await expect(adapter.initialize()).resolves.toBe(true);

    expect(loadedScripts).toEqual([
      'https://cdn.example.test/ort.wasm.min.js?case=success',
      'https://cdn.example.test/vad.bundle.min.js?case=success',
    ]);
    expect(loadedScriptNonces).toEqual(['nonce-from-host', 'nonce-from-host']);
    expect(initializedEvents).toEqual([true]);
    expect(createMicVAD).toHaveBeenCalledTimes(1);
    const options = createMicVAD.mock.calls[0]?.[0];
    expect(options).toBeDefined();
    if (!options) {
      throw new Error('MicVAD options were not captured');
    }
    expect(options.baseAssetPath).toBe('https://unpkg.com/@ricky0123/vad-web@0.0.30/dist/');
    expect(options.onnxWASMBasePath).toBe('https://unpkg.com/onnxruntime-web@1.24.1/dist/');

    options.onSpeechStart();
    expect(speechStarts).toEqual([1]);

    adapter.start();
    expect(fakeVad.start).toHaveBeenCalledTimes(1);
    expect(adapter.isRunning()).toBe(true);

    adapter.destroy();
    expect(fakeVad.pause).toHaveBeenCalledTimes(1);
    expect(fakeVad.destroy).toHaveBeenCalledTimes(1);
    expect(adapter.isAvailable()).toBe(false);
  });

  test('falls back cleanly when optional VAD scripts are blocked', async () => {
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      if (node instanceof HTMLScriptElement) {
        queueMicrotask(() => node.dispatchEvent(new Event('error')));
      }
      return node;
    });

    const adapter = new VADAdapter({
      onnxRuntimeScriptUrl: 'https://cdn.example.test/ort.wasm.min.js?case=blocked',
      vadScriptUrl: 'https://cdn.example.test/vad.bundle.min.js?case=blocked',
    });
    const initializedEvents: boolean[] = [];
    adapter.on('initialized', ({ available }) => initializedEvents.push(available));

    await expect(adapter.initialize()).resolves.toBe(false);

    expect(initializedEvents).toEqual([false]);
    expect(adapter.isAvailable()).toBe(false);
    expect(adapter.isRunning()).toBe(false);
  });

  test('rejects unsafe browser script URL protocols before appending scripts', async () => {
    const appendChild = vi.spyOn(document.head, 'appendChild');

    const adapter = new VADAdapter({
      onnxRuntimeScriptUrl: 'data:text/javascript,globalThis.ort={}',
      vadScriptUrl: 'https://cdn.example.test/vad.bundle.min.js?case=unsafe-url',
    });
    const initializedEvents: boolean[] = [];
    adapter.on('initialized', ({ available }) => initializedEvents.push(available));

    await expect(adapter.initialize()).resolves.toBe(false);

    expect(initializedEvents).toEqual([false]);
    expect(appendChild).not.toHaveBeenCalled();
  });

  test('rejects credentialed browser script URLs before appending scripts', async () => {
    const appendChild = vi.spyOn(document.head, 'appendChild');

    const adapter = new VADAdapter({
      onnxRuntimeScriptUrl: 'https://user:pass@cdn.example.test/ort.wasm.min.js',
      vadScriptUrl: 'https://cdn.example.test/vad.bundle.min.js?case=credentialed-url',
    });
    const initializedEvents: boolean[] = [];
    adapter.on('initialized', ({ available }) => initializedEvents.push(available));

    await expect(adapter.initialize()).resolves.toBe(false);

    expect(initializedEvents).toEqual([false]);
    expect(appendChild).not.toHaveBeenCalled();
  });

  test('copies the host script nonce when no explicit nonce is configured', async () => {
    const hostScript = document.createElement('script');
    hostScript.setAttribute('nonce', 'nonce-from-existing-script');
    hostScript.dataset.vadAdapterTest = 'true';
    document.head.appendChild(hostScript);

    const loadedScriptNonces: string[] = [];
    const fakeVad = {
      start: vi.fn(),
      pause: vi.fn(),
      destroy: vi.fn(),
    };
    const createMicVAD = vi.fn(async (_options: CapturedMicVADOptions) => fakeVad);

    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      if (node instanceof HTMLScriptElement) {
        loadedScriptNonces.push(node.nonce || node.getAttribute('nonce') || '');
        queueMicrotask(() => {
          if (node.src.includes('/ort.wasm.min.js')) {
            testGlobal.ort = {};
          }
          if (node.src.includes('/vad.bundle.min.js')) {
            testGlobal.vad = { MicVAD: { new: createMicVAD } };
          }
          node.dispatchEvent(new Event('load'));
        });
      }
      return node;
    });

    const adapter = new VADAdapter({
      onnxRuntimeScriptUrl: 'https://cdn.example.test/ort.wasm.min.js?case=nonce',
      vadScriptUrl: 'https://cdn.example.test/vad.bundle.min.js?case=nonce',
    });

    await expect(adapter.initialize()).resolves.toBe(true);
    expect(loadedScriptNonces).toEqual([
      'nonce-from-existing-script',
      'nonce-from-existing-script',
    ]);
  });

  test('deduplicates concurrent script loads only when URL and nonce both match', async () => {
    const appendedScripts: HTMLScriptElement[] = [];
    const fakeVad = {
      start: vi.fn(),
      pause: vi.fn(),
      destroy: vi.fn(),
    };
    const createMicVAD = vi.fn(async (_options: CapturedMicVADOptions) => fakeVad);

    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      if (node instanceof HTMLScriptElement) {
        appendedScripts.push(node);
      }
      return node;
    });

    const firstAdapter = new VADAdapter({
      onnxRuntimeScriptUrl: 'https://cdn.example.test/ort.wasm.min.js?case=concurrent',
      vadScriptUrl: 'https://cdn.example.test/vad.bundle.min.js?case=concurrent',
      scriptNonce: 'nonce-a',
    });
    const secondAdapter = new VADAdapter({
      onnxRuntimeScriptUrl: 'https://cdn.example.test/ort.wasm.min.js?case=concurrent',
      vadScriptUrl: 'https://cdn.example.test/vad.bundle.min.js?case=concurrent',
      scriptNonce: 'nonce-a',
    });
    const thirdAdapter = new VADAdapter({
      onnxRuntimeScriptUrl: 'https://cdn.example.test/ort.wasm.min.js?case=concurrent',
      vadScriptUrl: 'https://cdn.example.test/vad.bundle.min.js?case=concurrent',
      scriptNonce: 'nonce-b',
    });
    const fourthAdapter = new VADAdapter({
      onnxRuntimeScriptUrl: 'https://cdn.example.test/ort.wasm.min.js?case=concurrent',
      vadScriptUrl: 'https://cdn.example.test/vad.bundle.min.js?case=concurrent',
      scriptNonce: 'nonce-a',
    });

    const firstInitialize = firstAdapter.initialize();
    const secondInitialize = secondAdapter.initialize();
    const thirdInitialize = thirdAdapter.initialize();
    const fourthInitialize = fourthAdapter.initialize();
    await flushMicrotasks();

    expect(appendedScripts.map((script) => script.nonce)).toEqual(['nonce-a', 'nonce-b']);

    for (const script of appendedScripts) {
      if (script.nonce === 'nonce-a') {
        continue;
      }
      testGlobal.ort = {};
      script.dispatchEvent(new Event('load'));
    }
    await flushMicrotasks();
    expect(appendedScripts.map((script) => script.nonce)).toEqual([
      'nonce-a',
      'nonce-b',
      'nonce-b',
    ]);
    testGlobal.vad = { MicVAD: { new: createMicVAD } };
    appendedScripts[2]?.dispatchEvent(new Event('load'));

    await expect(thirdInitialize).resolves.toBe(true);

    testGlobal.ort = {};
    appendedScripts[0]?.dispatchEvent(new Event('load'));
    await flushMicrotasks();
    expect(appendedScripts.map((script) => script.nonce)).toEqual([
      'nonce-a',
      'nonce-b',
      'nonce-b',
    ]);

    await expect(firstInitialize).resolves.toBe(true);
    await expect(secondInitialize).resolves.toBe(true);
    await expect(fourthInitialize).resolves.toBe(true);
  });
});
