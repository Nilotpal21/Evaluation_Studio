import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPermissionContext } from '@/lib/arch-ai/guards';
import { executeExternalAgentOps } from '@/lib/arch-ai/tools/external-agent-ops';

/**
 * Unit test 4 of 4 for `external_agent_ops` (Spec 1).
 *
 * Tests envelope conformance: every action returns the canonical shape:
 *   - on success: { success: true, data: ... }
 *   - on error:   { success: false, error: { code: string, message: string } }
 *   - on need-secrets: { success: false, needsSecrets: true, flowId, requiredSecrets, message }
 *   - on need-confirm: { needsConfirmation: true, warning }
 *
 * `globalThis.fetch` is the only mocked symbol — it's a Node/browser global,
 * not a platform component, so per CLAUDE.md "Test Architecture" this is
 * permitted. No internal package mocks. Pure-function helpers
 * (parseAndValidateAgentCard, validateExternalAgentEndpoint,
 * synthesizeHandoffBlock) are tested in their own dedicated files.
 */

const TOOL_CONTEXT: ToolPermissionContext = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  authToken: 'token-1',
  user: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    permissions: [
      'external_agent:read',
      'external_agent:create',
      'external_agent:update',
      'external_agent:delete',
    ],
  },
};

const NO_PERMS_CONTEXT: ToolPermissionContext = {
  ...TOOL_CONTEXT,
  user: { ...TOOL_CONTEXT.user, permissions: [] },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('executeExternalAgentOps — result shape conformance', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('FORBIDDEN envelope', () => {
    it('returns {success:false, error:{code:FORBIDDEN}} when permissions missing', async () => {
      const result = await executeExternalAgentOps({ action: 'list' }, NO_PERMS_CONTEXT);
      expect(result).toMatchObject({
        success: false,
        error: { code: 'FORBIDDEN', message: expect.any(String) },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('AUTH_REQUIRED envelope', () => {
    it('returns AUTH_REQUIRED when authToken missing', async () => {
      const ctxNoToken: ToolPermissionContext = { ...TOOL_CONTEXT, authToken: undefined };
      const result = await executeExternalAgentOps({ action: 'list' }, ctxNoToken);
      expect(result).toMatchObject({
        success: false,
        error: { code: 'AUTH_REQUIRED', message: expect.any(String) },
      });
    });
  });

  describe('list action', () => {
    it('returns {success:true, data} on 200', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));
      const result = await executeExternalAgentOps({ action: 'list' }, TOOL_CONTEXT);
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('forwards X-Tenant/Project/User headers + bearer auth', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));
      await executeExternalAgentOps({ action: 'list' }, TOOL_CONTEXT);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0];
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer token-1');
      expect(headers['X-Tenant-Id']).toBe('tenant-1');
      expect(headers['X-Project-Id']).toBe('proj-1');
      expect(headers['X-User-Id']).toBe('user-1');
    });
  });

  describe('read action', () => {
    it('returns MISSING_PARAM when agentId absent', async () => {
      const result = await executeExternalAgentOps({ action: 'read' }, TOOL_CONTEXT);
      expect(result).toMatchObject({
        success: false,
        error: { code: 'MISSING_PARAM', message: expect.any(String) },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns {success:true, data} when found', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 'a-1' } }));
      const result = await executeExternalAgentOps(
        { action: 'read', agentId: 'a-1' },
        TOOL_CONTEXT,
      );
      expect(result.success).toBe(true);
    });

    it('returns NOT_FOUND on 404', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ error: { code: 'NOT_FOUND', message: 'gone' } }, 404),
      );
      const result = await executeExternalAgentOps(
        { action: 'read', agentId: 'a-1' },
        TOOL_CONTEXT,
      );
      expect(result).toMatchObject({
        success: false,
        error: { code: 'NOT_FOUND' },
      });
    });
  });

  describe('create action', () => {
    it('returns MISSING_PARAM when name absent', async () => {
      const result = await executeExternalAgentOps({ action: 'create' }, TOOL_CONTEXT);
      expect(result).toMatchObject({ success: false, error: { code: 'MISSING_PARAM' } });
    });

    it('returns MISSING_PARAM when endpoint absent', async () => {
      const result = await executeExternalAgentOps(
        { action: 'create', name: 'NewAgent' },
        TOOL_CONTEXT,
      );
      expect(result).toMatchObject({ success: false, error: { code: 'MISSING_PARAM' } });
    });

    it('returns SSRF_REJECTED when endpoint is unsafe', async () => {
      const result = await executeExternalAgentOps(
        {
          action: 'create',
          name: 'BadAgent',
          endpoint: 'http://169.254.169.254/meta',
          protocol: 'a2a',
          authType: 'none',
        },
        TOOL_CONTEXT,
      );
      expect(result).toMatchObject({ success: false, error: { code: 'SSRF_REJECTED' } });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns needsSecrets envelope when authType=bearer and no flowId', async () => {
      const result = await executeExternalAgentOps(
        {
          action: 'create',
          name: 'AuthAgent',
          endpoint: 'https://agent.example.com',
          protocol: 'a2a',
          authType: 'bearer',
        },
        TOOL_CONTEXT,
      );
      expect(result.needsSecrets).toBe(true);
      expect(result.flowId).toBeTruthy();
      expect(result.requiredSecrets).toEqual(['value']);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns {success:true, data} on 201', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ success: true, data: { id: 'a-99', name: 'NewAgent' } }, 201),
      );
      const result = await executeExternalAgentOps(
        {
          action: 'create',
          name: 'NewAgent',
          endpoint: 'https://agent.example.com',
          protocol: 'a2a',
          authType: 'none',
        },
        TOOL_CONTEXT,
      );
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });
  });

  describe('update action', () => {
    it('returns MISSING_PARAM when agentId absent', async () => {
      const result = await executeExternalAgentOps({ action: 'update' }, TOOL_CONTEXT);
      expect(result).toMatchObject({ success: false, error: { code: 'MISSING_PARAM' } });
    });

    it('returns {success:true, data} on 200', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 'a-1' } }));
      const result = await executeExternalAgentOps(
        { action: 'update', agentId: 'a-1', displayName: 'New Name' },
        TOOL_CONTEXT,
      );
      expect(result.success).toBe(true);
    });
  });

  describe('delete action', () => {
    it('returns needsConfirmation envelope when not confirmed', async () => {
      const result = await executeExternalAgentOps(
        { action: 'delete', agentId: 'a-1' },
        TOOL_CONTEXT,
      );
      expect(result.needsConfirmation).toBe(true);
      expect(result.warning).toBeTruthy();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns MISSING_PARAM when agentId absent (even with confirmed=true)', async () => {
      const result = await executeExternalAgentOps(
        { action: 'delete', confirmed: true },
        TOOL_CONTEXT,
      );
      expect(result).toMatchObject({ success: false, error: { code: 'MISSING_PARAM' } });
    });

    it('returns {success:true} on 204 when confirmed', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
      const result = await executeExternalAgentOps(
        { action: 'delete', agentId: 'a-1', confirmed: true },
        TOOL_CONTEXT,
      );
      expect(result.success).toBe(true);
    });
  });

  describe('test_connection action', () => {
    it('returns MISSING_PARAM when agentId absent', async () => {
      const result = await executeExternalAgentOps({ action: 'test_connection' }, TOOL_CONTEXT);
      expect(result).toMatchObject({ success: false, error: { code: 'MISSING_PARAM' } });
    });

    it('returns {success:true, data} on 200', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { id: 'a-1', lastConnectionStatus: 'connected', lastConnectionLatencyMs: 240 },
        }),
      );
      const result = await executeExternalAgentOps(
        { action: 'test_connection', agentId: 'a-1' },
        TOOL_CONTEXT,
      );
      expect(result.success).toBe(true);
    });
  });

  describe('discover_preview action', () => {
    it('returns MISSING_PARAM when endpoint absent', async () => {
      const result = await executeExternalAgentOps({ action: 'discover_preview' }, TOOL_CONTEXT);
      expect(result).toMatchObject({ success: false, error: { code: 'MISSING_PARAM' } });
    });

    it('returns SSRF_REJECTED for unsafe endpoint', async () => {
      const result = await executeExternalAgentOps(
        { action: 'discover_preview', endpoint: 'http://169.254.169.254' },
        TOOL_CONTEXT,
      );
      expect(result).toMatchObject({ success: false, error: { code: 'SSRF_REJECTED' } });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns CARD_INVALID when remote returns malformed JSON', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ description: 'no name field' }));
      const result = await executeExternalAgentOps(
        { action: 'discover_preview', endpoint: 'https://agent.example.com' },
        TOOL_CONTEXT,
      );
      expect(result).toMatchObject({ success: false, error: { code: 'CARD_INVALID' } });
    });

    it('returns {success:true, data:{card}} on valid card', async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ name: 'RemoteAgent', skills: [] }));
      const result = await executeExternalAgentOps(
        { action: 'discover_preview', endpoint: 'https://agent.example.com' },
        TOOL_CONTEXT,
      );
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ card: { name: 'RemoteAgent' } });
    });

    // R7 RISK #2(b): redirect manual + 3xx => REDIRECT_REJECTED.
    // Pinning this prevents a regression where a future change might enable
    // automatic redirect-following and re-introduce the SSRF risk that the
    // manual-redirect guard exists to prevent.
    it('returns REDIRECT_REJECTED on 302 with Location header', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://elsewhere.example' },
        }),
      );
      const result = await executeExternalAgentOps(
        { action: 'discover_preview', endpoint: 'https://agent.example.com' },
        TOOL_CONTEXT,
      );
      expect(result).toMatchObject({
        success: false,
        error: { code: 'REDIRECT_REJECTED' },
      });
    });

    // R1 MED-5: payload size cap (256KB). The executor checks BOTH
    // Content-Length header (cheap pre-check) AND post-read length
    // (defense in depth — header may lie or be absent). We exercise the
    // cheaper Content-Length path here; see DISCOVER_MAX_BYTES in the
    // executor for the source-of-truth value.
    it('returns CARD_TOO_LARGE when Content-Length exceeds the 256KB cap', async () => {
      const DISCOVER_MAX_BYTES = 256 * 1024; // mirror executor constant
      fetchSpy.mockResolvedValueOnce(
        new Response('{}', {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(DISCOVER_MAX_BYTES + 1),
          },
        }),
      );
      const result = await executeExternalAgentOps(
        { action: 'discover_preview', endpoint: 'https://agent.example.com' },
        TOOL_CONTEXT,
      );
      expect(result).toMatchObject({
        success: false,
        error: { code: 'CARD_TOO_LARGE' },
      });
    });

    // Defense-in-depth check: if Content-Length is absent (or lies), the
    // post-read length check still trips CARD_TOO_LARGE.
    it('returns CARD_TOO_LARGE when streamed body exceeds cap with no Content-Length', async () => {
      const DISCOVER_MAX_BYTES = 256 * 1024;
      const oversizedBody = 'x'.repeat(DISCOVER_MAX_BYTES + 100);
      fetchSpy.mockResolvedValueOnce(
        new Response(oversizedBody, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const result = await executeExternalAgentOps(
        { action: 'discover_preview', endpoint: 'https://agent.example.com' },
        TOOL_CONTEXT,
      );
      expect(result).toMatchObject({
        success: false,
        error: { code: 'CARD_TOO_LARGE' },
      });
    });
  });

  describe('invalid action', () => {
    it('returns INVALID_ACTION envelope', async () => {
      const result = await executeExternalAgentOps(
        // @ts-expect-error — intentionally invalid action
        { action: 'banana' },
        TOOL_CONTEXT,
      );
      expect(result).toMatchObject({
        success: false,
        error: { code: 'INVALID_ACTION', message: expect.any(String) },
      });
      // checkToolPermission allows unknown actions by default (logs a warn);
      // the switch's default arm returns INVALID_ACTION.
    });
  });

  describe('exception handling', () => {
    it('returns INTERNAL_ERROR envelope when fetch throws', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('network down'));
      const result = await executeExternalAgentOps({ action: 'list' }, TOOL_CONTEXT);
      expect(result).toMatchObject({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: expect.stringContaining('network down') },
      });
    });
  });
});
