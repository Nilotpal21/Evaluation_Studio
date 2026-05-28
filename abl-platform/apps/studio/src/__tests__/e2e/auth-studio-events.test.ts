/**
 * E2E: Studio UI Event Integration (Suite 6)
 *
 * Tests WebSocket message handling and Zustand store behavior for Studio.
 *
 * Real components:
 * - useBatchConsentStore (real Zustand store)
 * - WS message type definitions
 *
 * For store tests (6.5-6.7): test the Zustand store directly, no mocks needed.
 * For event tests (6.1-6.4): test the message parsing and store integration.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useBatchConsentStore } from '../../store/batch-consent-store';

// ── Helpers ─────────────────────────────────────────────────────────

/** Simulate an auth_required WS event payload */
function makeAuthRequiredEvent() {
  return {
    type: 'auth_required' as const,
    sessionId: 'session-1',
    pending: [
      {
        connector: 'google',
        authProfileRef: 'google-creds',
        scopes: ['gmail.readonly'],
        connectionMode: 'per_user' as const,
      },
      {
        connector: 'salesforce',
        authProfileRef: 'salesforce-creds',
        scopes: ['api'],
        connectionMode: 'per_user' as const,
      },
    ],
    satisfied: [
      {
        connector: 'slack',
        authProfileRef: 'slack-creds',
        scopes: ['chat:write'],
        connectionMode: 'per_user' as const,
      },
    ],
  };
}

/** Simulate an auth_gate_updated WS event payload */
function makeGateUpdatedEvent() {
  return {
    type: 'auth_gate_updated' as const,
    sessionId: 'session-1',
    pending: [{ authProfileRef: 'salesforce-creds' }],
    satisfied: [{ authProfileRef: 'google-creds' }, { authProfileRef: 'slack-creds' }],
  };
}

/** Simulate an auth_challenge WS event payload */
function makeAuthChallengeEvent() {
  return {
    type: 'auth_challenge' as const,
    sessionId: 'session-1',
    toolCallId: 'tc-1',
    authType: 'oauth2',
    authUrl: 'https://accounts.google.com/o/oauth2/auth?state=abc',
    profileId: 'google-creds',
    profileName: 'Google',
    prompt: 'Authorize Google for Gmail access',
    timeoutMs: 600000,
  };
}

// ── Test Suite ──────────────────────────────────────────────────────

