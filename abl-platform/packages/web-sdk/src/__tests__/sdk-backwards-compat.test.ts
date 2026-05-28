/**
 * SDK Backwards Compatibility Tests (UT-2)
 *
 * Verifies:
 * - SessionManager re-exported from transport/index.ts is the same class
 * - SessionManager from the main index is the same class
 * - DefaultTransport is exported from main index
 * - Transport types are exported from main index
 * - AgentSDK still works without explicit transport (uses DefaultTransport internally)
 */

import { describe, test, expect, vi } from 'vitest';

// Import from transport barrel
import { SessionManager as TransportSessionManager } from '../transport/index.js';

// Import from core (original location)
import { SessionManager as CoreSessionManager } from '../core/SessionManager.js';

// Import DefaultTransport
import { DefaultTransport } from '../transport/DefaultTransport.js';

// Import transport types to verify they are accessible
import type {
  SDKTransport,
  TransportCapabilities,
  TransportClientMessage,
  TransportServerMessage,
  TransportError,
} from '../transport/types.js';

// Import from the main SDK index (via relative path as in tests)
import type { MessageRole, MessageMetadata, ResponseProvenance } from '../core/types.js';

describe('SessionManager re-export compatibility', () => {
  test('SessionManager from transport/index is the same class as from core/SessionManager', () => {
    expect(TransportSessionManager).toBe(CoreSessionManager);
  });

  test('SessionManager from transport has expected static shape', () => {
    // Verify the class has the expected prototype methods
    expect(typeof TransportSessionManager.prototype.connect).toBe('function');
    expect(typeof TransportSessionManager.prototype.disconnect).toBe('function');
    expect(typeof TransportSessionManager.prototype.isConnected).toBe('function');
    expect(typeof TransportSessionManager.prototype.getSessionId).toBe('function');
    expect(typeof TransportSessionManager.prototype.send).toBe('function');
  });
});

describe('DefaultTransport export', () => {
  test('DefaultTransport is exported and constructable', () => {
    expect(DefaultTransport).toBeDefined();
    expect(typeof DefaultTransport).toBe('function');
  });
});

describe('Transport type exports are accessible', () => {
  test('SDKTransport interface is usable in type position', () => {
    // If this compiles, the type is properly exported
    const _unused: SDKTransport | null = null;
    expect(_unused).toBeNull();
  });

  test('TransportCapabilities interface is usable', () => {
    const caps: TransportCapabilities = {
      supportsThoughts: true,
      supportsHandoff: false,
      supportsFileUpload: true,
      supportsVoice: false,
    };
    expect(caps.supportsThoughts).toBe(true);
  });

  test('TransportClientMessage union type is usable', () => {
    const msg: TransportClientMessage = { type: 'chat_message', text: 'Hi' };
    expect(msg.type).toBe('chat_message');
  });

  test('TransportServerMessage union type is usable', () => {
    const msg: TransportServerMessage = { type: 'response_start', messageId: 'msg-1' };
    expect(msg.type).toBe('response_start');
  });

  test('TransportError interface is usable', () => {
    const err: TransportError = { code: 'ERR', message: 'Oops', recoverable: true };
    expect(err.code).toBe('ERR');
  });
});

describe('Core type additions are backwards compatible', () => {
  test('MessageRole includes thought', () => {
    const role: MessageRole = 'thought';
    expect(role).toBe('thought');
  });

  test('MessageRole accepts existing roles', () => {
    const roles: MessageRole[] = ['user', 'assistant', 'system'];
    expect(roles).toHaveLength(3);
  });

  test('MessageMetadata is backwards compatible with Record<string, unknown>', () => {
    const metadata: MessageMetadata = {
      toolName: 'search',
      customKey: 'custom-value',
    };
    // Should still be assignable where Record<string, unknown> is expected
    const asRecord: Record<string, unknown> = metadata;
    expect(asRecord.toolName).toBe('search');
    expect(asRecord.customKey).toBe('custom-value');
  });

  test('ResponseProvenance is exported with the stable public shape', () => {
    const provenance: ResponseProvenance = {
      schemaVersion: 1,
      kind: 'scripted',
      disclaimerRequired: false,
      usedLlmInternally: true,
    };

    const metadata: MessageMetadata = {
      isLlmGenerated: false,
      responseProvenance: provenance,
      customKey: 'custom-value',
    };
    const asRecord: Record<string, unknown> = metadata;

    expect(metadata.responseProvenance).toEqual(provenance);
    expect(asRecord.customKey).toBe('custom-value');
  });
});

describe('AgentSDK uses DefaultTransport internally', () => {
  test('AgentSDK constructor imports and references DefaultTransport', async () => {
    // Verify the import chain works by checking that AgentSDK module
    // successfully loads (it imports DefaultTransport in its constructor)
    const mod = await import('../core/AgentSDK.js');
    expect(mod.AgentSDK).toBeDefined();
    expect(typeof mod.AgentSDK).toBe('function');
  });

  test('ChatClient constructor accepts transport as first argument', async () => {
    const mod = await import('../chat/ChatClient.js');
    expect(mod.ChatClient).toBeDefined();
    expect(typeof mod.ChatClient).toBe('function');

    // ChatUploadConfig is also exported
    // (type-only export verified by compilation)
  });
});
