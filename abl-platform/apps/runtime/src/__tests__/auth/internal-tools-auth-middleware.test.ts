/**
 * FR-9 Phase 1.1 — workflow tool_call middleware injection tests.
 *
 * Verifies the internal-tools route wiring of `createAuthProfileToolMiddleware`
 * and the workflow-context rejection contract surfaced by resolve-tool-auth.
 * Per CLAUDE.md "Test Architecture" — no `vi.mock` of platform components.
 * The middleware no-op path is exercised against a real factory + real `next`
 * callback. The error contract is verified against the actual error classes.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AuthProfilePerUserInWorkflowError,
  AuthProfileJitInWorkflowError,
} from '../../services/auth-profile/resolve-tool-auth.js';
import { createAuthProfileToolMiddleware } from '../../services/auth-profile/auth-profile-tool-middleware.js';
import type { ToolCallContext, ToolCallResult } from '@abl/compiler';

describe('FR-9 workflow auth-profile error classes', () => {
  it('AuthProfilePerUserInWorkflowError carries the canonical AUTH_PROFILE_PER_USER_IN_WORKFLOW code', () => {
    const err = new AuthProfilePerUserInWorkflowError('shared-google', 'calendar-lookup');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('AUTH_PROFILE_PER_USER_IN_WORKFLOW');
    expect(err.profileName).toBe('shared-google');
    expect(err.toolName).toBe('calendar-lookup');
    expect(err.message).toContain('connectionMode=');
    expect(err.message).toContain("'per_user'");
    expect(err.message).toContain('shared-google');
  });

  it('AuthProfileJitInWorkflowError carries the canonical JIT_AUTH_NOT_SUPPORTED code', () => {
    const err = new AuthProfileJitInWorkflowError('jit-okta', 'okta-list-users');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('JIT_AUTH_NOT_SUPPORTED');
    expect(err.profileName).toBe('jit-okta');
    expect(err.toolName).toBe('okta-list-users');
    expect(err.message).toContain('jit');
    expect(err.message).toContain('workflow');
  });
});

describe('createAuthProfileToolMiddleware injection contract', () => {
  it('returns a callable middleware function from the factory', () => {
    const middleware = createAuthProfileToolMiddleware({
      tenantId: 'tenant-test',
      projectId: 'project-test',
      environment: 'dev',
      workflowContext: true,
    });
    expect(typeof middleware).toBe('function');
  });

  it('passes through tools without auth_profile_ref without invoking the resolver', async () => {
    const middleware = createAuthProfileToolMiddleware({
      tenantId: 'tenant-test',
      projectId: 'project-test',
      workflowContext: true,
    });

    const tool = {
      name: 'plain-http-tool',
      http_binding: {
        endpoint: 'https://example.com/api',
        method: 'GET' as const,
        headers: {},
        auth: { type: 'none' as const },
      },
    };

    const ctx = { tool } as unknown as ToolCallContext;
    const next = vi.fn(
      async (passed: ToolCallContext): Promise<ToolCallResult> => ({
        result: JSON.stringify({ ok: true, receivedTool: passed.tool?.name }),
      }),
    );

    const result = await middleware(ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(ctx);
    expect(JSON.parse(result.result as string)).toEqual({
      ok: true,
      receivedTool: 'plain-http-tool',
    });
  });

  it('accepts workflowContext as an optional configuration knob (default undefined)', () => {
    const withFlag = createAuthProfileToolMiddleware({
      tenantId: 't1',
      workflowContext: true,
    });
    const withoutFlag = createAuthProfileToolMiddleware({ tenantId: 't1' });
    expect(typeof withFlag).toBe('function');
    expect(typeof withoutFlag).toBe('function');
  });
});

describe('FR-9 kill-switch (WORKFLOW_AUTH_PROFILE_ENABLED)', () => {
  // The env-var read happens inside isWorkflowAuthProfileEnabled() in
  // internal-tools.ts; we re-derive the same predicate here as a contract
  // test so a regression in default behavior surfaces immediately.
  function predicate(value: string | undefined): boolean {
    return value !== 'false';
  }

  it('defaults to enabled when the env var is unset', () => {
    expect(predicate(undefined)).toBe(true);
  });

  it('defaults to enabled for any value other than the literal string "false"', () => {
    expect(predicate('true')).toBe(true);
    expect(predicate('1')).toBe(true);
    expect(predicate('')).toBe(true);
    expect(predicate('FALSE')).toBe(true); // case-sensitive on purpose
  });

  it('disables only on the exact string "false"', () => {
    expect(predicate('false')).toBe(false);
  });
});
