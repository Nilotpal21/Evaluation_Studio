import { describe, expect, it } from 'vitest';
import { buildRuntimeChatNotice, formatQueuedRuntimeNotice } from '../lib/runtime-chat-notice';

describe('runtime chat notices', () => {
  it('formats queued auth-gate notices', () => {
    expect(formatQueuedRuntimeNotice('auth_gate_active')).toContain('queued');
    expect(formatQueuedRuntimeNotice('auth_gate_active')).toContain('authorization');
  });

  it('builds an auth-required notice from pending connectors', () => {
    expect(
      buildRuntimeChatNotice({
        type: 'auth_required',
        pending: [
          { connector: 'google', authProfileRef: 'google_auth' },
          { connector: 'slack', authProfileRef: 'slack_auth' },
        ],
      }),
    ).toBe('Authorization is required before the agent can continue: google, slack.');
  });

  it('builds warning and health notices', () => {
    expect(
      buildRuntimeChatNotice({
        type: 'tool_warnings',
        warnings: ['Calendar credentials missing'],
      }),
    ).toBe('Tool warning: Calendar credentials missing');

    expect(
      buildRuntimeChatNotice({
        type: 'session_health',
        health: [
          { category: 'llm', severity: 'error', code: 'MODEL_MISSING', message: 'No model' },
          {
            category: 'database',
            severity: 'warning',
            code: 'CACHE_STALE',
            message: 'Cache stale',
          },
        ],
      }),
    ).toBe('No model | Cache stale');
  });

  it('builds auth challenge notices for preview surfaces', () => {
    expect(
      buildRuntimeChatNotice({
        type: 'auth_challenge',
        profileName: 'Google',
        prompt: 'Please authorize Google before continuing.',
        authUrl: 'https://example.com/oauth',
      }),
    ).toBe('Please authorize Google before continuing. Open: https://example.com/oauth');
  });

  it('returns null for unrelated messages', () => {
    expect(
      buildRuntimeChatNotice({
        type: 'response_start',
      }),
    ).toBeNull();
  });
});
