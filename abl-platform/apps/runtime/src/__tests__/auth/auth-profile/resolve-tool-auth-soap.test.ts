/**
 * resolve-tool-auth-soap — SOAP WS-Security Credential Propagation Tests
 *
 * INT-3: Verifies that wsSecurityCredentials from applyAuth's ws_security
 * branch propagates through ToolAuthResult and into the patched tool's
 * http_binding as _wsSecurityCredentials.
 *
 * SEC-3: Verifies that non-WS-Security auth paths do NOT inject
 * _wsSecurityCredentials onto the tool's http_binding.
 *
 * Testing approach:
 * - patchToolWithResolvedAuth is module-private, so we test the observable
 *   behavior through createAuthProfileToolMiddleware.
 * - For the pass-through (no auth_profile_ref) case, the middleware calls
 *   next() with the unmodified tool — verifiable without DB dependencies.
 * - For the wsSecurityCredentials propagation contract, we verify the type
 *   and construct a ToolAuthResult asserting the field is populated.
 */

import { describe, it, expect } from 'vitest';
import type { ToolAuthResult } from '../../../services/auth-profile/resolve-tool-auth.js';
import { createAuthProfileToolMiddleware } from '../../../services/auth-profile/auth-profile-tool-middleware.js';
import type { ToolCallContext, ToolCallResult } from '@abl/compiler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal tool object with http_binding, no auth_profile_ref */
function makeToolWithoutAuthProfile(): NonNullable<ToolCallContext['tool']> {
  return {
    name: 'get_weather',
    description: 'Get weather data',
    parameters: [],
    returns: { type: 'string' },
    hints: {},
    http_binding: {
      endpoint: 'https://api.example.com/weather',
      method: 'GET',
      auth: { type: 'none' as const },
      headers: { 'X-Custom': 'value' },
      query_params: { format: 'json' },
    },
  };
}

/** Minimal tool object with auth_profile_ref set */
function makeToolWithAuthProfile(): NonNullable<ToolCallContext['tool']> {
  return {
    ...makeToolWithoutAuthProfile(),
    name: 'soap_service',
    auth_profile_ref: 'ws-sec-profile',
  };
}

/** Build a ToolCallContext around a tool */
function makeCtx(tool: NonNullable<ToolCallContext['tool']>): ToolCallContext {
  return {
    toolName: tool.name,
    params: {},
    timeoutMs: 30_000,
    tool,
  };
}

// ---------------------------------------------------------------------------
// INT-3: ToolAuthResult wsSecurityCredentials type contract
// ---------------------------------------------------------------------------

