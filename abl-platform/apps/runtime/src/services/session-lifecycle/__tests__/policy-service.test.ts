import { describe, expect, it } from 'vitest';
import { resolveSessionLifecyclePolicy, validateSessionEndHookConfig } from '../policy-service.js';

describe('resolveSessionLifecyclePolicy', () => {
  it('applies tenant, project, agent, and explicit precedence with channel hook override', () => {
    const resolved = resolveSessionLifecyclePolicy({
      channel: 'web_chat',
      tenant: {
        runtime: {
          idleSeconds: 1800,
          maxAgeSeconds: 28800,
        },
        disconnect: {
          defaultDisposition: 'abandoned',
          disconnectBehavior: 'detach',
        },
      },
      project: {
        runtime: {
          idleSeconds: 900,
        },
        endHook: {
          mode: 'ignore',
        },
        channels: {
          web_chat: {
            defaultDisposition: 'completed',
            disconnectBehavior: 'end',
            endHook: {
              mode: 'respond',
              message: 'This chat has ended.',
            },
          },
        },
      },
      agent: {
        idleSeconds: 300,
        disconnect: {
          defaultDisposition: 'transferred',
        },
      },
      explicit: {
        runtime: {
          maxAgeSeconds: 120,
        },
        disconnect: {
          disconnectBehavior: 'detach',
        },
      },
    });

    expect(resolved.runtime.idleSeconds).toEqual({
      value: 300,
      source: 'agent',
    });
    expect(resolved.runtime.maxAgeSeconds).toEqual({
      value: 120,
      source: 'explicit',
    });
    expect(resolved.disconnect.defaultDisposition).toEqual({
      value: 'transferred',
      source: 'agent',
    });
    expect(resolved.disconnect.disconnectBehavior).toEqual({
      value: 'detach',
      source: 'explicit',
    });
    expect(resolved.endHook).toEqual({
      config: {
        mode: 'respond',
        message: 'This chat has ended.',
      },
      source: 'project.channel.web_chat',
    });
  });

  it('falls back to the project default hook when the channel has no override', () => {
    const resolved = resolveSessionLifecyclePolicy({
      channel: 'sms',
      project: {
        endHook: {
          mode: 'respond',
          message: 'Session ended.',
        },
      },
    });

    expect(resolved.endHook).toEqual({
      config: {
        mode: 'respond',
        message: 'Session ended.',
      },
      source: 'project',
    });
  });
});

describe('validateSessionEndHookConfig', () => {
  it('accepts ignore and respond modes', () => {
    expect(validateSessionEndHookConfig({ mode: 'ignore' }).success).toBe(true);
    expect(
      validateSessionEndHookConfig({ mode: 'respond', message: 'This session has ended.' }).success,
    ).toBe(true);
  });

  it('rejects unsupported modes and respond hooks without a message', () => {
    expect(validateSessionEndHookConfig({ mode: 'call' }).success).toBe(false);
    expect(validateSessionEndHookConfig({ mode: 'respond' }).success).toBe(false);
  });
});
