/**
 * Tests for JIT Auth WebSocket Protocol (Phase 5 — Tasks 5.1-5.3)
 *
 * Verifies:
 * - auth_challenge server→client message serialization
 * - auth_response client→server message parsing
 * - Message type registration in handlers
 */

import { describe, it, expect } from 'vitest';
import { parseClientMessage, serializeServerMessage, ServerMessages } from '../websocket/events.js';

describe('JIT Auth WebSocket Protocol', () => {
  describe('auth_challenge server→client message (Task 5.1)', () => {
    it('creates a correctly structured auth_challenge message', () => {
      const message = ServerMessages.authChallenge('session-1', {
        toolCallId: 'tc_123',
        authType: 'oauth2',
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?...',
        profileId: 'google-oauth',
        profileName: 'google-oauth',
        prompt: 'This tool requires Google authorization',
        timeoutMs: 600000,
      });

      expect(message).toEqual({
        type: 'auth_challenge',
        sessionId: 'session-1',
        code: 'AUTH_JIT_REQUIRED',
        toolCallId: 'tc_123',
        authType: 'oauth2',
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?...',
        profileId: 'google-oauth',
        profileName: 'google-oauth',
        prompt: 'This tool requires Google authorization',
        timeoutMs: 600000,
      });
    });

    it('serializes auth_challenge to valid JSON', () => {
      const message = ServerMessages.authChallenge('session-1', {
        toolCallId: 'tc_456',
        authType: 'oauth2',
        profileId: 'slack-oauth',
        profileName: 'slack-oauth',
        prompt: 'Authorize Slack',
        timeoutMs: 300000,
      });

      const serialized = serializeServerMessage(message);
      const parsed = JSON.parse(serialized);

      expect(parsed.type).toBe('auth_challenge');
      expect(parsed.sessionId).toBe('session-1');
      expect(parsed.code).toBe('AUTH_JIT_REQUIRED');
      expect(parsed.toolCallId).toBe('tc_456');
      expect(parsed.authUrl).toBeUndefined();
    });

    it('auth_challenge with optional authUrl omitted', () => {
      const message = ServerMessages.authChallenge('session-1', {
        toolCallId: 'tc_789',
        authType: 'oauth2',
        profileId: 'my-profile',
        profileName: 'my-profile',
        prompt: 'Auth required',
        timeoutMs: 60000,
      });

      expect(message.type).toBe('auth_challenge');
      expect(message.code).toBe('AUTH_JIT_REQUIRED');
      expect('authUrl' in message).toBe(false);
    });
  });

  describe('auth_response client→server message (Task 5.2)', () => {
    it('parses valid auth_response with completed status', () => {
      const message = parseClientMessage(
        JSON.stringify({
          type: 'auth_response',
          toolCallId: 'tc_123',
          status: 'completed',
        }),
      );

      expect(message).toEqual({
        type: 'auth_response',
        toolCallId: 'tc_123',
        status: 'completed',
      });
    });

    it('parses valid auth_response with cancelled status', () => {
      const message = parseClientMessage(
        JSON.stringify({
          type: 'auth_response',
          toolCallId: 'tc_456',
          status: 'cancelled',
        }),
      );

      expect(message).toEqual({
        type: 'auth_response',
        toolCallId: 'tc_456',
        status: 'cancelled',
      });
    });

    it('rejects auth_response with missing toolCallId', () => {
      const message = parseClientMessage(
        JSON.stringify({
          type: 'auth_response',
          status: 'completed',
        }),
      );

      expect(message).toBeNull();
    });

    it('rejects auth_response with invalid status', () => {
      const message = parseClientMessage(
        JSON.stringify({
          type: 'auth_response',
          toolCallId: 'tc_123',
          status: 'invalid',
        }),
      );

      expect(message).toBeNull();
    });

    it('rejects auth_response with missing status', () => {
      const message = parseClientMessage(
        JSON.stringify({
          type: 'auth_response',
          toolCallId: 'tc_123',
        }),
      );

      expect(message).toBeNull();
    });
  });

  describe('Message type registration (Task 5.3)', () => {
    it('unknown message type is ignored (returns null)', () => {
      const message = parseClientMessage(
        JSON.stringify({
          type: 'unknown_type_xyz',
          data: 'some data',
        }),
      );

      expect(message).toBeNull();
    });

    it('auth_response is a recognized client message type', () => {
      const message = parseClientMessage(
        JSON.stringify({
          type: 'auth_response',
          toolCallId: 'tc_test',
          status: 'completed',
        }),
      );

      expect(message).not.toBeNull();
      expect(message!.type).toBe('auth_response');
    });
  });
});
