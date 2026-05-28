import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  SDK_USER_CONTEXT_KEY_MAX_CHARS,
  SDK_USER_CONTEXT_ARRAY_MAX_ITEMS,
  SDK_USER_CONTEXT_MAX_ATTRIBUTES,
  SDK_USER_CONTEXT_MAX_BYTES,
  SDK_USER_CONTEXT_STRING_MAX_CHARS,
  SDK_USER_CONTEXT_USER_ID_MAX_CHARS,
} from '../../../config/src/constants.ts';
import { TokenManager } from '../core/TokenManager.js';
import type { SDKPublicKeyConfig } from '../core/types.js';
import {
  SDK_USER_CONTEXT_ARRAY_MAX_ITEMS as SDK_ARRAY_LIMIT,
  SDK_USER_CONTEXT_KEY_MAX_CHARS as SDK_KEY_LIMIT,
  SDK_USER_CONTEXT_MAX_ATTRIBUTES as SDK_ATTRIBUTE_LIMIT,
  SDK_USER_CONTEXT_MAX_BYTES as SDK_BYTES_LIMIT,
  SDK_USER_CONTEXT_STRING_MAX_CHARS as SDK_STRING_LIMIT,
  SDK_USER_CONTEXT_USER_ID_MAX_CHARS as SDK_USER_ID_LIMIT,
} from '../core/sdk-user-context-validation.js';

function createConfig(userContext?: SDKPublicKeyConfig['userContext']): SDKPublicKeyConfig {
  return {
    projectId: 'project-1',
    apiKey: 'pk_test',
    endpoint: 'https://runtime.example.com',
    userContext,
  };
}

function createSdkSessionResponse(
  overrides: Partial<{
    token: string;
    expiresIn: number;
    tenantId: string;
    projectId: string;
    deploymentId?: string;
    channelId: string;
    permissions: string[];
    showActivityUpdates: boolean;
  }> = {},
): Response {
  return {
    ok: true,
    json: async () => ({
      token: 'sdk_token_1',
      expiresIn: 300,
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channelId: 'channel-1',
      permissions: ['session:send_message'],
      showActivityUpdates: false,
      ...overrides,
    }),
    text: async () => '',
  } as Response;
}

describe('TokenManager userContext customAttributes validation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('keeps browser-side SDK userContext limits aligned with the Runtime config contract', () => {
    expect(SDK_USER_ID_LIMIT).toBe(SDK_USER_CONTEXT_USER_ID_MAX_CHARS);
    expect(SDK_ATTRIBUTE_LIMIT).toBe(SDK_USER_CONTEXT_MAX_ATTRIBUTES);
    expect(SDK_KEY_LIMIT).toBe(SDK_USER_CONTEXT_KEY_MAX_CHARS);
    expect(SDK_STRING_LIMIT).toBe(SDK_USER_CONTEXT_STRING_MAX_CHARS);
    expect(SDK_ARRAY_LIMIT).toBe(SDK_USER_CONTEXT_ARRAY_MAX_ITEMS);
    expect(SDK_BYTES_LIMIT).toBe(SDK_USER_CONTEXT_MAX_BYTES);
  });

  test('accepts primitive and primitive-array customAttributes', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(createSdkSessionResponse());

    const manager = new TokenManager(
      createConfig({
        userId: 'user-1',
        customAttributes: {
          plan: 'pro',
          seats: 10,
          hasEntitlement: true,
          tags: ['support', 'on-call'],
          numericFlags: [1, 2, 3],
          nullableValues: [null, 'active'],
        },
      }),
    );

    await manager.getToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://runtime.example.com/api/v1/sdk/init');
    const parsedBody = JSON.parse(String(request.body)) as {
      userContext: SDKPublicKeyConfig['userContext'];
    };
    expect(parsedBody.userContext?.customAttributes?.plan).toBe('pro');
    expect(parsedBody.userContext?.customAttributes?.numericFlags).toEqual([1, 2, 3]);
  });

  test('rejects nested object customAttributes values before network call', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(createSdkSessionResponse());

    const manager = new TokenManager(
      createConfig({
        customAttributes: {
          nested: { disallowed: true } as unknown as string,
        },
      }),
    );

    await expect(manager.getToken()).rejects.toThrow(
      'Invalid userContext.customAttributes.nested: expected a primitive value or primitive array.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects arrays that contain non-primitive values', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(createSdkSessionResponse());

    const manager = new TokenManager(
      createConfig({
        customAttributes: {
          invalidList: ['ok', { disallowed: true }] as unknown as string[],
        },
      }),
    );

    await expect(manager.getToken()).rejects.toThrow(
      'Invalid userContext.customAttributes.invalidList: arrays must contain only primitive values.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects overlong user ids before network call', async () => {
    const fetchMock = vi.mocked(fetch);

    const manager = new TokenManager(
      createConfig({
        userId: 'u'.repeat(SDK_USER_CONTEXT_USER_ID_MAX_CHARS + 1),
      }),
    );

    await expect(manager.getToken()).rejects.toThrow(
      `Invalid userContext.userId: must be ${String(SDK_USER_CONTEXT_USER_ID_MAX_CHARS)} characters or fewer.`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects customAttributes that exceed the shared size limits', async () => {
    const fetchMock = vi.mocked(fetch);
    const tooManyAttributes = Object.fromEntries(
      Array.from({ length: SDK_USER_CONTEXT_MAX_ATTRIBUTES + 1 }, (_, index) => [
        `key-${String(index)}`,
        'x',
      ]),
    );

    const manager = new TokenManager(
      createConfig({
        customAttributes: tooManyAttributes,
      }),
    );

    await expect(manager.getToken()).rejects.toThrow(
      `Invalid userContext.customAttributes: at most ${String(SDK_USER_CONTEXT_MAX_ATTRIBUTES)} entries are allowed.`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects oversized serialized userContext payloads', async () => {
    const fetchMock = vi.mocked(fetch);
    const oversizedAttributes = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `key-${String(index)}`,
        'x'.repeat(Math.min(400, SDK_USER_CONTEXT_STRING_MAX_CHARS)),
      ]),
    );
    const serializedLength = new TextEncoder().encode(
      JSON.stringify({ customAttributes: oversizedAttributes }),
    ).length;

    expect(serializedLength).toBeGreaterThan(SDK_USER_CONTEXT_MAX_BYTES);

    const manager = new TokenManager(
      createConfig({
        customAttributes: oversizedAttributes,
      }),
    );

    await expect(manager.getToken()).rejects.toThrow(
      `Invalid userContext: serialized payload must be ${String(SDK_USER_CONTEXT_MAX_BYTES)} bytes or fewer.`,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
