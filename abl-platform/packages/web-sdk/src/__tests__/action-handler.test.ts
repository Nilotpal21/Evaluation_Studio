/**
 * Action Handler Tests
 *
 * Tests for createActionHandler — verifies it delegates to
 * ChatClient.submitAction and handles null client gracefully.
 */

import { describe, test, expect, vi } from 'vitest';
import { createActionHandler } from '../ui/action-handler.js';

describe('createActionHandler', () => {
  test('calls submitAction on the chat client', () => {
    const mockChat = { submitAction: vi.fn() };
    const handler = createActionHandler(mockChat as any);

    handler('btn_1', 'clicked');

    expect(mockChat.submitAction).toHaveBeenCalledWith('btn_1', 'clicked');
  });

  test('calls submitAction without value', () => {
    const mockChat = { submitAction: vi.fn() };
    const handler = createActionHandler(mockChat as any);

    handler('btn_1');

    expect(mockChat.submitAction).toHaveBeenCalledWith('btn_1', undefined);
  });

  test('does nothing when chat client is null', () => {
    const handler = createActionHandler(null);
    // Should not throw
    expect(() => handler('btn_1', 'val')).not.toThrow();
  });
});
