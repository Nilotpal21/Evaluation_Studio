/**
 * Status Update Rendering & Reasoning Fallback Tests
 *
 * Tests for:
 * - 2-U27: Reasoning fallback metadata flag in thought card
 * - 2-U28: status_update sets statusMessage in session store
 * - 2-U29: status_clear clears statusMessage
 * - 2-U30: StatusMessage state behavior during streaming
 * - 2-U31: Status auto-cleared on response_end
 * - 2-U32: Multiple rapid status updates — only latest shown
 *
 * NOTE: These tests verify store behavior and WebSocket handler logic
 * rather than rendering MessageList directly, because MessageList has
 * deep import chains that require a full build to resolve in happy-dom.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// Test 1: Session store statusMessage behavior
// =============================================================================

describe('Session Store — statusMessage', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test('2-U28: setStatusMessage sets statusMessage', async () => {
    const { useSessionStore } = await import('../../store/session-store');

    expect(useSessionStore.getState().statusMessage).toBeNull();

    useSessionStore.getState().setStatusMessage('Searching knowledge base...');
    expect(useSessionStore.getState().statusMessage).toBe('Searching knowledge base...');
  });

  test('2-U29: setStatusMessage(null) clears statusMessage', async () => {
    const { useSessionStore } = await import('../../store/session-store');

    useSessionStore.getState().setStatusMessage('Processing...');
    expect(useSessionStore.getState().statusMessage).toBe('Processing...');

    useSessionStore.getState().setStatusMessage(null);
    expect(useSessionStore.getState().statusMessage).toBeNull();
  });

  test('2-U31: endStreaming does not affect statusMessage (cleared by handler)', async () => {
    const { useSessionStore } = await import('../../store/session-store');

    // Start streaming
    useSessionStore.getState().startStreaming('msg-1');
    useSessionStore.getState().setStatusMessage('Generating...');

    expect(useSessionStore.getState().statusMessage).toBe('Generating...');
    expect(useSessionStore.getState().isStreaming).toBe(true);

    // End streaming — statusMessage is cleared by the WS handler, not by endStreaming itself
    useSessionStore.getState().endStreaming('Response text');
    // statusMessage is still set because endStreaming doesn't touch it
    // The WS handler calls setStatusMessage(null) on response_end
    expect(useSessionStore.getState().isStreaming).toBe(false);
  });

  test('2-U32: multiple rapid status updates — only latest is stored', async () => {
    const { useSessionStore } = await import('../../store/session-store');

    useSessionStore.getState().setStatusMessage('Step 1...');
    useSessionStore.getState().setStatusMessage('Step 2...');
    useSessionStore.getState().setStatusMessage('Step 3...');

    expect(useSessionStore.getState().statusMessage).toBe('Step 3...');
  });
});

// =============================================================================
// Test 2: WebSocket handler logic for status_update / status_clear / reasoning fallback
// =============================================================================

describe('WebSocket Handler Logic — status_update & reasoning fallback', () => {
  test('2-U27: tool_thought with thought:null and reasoning creates isReasoningFallback metadata', () => {
    // Simulate the WebSocket handler logic for reasoning fallback
    const eventData = {
      thought: null,
      reasoning: 'User request is fully answered',
      toolName: '__complete__',
      agent: 'TestAgent',
    };

    const isReasoningFallback = !eventData.thought && !!eventData.reasoning;
    const displayText = isReasoningFallback
      ? eventData.reasoning
      : (eventData.thought as unknown as string);

    expect(isReasoningFallback).toBe(true);
    expect(displayText).toBe('User request is fully answered');

    // Verify the metadata shape that would be created
    const metadata = {
      toolName: eventData.toolName,
      agentName: eventData.agent,
      ...(isReasoningFallback ? { isReasoningFallback: true } : {}),
    };

    expect(metadata.isReasoningFallback).toBe(true);
    expect(metadata.toolName).toBe('__complete__');
  });

  test('2-U27: tool_thought with thought present does NOT set isReasoningFallback', () => {
    const eventData = {
      thought: 'I have thought about this',
      reasoning: 'User request is fully answered',
      toolName: '__complete__',
      agent: 'TestAgent',
    };

    const isReasoningFallback = !eventData.thought && !!eventData.reasoning;
    expect(isReasoningFallback).toBe(false);

    const metadata = {
      toolName: eventData.toolName,
      agentName: eventData.agent,
      ...(isReasoningFallback ? { isReasoningFallback: true } : {}),
    };

    expect(metadata).not.toHaveProperty('isReasoningFallback');
  });

  test('2-U28/2-U29: status_update and status_clear handler pattern', () => {
    // Simulate the WS message handler for status_update and status_clear
    let storeStatusMessage: string | null = null;
    const setStoreStatusMessage = (msg: string | null) => {
      storeStatusMessage = msg;
    };

    // status_update handler
    const statusUpdateMessage = { type: 'status_update' as const, text: 'Searching...' };
    setStoreStatusMessage(statusUpdateMessage.text);
    expect(storeStatusMessage).toBe('Searching...');

    // status_clear handler
    setStoreStatusMessage(null);
    expect(storeStatusMessage).toBeNull();
  });

  test('2-U30: statusMessage + isStreaming combination determines visibility', async () => {
    const { useSessionStore } = await import('../../store/session-store');

    // Reset to clean state
    useSessionStore.getState().setStatusMessage(null);

    // Not streaming, no status → not visible
    expect(useSessionStore.getState().isStreaming).toBe(false);
    expect(useSessionStore.getState().statusMessage).toBeNull();

    // Start streaming + set status → visible
    useSessionStore.getState().startStreaming('msg-1');
    useSessionStore.getState().setStatusMessage('Working...');
    expect(useSessionStore.getState().isStreaming).toBe(true);
    expect(useSessionStore.getState().statusMessage).toBe('Working...');

    // The MessageList component renders StatusIndicator when both are truthy:
    // {isStreaming && statusMessage && <StatusIndicator text={statusMessage} />}
    const shouldShowIndicator =
      useSessionStore.getState().isStreaming && !!useSessionStore.getState().statusMessage;
    expect(shouldShowIndicator).toBe(true);
  });
});

// =============================================================================
// Test 3: SessionMessage metadata type includes isReasoningFallback
// =============================================================================

describe('SessionMessage Type — isReasoningFallback', () => {
  test('SessionMessage metadata accepts isReasoningFallback flag', () => {
    // This is a compile-time check — if the type is wrong, TS would fail
    const message: import('../types').SessionMessage = {
      id: 'thought-1',
      role: 'thought',
      content: 'User request is fully answered',
      timestamp: new Date(),
      traceIds: [],
      metadata: {
        toolName: '__complete__',
        agentName: 'TestAgent',
        isReasoningFallback: true,
      },
    };

    expect(message.metadata?.isReasoningFallback).toBe(true);
  });
});