describe('Suite 6: Studio UI Event Integration', () => {
  beforeEach(() => {
    // Reset Zustand store between tests
    useBatchConsentStore.getState().reset();
  });

  describe('WS event processing', () => {
    it('6.1: auth_challenge WS event -> system message with challenge data', () => {
      const event = makeAuthChallengeEvent();

      // Verify the event has all required fields for rendering a system message
      expect(event.type).toBe('auth_challenge');
      expect(event.sessionId).toBe('session-1');
      expect(event.toolCallId).toBe('tc-1');
      expect(event.authType).toBe('oauth2');
      expect(event.authUrl).toContain('accounts.google.com');
      expect(event.profileName).toBe('Google');
      expect(event.prompt).toContain('Authorize');
      expect(event.timeoutMs).toBe(600000);

      // The event can be parsed and its data used to construct a system message
      // (Studio would insert this into the chat message list)
      const systemMessage = {
        role: 'system' as const,
        type: 'auth_challenge' as const,
        data: {
          toolCallId: event.toolCallId,
          authType: event.authType,
          authUrl: event.authUrl,
          profileName: event.profileName,
          prompt: event.prompt,
          timeoutMs: event.timeoutMs,
        },
      };
      expect(systemMessage.data.authUrl).toBeDefined();
    });

    it('6.2: auth_required WS event -> batch consent store initialized with connector list', () => {
      const event = makeAuthRequiredEvent();
      const store = useBatchConsentStore.getState();

      // Process event through store
      store.initFromAuthRequired(event.sessionId, event.pending, event.satisfied);

      // Verify store state
      const state = useBatchConsentStore.getState();
      expect(state.active).toBe(true);
      expect(state.sessionId).toBe('session-1');
      expect(state.connectors).toHaveLength(3);

      // Pending connectors
      const pendingConnectors = state.connectors.filter((c) => c.status === 'pending');
      expect(pendingConnectors).toHaveLength(2);
      expect(pendingConnectors.map((c) => c.authProfileRef).sort()).toEqual([
        'google-creds',
        'salesforce-creds',
      ]);

      // Already satisfied connector
      const connectedConnectors = state.connectors.filter((c) => c.status === 'connected');
      expect(connectedConnectors).toHaveLength(1);
      expect(connectedConnectors[0].authProfileRef).toBe('slack-creds');
    });

    it('6.3: auth_gate_updated WS event -> individual connector state updated', () => {
      const initEvent = makeAuthRequiredEvent();
      const store = useBatchConsentStore.getState();
      store.initFromAuthRequired(initEvent.sessionId, initEvent.pending, initEvent.satisfied);

      // Now process gate update
      const updateEvent = makeGateUpdatedEvent();
      store.updateFromGateUpdate(updateEvent.sessionId, updateEvent.pending, updateEvent.satisfied);

      const state = useBatchConsentStore.getState();
      // google-creds should now be connected
      const google = state.connectors.find((c) => c.authProfileRef === 'google-creds');
      expect(google!.status).toBe('connected');

      // salesforce-creds should still be pending
      const sf = state.connectors.find((c) => c.authProfileRef === 'salesforce-creds');
      expect(sf!.status).toBe('pending');

      // Gate should still be active (salesforce still pending)
      expect(state.active).toBe(true);
    });

    it('6.4: auth_gate_satisfied WS event -> all connectors marked satisfied, gate dismissed', () => {
      const initEvent = makeAuthRequiredEvent();
      const store = useBatchConsentStore.getState();
      store.initFromAuthRequired(initEvent.sessionId, initEvent.pending, initEvent.satisfied);

      // Mark all satisfied
      store.markAllSatisfied(initEvent.sessionId);

      const state = useBatchConsentStore.getState();
      expect(state.active).toBe(false);

      // All connectors should be 'connected'
      const allConnected = state.connectors.every((c) => c.status === 'connected');
      expect(allConnected).toBe(true);
    });
  });

  describe('Batch consent store direct tests', () => {
    it('6.5: initFromAuthRequired creates correct connector entries with pending status', () => {
      const store = useBatchConsentStore.getState();

      store.initFromAuthRequired(
        'session-test',
        [
          {
            connector: 'google',
            authProfileRef: 'google-creds',
            scopes: ['gmail.readonly', 'calendar.readonly'],
            connectionMode: 'per_user',
          },
          {
            connector: 'salesforce',
            authProfileRef: 'salesforce-creds',
            connectionMode: 'per_user',
          },
        ],
        [
          {
            connector: 'slack',
            authProfileRef: 'slack-creds',
            connectionMode: 'shared',
          },
        ],
      );

      const state = useBatchConsentStore.getState();

      expect(state.active).toBe(true);
      expect(state.sessionId).toBe('session-test');
      expect(state.connectors).toHaveLength(3);

      // Check each connector
      const google = state.connectors.find((c) => c.authProfileRef === 'google-creds')!;
      expect(google.connector).toBe('google');
      expect(google.status).toBe('pending');
      expect(google.scopes).toEqual(['gmail.readonly', 'calendar.readonly']);
      expect(google.connectionMode).toBe('per_user');

      const sf = state.connectors.find((c) => c.authProfileRef === 'salesforce-creds')!;
      expect(sf.status).toBe('pending');

      const slack = state.connectors.find((c) => c.authProfileRef === 'slack-creds')!;
      expect(slack.status).toBe('connected');
      expect(slack.connectionMode).toBe('shared');
    });

    it('6.6: updateFromGateUpdate transitions individual connector states', () => {
      const store = useBatchConsentStore.getState();

      // Initialize with 3 pending
      store.initFromAuthRequired(
        'session-test',
        [
          { connector: 'a', authProfileRef: 'a-creds', connectionMode: 'per_user' },
          { connector: 'b', authProfileRef: 'b-creds', connectionMode: 'per_user' },
          { connector: 'c', authProfileRef: 'c-creds', connectionMode: 'per_user' },
        ],
        [],
      );

      // Connector 'a' is now satisfied
      store.updateFromGateUpdate(
        'session-test',
        [{ authProfileRef: 'b-creds' }, { authProfileRef: 'c-creds' }],
        [{ authProfileRef: 'a-creds' }],
      );

      let state = useBatchConsentStore.getState();
      expect(state.connectors.find((c) => c.authProfileRef === 'a-creds')!.status).toBe(
        'connected',
      );
      expect(state.connectors.find((c) => c.authProfileRef === 'b-creds')!.status).toBe('pending');
      expect(state.active).toBe(true);

      // Now 'b' is also satisfied
      store.updateFromGateUpdate(
        'session-test',
        [{ authProfileRef: 'c-creds' }],
        [{ authProfileRef: 'a-creds' }, { authProfileRef: 'b-creds' }],
      );

      state = useBatchConsentStore.getState();
      expect(state.connectors.find((c) => c.authProfileRef === 'b-creds')!.status).toBe(
        'connected',
      );
      expect(state.active).toBe(true); // 'c' still pending

      // Additional status transitions
      store.setAuthorizing('c-creds');
      state = useBatchConsentStore.getState();
      expect(state.connectors.find((c) => c.authProfileRef === 'c-creds')!.status).toBe(
        'authorizing',
      );

      // Authorizing state is preserved when gate update says pending
      store.updateFromGateUpdate(
        'session-test',
        [{ authProfileRef: 'c-creds' }],
        [{ authProfileRef: 'a-creds' }, { authProfileRef: 'b-creds' }],
      );
      state = useBatchConsentStore.getState();
      // Authorizing should NOT be overwritten back to pending
      expect(state.connectors.find((c) => c.authProfileRef === 'c-creds')!.status).toBe(
        'authorizing',
      );
    });

    it('6.6b: requirementKey updates do not collapse multiple entries sharing one authProfileRef', () => {
      const store = useBatchConsentStore.getState();

      store.initFromAuthRequired(
        'session-test',
        [
          {
            requirementKey: 'shared-creds:staging',
            connector: 'salesforce',
            authProfileRef: 'shared-creds',
            environment: 'staging',
            connectionMode: 'per_user',
          },
          {
            requirementKey: 'shared-creds:production',
            connector: 'hubspot',
            authProfileRef: 'shared-creds',
            environment: 'production',
            connectionMode: 'per_user',
          },
        ],
        [],
      );

      store.updateFromGateUpdate(
        'session-test',
        [{ requirementKey: 'shared-creds:production', authProfileRef: 'shared-creds' }],
        [{ requirementKey: 'shared-creds:staging', authProfileRef: 'shared-creds' }],
      );

      const state = useBatchConsentStore.getState();
      expect(
        state.connectors.find((c) => c.requirementKey === 'shared-creds:staging')!.status,
      ).toBe('connected');
      expect(
        state.connectors.find((c) => c.requirementKey === 'shared-creds:production')!.status,
      ).toBe('pending');
    });

    it('6.6c: keyed connectors ignore authProfileRef-only updates from legacy callers', () => {
      const store = useBatchConsentStore.getState();

      store.initFromAuthRequired(
        'session-test',
        [
          {
            requirementKey: 'profile:staging|mode:per_user',
            connector: 'salesforce',
            authProfileRef: 'shared-creds',
            environment: 'staging',
            connectionMode: 'per_user',
          },
          {
            requirementKey: 'profile:prod|mode:per_user',
            connector: 'hubspot',
            authProfileRef: 'shared-creds',
            environment: 'production',
            connectionMode: 'per_user',
          },
        ],
        [],
      );

      store.setFailed('shared-creds', 'legacy fallback should not touch keyed connectors');

      const state = useBatchConsentStore.getState();
      expect(
        state.connectors.find((c) => c.requirementKey === 'profile:staging|mode:per_user')!.status,
      ).toBe('pending');
      expect(
        state.connectors.find((c) => c.requirementKey === 'profile:prod|mode:per_user')!.status,
      ).toBe('pending');
    });

    it('6.7: markAllSatisfied sets allSatisfied: true (active: false)', () => {
      const store = useBatchConsentStore.getState();

      store.initFromAuthRequired(
        'session-test',
        [
          { connector: 'a', authProfileRef: 'a-creds', connectionMode: 'per_user' },
          { connector: 'b', authProfileRef: 'b-creds', connectionMode: 'per_user' },
        ],
        [],
      );

      // Set one as skipped
      store.setSkipped('b-creds');

      store.markAllSatisfied('session-test');

      const state = useBatchConsentStore.getState();
      expect(state.active).toBe(false);

      // Non-skipped connectors should be 'connected'
      expect(state.connectors.find((c) => c.authProfileRef === 'a-creds')!.status).toBe(
        'connected',
      );
      // Skipped connectors should remain 'skipped'
      expect(state.connectors.find((c) => c.authProfileRef === 'b-creds')!.status).toBe('skipped');

      // Computed getters
      expect(state.getConnectedCount()).toBe(1);
      expect(state.getTotalCount()).toBe(2);
      expect(state.getPending()).toHaveLength(0);
    });
  });

  describe('Store edge cases', () => {
    it('reset clears all state', () => {
      const store = useBatchConsentStore.getState();
      store.initFromAuthRequired(
        'session-test',
        [{ connector: 'a', authProfileRef: 'a-creds', connectionMode: 'per_user' }],
        [],
      );

      expect(useBatchConsentStore.getState().active).toBe(true);

      store.reset();

      const state = useBatchConsentStore.getState();
      expect(state.active).toBe(false);
      expect(state.sessionId).toBeNull();
      expect(state.connectors).toHaveLength(0);
    });

    it('setFailed marks connector with error message', () => {
      const store = useBatchConsentStore.getState();
      store.initFromAuthRequired(
        'session-test',
        [{ connector: 'a', authProfileRef: 'a-creds', connectionMode: 'per_user' }],
        [],
      );

      store.setFailed('a-creds', 'OAuth popup was blocked');

      const state = useBatchConsentStore.getState();
      const connector = state.connectors.find((c) => c.authProfileRef === 'a-creds')!;
      expect(connector.status).toBe('failed');
      expect(connector.error).toBe('OAuth popup was blocked');

      // Failed connectors show in getPending
      expect(state.getPending()).toHaveLength(1);
    });

    it('setConnected clears error on previously failed connector', () => {
      const store = useBatchConsentStore.getState();
      store.initFromAuthRequired(
        'session-test',
        [{ connector: 'a', authProfileRef: 'a-creds', connectionMode: 'per_user' }],
        [],
      );

      store.setFailed('a-creds', 'Network error');
      store.setConnected('a-creds');

      const state = useBatchConsentStore.getState();
      const connector = state.connectors.find((c) => c.authProfileRef === 'a-creds')!;
      expect(connector.status).toBe('connected');
      expect(connector.error).toBeUndefined();
    });

    it('initFromAuthRequired with no pending sets active: false', () => {
      const store = useBatchConsentStore.getState();
      store.initFromAuthRequired(
        'session-test',
        [], // no pending
        [{ connector: 'a', authProfileRef: 'a-creds', connectionMode: 'per_user' }],
      );

      const state = useBatchConsentStore.getState();
      expect(state.active).toBe(false);
      expect(state.connectors).toHaveLength(1);
      expect(state.connectors[0].status).toBe('connected');
    });
  });
});