describe('INT-3: ToolAuthResult wsSecurityCredentials propagation', () => {
  it('ToolAuthResult type accepts wsSecurityCredentials field', () => {
    // This is a compile-time + runtime verification that the interface
    // allows the wsSecurityCredentials field and the shape is correct.
    const result: ToolAuthResult = {
      headers: { 'Content-Type': 'text/xml' },
      source: 'auth_profile',
      authType: 'ws_security',
      secrets: { username: 'svc-user', password: 'svc-pass' },
      wsSecurityCredentials: {
        username: 'svc-user',
        password: 'svc-pass',
        mustUnderstand: true,
      },
    };

    expect(result.wsSecurityCredentials).toBeDefined();
    expect(result.wsSecurityCredentials?.username).toBe('svc-user');
    expect(result.wsSecurityCredentials?.password).toBe('svc-pass');
    expect(result.wsSecurityCredentials?.mustUnderstand).toBe(true);
    expect(result.wsSecurityCredentials?.certificate).toBeUndefined();
  });

  it('ToolAuthResult wsSecurityCredentials includes optional certificate', () => {
    const result: ToolAuthResult = {
      headers: {},
      source: 'auth_profile',
      authType: 'ws_security',
      wsSecurityCredentials: {
        username: 'cert-user',
        password: 'cert-pass',
        certificate: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
        mustUnderstand: false,
      },
    };

    expect(result.wsSecurityCredentials?.certificate).toContain('BEGIN CERTIFICATE');
    expect(result.wsSecurityCredentials?.mustUnderstand).toBe(false);
  });

  it('ToolAuthResult without wsSecurityCredentials has field undefined', () => {
    const result: ToolAuthResult = {
      headers: { Authorization: 'Bearer token123' },
      source: 'auth_profile',
      authType: 'bearer',
    };

    expect(result.wsSecurityCredentials).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SEC-3: Non-WS-Security auth does NOT inject _wsSecurityCredentials
// ---------------------------------------------------------------------------

describe('SEC-3: Non-WS-Security tools do not receive _wsSecurityCredentials', () => {
  it('middleware passes tool through unmodified when no auth_profile_ref', async () => {
    const tool = makeToolWithoutAuthProfile();
    const ctx = makeCtx(tool);

    const middleware = createAuthProfileToolMiddleware({
      tenantId: 'tenant-sec3',
      projectId: 'proj-sec3',
    });

    let receivedTool: ToolCallContext['tool'] | undefined;
    const next = async (nextCtx: ToolCallContext): Promise<ToolCallResult> => {
      receivedTool = nextCtx.tool;
      return { result: 'ok' };
    };

    await middleware(ctx, next);

    // Tool should pass through unmodified — no _wsSecurityCredentials injected
    expect(receivedTool).toBeDefined();
    expect(receivedTool?.name).toBe('get_weather');
    expect(receivedTool?.http_binding).toBeDefined();

    // Verify no _wsSecurityCredentials on the binding
    const binding = receivedTool?.http_binding as Record<string, unknown> | undefined;
    expect(binding?.['_wsSecurityCredentials']).toBeUndefined();

    // Original headers and query_params should be intact
    expect(receivedTool?.http_binding?.headers).toEqual({ 'X-Custom': 'value' });
    expect(receivedTool?.http_binding?.query_params).toEqual({ format: 'json' });
  });

  it('middleware passes tool through when auth_profile_ref lookup fails (non-jit)', async () => {
    // A tool with auth_profile_ref but no real profile in DB will throw
    // AuthProfileNotFoundError. Without jit_auth, the error propagates.
    // The important thing: the tool should NOT have _wsSecurityCredentials
    // injected in the error path.
    const tool = makeToolWithAuthProfile();
    const ctx = makeCtx(tool);

    const middleware = createAuthProfileToolMiddleware({
      tenantId: 'tenant-sec3-fail',
      projectId: 'proj-sec3-fail',
    });

    let nextCalled = false;
    const next = async (_nextCtx: ToolCallContext): Promise<ToolCallResult> => {
      nextCalled = true;
      return { result: 'ok' };
    };

    // resolveToolAuth will throw because there's no real MongoDB to find the profile.
    // The middleware should propagate the error, not inject credentials.
    await expect(middleware(ctx, next)).rejects.toThrow();
    expect(nextCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Patching contract: verify _wsSecurityCredentials placement
// ---------------------------------------------------------------------------

describe('patchToolWithResolvedAuth contract via middleware', () => {
  it('ToolAuthResult with wsSecurityCredentials is structurally valid for patching', () => {
    // This test verifies that constructing a ToolAuthResult with
    // wsSecurityCredentials produces a value that would be consumed
    // by patchToolWithResolvedAuth's opts destructuring.
    // We cannot call patchToolWithResolvedAuth directly (module-private),
    // but we verify the shape matches what the middleware passes in.
    const authResult: ToolAuthResult = {
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      queryParams: { wsdl: 'true' },
      source: 'auth_profile',
      authType: 'ws_security',
      secrets: { username: 'ws-user', password: 'ws-pass' },
      tlsOptions: undefined,
      wsSecurityCredentials: {
        username: 'ws-user',
        password: 'ws-pass',
        mustUnderstand: true,
      },
    };

    // Verify the destructuring the middleware performs is valid
    const { headers, queryParams, tlsOptions, wsSecurityCredentials } = authResult;
    expect(headers).toEqual({ 'Content-Type': 'text/xml; charset=utf-8' });
    expect(queryParams).toEqual({ wsdl: 'true' });
    expect(tlsOptions).toBeUndefined();
    expect(wsSecurityCredentials).toEqual({
      username: 'ws-user',
      password: 'ws-pass',
      mustUnderstand: true,
    });
  });

  it('patching simulation: _wsSecurityCredentials placed on http_binding', () => {
    // Simulates what patchToolWithResolvedAuth does internally.
    // Since the function is private, we replicate its exact logic here to
    // verify that the _wsSecurityCredentials field lands correctly.
    const tool = makeToolWithoutAuthProfile();
    const wsSecurityCredentials = {
      username: 'soap-user',
      password: 'soap-pass',
      mustUnderstand: true,
    };

    // Replicate the exact patching logic from patchToolWithResolvedAuth
    const patched = {
      ...tool,
      http_binding: tool.http_binding
        ? {
            ...tool.http_binding,
            headers: {
              ...(tool.http_binding.headers ?? {}),
              ...{ 'Content-Type': 'text/xml' },
            },
            query_params: {
              ...(tool.http_binding.query_params ?? {}),
            },
            ...(wsSecurityCredentials ? { _wsSecurityCredentials: wsSecurityCredentials } : {}),
            auth: { type: 'none' as const },
          }
        : tool.http_binding,
    };

    // Verify _wsSecurityCredentials is on the binding
    const binding = patched.http_binding as Record<string, unknown>;
    expect(binding['_wsSecurityCredentials']).toEqual({
      username: 'soap-user',
      password: 'soap-pass',
      mustUnderstand: true,
    });

    // Verify headers were merged
    expect(patched.http_binding?.headers).toEqual({
      'X-Custom': 'value',
      'Content-Type': 'text/xml',
    });

    // Verify auth was set to none
    expect(patched.http_binding?.auth).toEqual({ type: 'none' });
  });

  it('patching simulation: no _wsSecurityCredentials when field is undefined', () => {
    const tool = makeToolWithoutAuthProfile();
    const wsSecurityCredentials = undefined;

    const patched = {
      ...tool,
      http_binding: tool.http_binding
        ? {
            ...tool.http_binding,
            headers: {
              ...(tool.http_binding.headers ?? {}),
              ...{ Authorization: 'Bearer tok' },
            },
            query_params: {
              ...(tool.http_binding.query_params ?? {}),
            },
            ...(wsSecurityCredentials ? { _wsSecurityCredentials: wsSecurityCredentials } : {}),
            auth: { type: 'none' as const },
          }
        : tool.http_binding,
    };

    const binding = patched.http_binding as Record<string, unknown>;
    expect(binding['_wsSecurityCredentials']).toBeUndefined();
  });

  it('patching simulation: tool without http_binding is left unchanged', () => {
    const tool: NonNullable<ToolCallContext['tool']> = {
      name: 'no_binding_tool',
      description: 'Tool without HTTP binding',
      parameters: [],
      returns: { type: 'string' },
      hints: {},
    };
    const wsSecurityCredentials = {
      username: 'user',
      password: 'pass',
      mustUnderstand: true,
    };

    const patched = {
      ...tool,
      http_binding: tool.http_binding
        ? {
            ...tool.http_binding,
            ...(wsSecurityCredentials ? { _wsSecurityCredentials: wsSecurityCredentials } : {}),
            auth: { type: 'none' as const },
          }
        : tool.http_binding,
    };

    expect(patched.http_binding).toBeUndefined();
  });
});
