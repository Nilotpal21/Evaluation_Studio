/**
 * Tests for the runtime system agent handler — verifies delegate
 * invocations to system/* agents route correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isSystemAgent,
  handleSystemAgentDelegate,
  validateSystemAgentRequiredPermissions,
  type SystemAgentHandlerDeps,
} from '../services/execution/system-agent-handler.js';

describe('system-agent-handler', () => {
  const runArchAgent = vi.fn();
  const deps: SystemAgentHandlerDeps = {
    runArchAgent,
  };

  const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
    traceEvents.push(event);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    traceEvents.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isSystemAgent', () => {
    it('should identify system agents', () => {
      expect(isSystemAgent('system/arch')).toBe(true);
      expect(isSystemAgent('system/cost-estimator')).toBe(true);
      expect(isSystemAgent('my-agent')).toBe(false);
    });
  });

  describe('validateSystemAgentRequiredPermissions', () => {
    it('allows system/arch when project:write is granted', () => {
      const result = validateSystemAgentRequiredPermissions(
        {
          target: 'system/arch',
          permissions: ['project:write'],
          principalId: 'user-1',
          tenantId: 'tenant-1',
          projectId: 'project-1',
        },
        onTraceEvent,
      );

      expect(result).toBeNull();
      expect(traceEvents).toHaveLength(0);
    });

    it('returns permission_denied and emits missing permission trace when project:write is absent', () => {
      const result = validateSystemAgentRequiredPermissions(
        {
          target: 'system/arch',
          permissions: ['project:read'],
          principalId: 'user-2',
          tenantId: 'tenant-1',
          projectId: 'project-1',
        },
        onTraceEvent,
      );

      expect(result).toEqual({
        success: false,
        error: "Permission denied: missing required permission 'project:write' for system/arch",
      });
      expect(traceEvents).toEqual([
        {
          type: 'delegate_complete',
          data: expect.objectContaining({
            to: 'system/arch',
            success: false,
            systemAgent: true,
            error: 'permission_denied',
            principalId: 'user-2',
            missingPermission: 'project:write',
          }),
        },
      ]);
    });
  });

  describe('handleSystemAgentDelegate', () => {
    it('should return error for unknown system agents', async () => {
      const result = await handleSystemAgentDelegate(
        {
          target: 'system/unknown-agent',
          input: {},
          tenantId: 'tenant-1',
          projectId: 'project-1',
        },
        deps,
        onTraceEvent,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown system agent');
    });

    it('should invoke system/arch with spec from input', async () => {
      runArchAgent.mockResolvedValue({
        success: true,
        correlationId: 'corr-1',
        sessionId: 'arch-session-1',
        iterations: 1,
        events: [],
        data: {
          projectId: 'project-1',
          agents: [
            { name: 'triage', role: 'Router' },
            { name: 'specialist', role: 'Domain Expert' },
          ],
          topology: {
            agents: [
              {
                name: 'triage',
                role: 'Router',
                executionMode: 'reasoning',
                description: 'Routes',
              },
              {
                name: 'specialist',
                role: 'Domain Expert',
                executionMode: 'reasoning',
                description: 'Handles',
              },
            ],
            edges: [{ from: 'triage', to: 'specialist', type: 'delegate', condition: 'always' }],
            entryPoint: 'triage',
          },
        },
      });

      const result = await handleSystemAgentDelegate(
        {
          target: 'system/arch',
          input: {
            spec: {
              projectName: 'Customer Support Bot',
              description: 'A multi-agent customer support system',
              channels: ['web', 'slack'],
            },
          },
          tenantId: 'tenant-1',
          projectId: 'project-1',
          userId: 'user-1',
          permissions: ['project:write'],
          timeoutMs: 120000,
        },
        deps,
        onTraceEvent,
      );

      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();

      const data = result.result as {
        projectId: string;
        agents: Array<{ name: string }>;
        topology: unknown;
      };
      expect(data.projectId).toBe('project-1');
      expect(data.agents).toHaveLength(2);
      expect(runArchAgent).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-1',
          userId: 'user-1',
          permissions: ['project:write'],
          projectId: 'project-1',
        },
        {
          projectName: 'Customer Support Bot',
          description: 'A multi-agent customer support system',
          channels: ['web', 'slack'],
          language: undefined,
        },
        expect.objectContaining({ onTraceEvent }),
      );

      // Should have emitted trace events
      const startEvent = traceEvents.find((e) => e.type === 'delegate_start');
      expect(startEvent).toBeDefined();
      expect(startEvent?.data.to).toBe('system/arch');
      expect(startEvent?.data.systemAgent).toBe(true);

      const completeEvent = traceEvents.find((e) => e.type === 'delegate_complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent?.data.success).toBe(true);

      const archResultEvent = traceEvents.find((e) => e.type === 'system_arch_result');
      expect(archResultEvent?.data).toMatchObject({
        projectId: 'project-1',
        agentCount: 2,
        topologyAgentCount: 2,
      });
    });

    it('should accept direct projectName/description in input', async () => {
      runArchAgent.mockResolvedValue({
        success: true,
        correlationId: 'corr-2',
        sessionId: 'arch-session-2',
        iterations: 1,
        events: [],
        data: {
          projectId: 'project-1',
          agents: [],
          topology: { agents: [], edges: [], entryPoint: '' },
        },
      });

      const result = await handleSystemAgentDelegate(
        {
          target: 'system/arch',
          input: {
            projectName: 'My App',
            description: 'A simple chatbot',
          },
          tenantId: 'tenant-1',
          projectId: 'project-1',
        },
        deps,
        onTraceEvent,
      );

      expect(result.success).toBe(true);

      expect(runArchAgent.mock.calls[0][1]).toEqual({
        projectName: 'My App',
        description: 'A simple chatbot',
        channels: undefined,
        language: undefined,
      });
    });

    it('should fall back to message text when no structured input', async () => {
      runArchAgent.mockResolvedValue({
        success: true,
        correlationId: 'corr-3',
        sessionId: 'arch-session-3',
        iterations: 1,
        events: [],
        data: {
          projectId: 'project-1',
          agents: [],
          topology: { agents: [], edges: [], entryPoint: '' },
        },
      });

      const result = await handleSystemAgentDelegate(
        {
          target: 'system/arch',
          input: {},
          message: 'Build a customer support chatbot with routing and FAQ agents',
          tenantId: 'tenant-1',
          projectId: 'project-1',
        },
        deps,
        onTraceEvent,
      );

      expect(result.success).toBe(true);

      expect(runArchAgent.mock.calls[0][1]).toMatchObject({
        description: expect.stringContaining('customer support chatbot'),
      });
    });

    it('should return error when no spec can be built', async () => {
      const result = await handleSystemAgentDelegate(
        {
          target: 'system/arch',
          input: {},
          tenantId: 'tenant-1',
          projectId: 'project-1',
        },
        deps,
        onTraceEvent,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid input for system/arch');
    });

    it('should ignore input.projectId and use the runtime session project scope', async () => {
      runArchAgent.mockResolvedValue({
        success: true,
        correlationId: 'corr-scope',
        sessionId: 'arch-session-scope',
        iterations: 1,
        events: [],
        data: {
          projectId: 'project-1',
          agents: [],
          topology: { agents: [], edges: [], entryPoint: '' },
        },
      });

      const result = await handleSystemAgentDelegate(
        {
          target: 'system/arch',
          input: {
            projectId: 'other-project',
            projectName: 'Scoped',
            description: 'Must use runtime project scope',
          },
          tenantId: 'tenant-1',
          projectId: 'project-1',
        },
        deps,
        onTraceEvent,
      );

      expect(result.success).toBe(true);
      expect(runArchAgent.mock.calls[0][0]).toMatchObject({ projectId: 'project-1' });
    });

    it('should handle driver-level errors from Arch', async () => {
      runArchAgent.mockResolvedValue({
        success: false,
        correlationId: 'corr-error',
        error: {
          code: 'PIPELINE_ERROR',
          message: 'Pipeline failed',
        },
      });

      const result = await handleSystemAgentDelegate(
        {
          target: 'system/arch',
          input: {
            projectName: 'Broken',
            description: 'This will fail',
          },
          tenantId: 'tenant-1',
          projectId: 'project-1',
        },
        deps,
        onTraceEvent,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('PIPELINE_ERROR');
    });

    it('should handle API-level errors from Arch', async () => {
      runArchAgent.mockResolvedValue({
        success: false,
        correlationId: 'corr-timeout',
        error: {
          code: 'GENERATION_TIMEOUT',
          message: 'Generation timed out',
        },
      });

      const result = await handleSystemAgentDelegate(
        {
          target: 'system/arch',
          input: {
            projectName: 'Timeout Test',
            description: 'This times out',
          },
          tenantId: 'tenant-1',
          projectId: 'project-1',
        },
        deps,
        onTraceEvent,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('GENERATION_TIMEOUT');
    });

    it('should emit delegate_start and delegate_complete trace events', async () => {
      runArchAgent.mockResolvedValue({
        success: true,
        correlationId: 'corr-4',
        sessionId: 'arch-session-4',
        iterations: 1,
        events: [],
        data: {
          projectId: 'project-1',
          agents: [],
          topology: { agents: [], edges: [], entryPoint: '' },
        },
      });

      await handleSystemAgentDelegate(
        {
          target: 'system/arch',
          input: { projectName: 'Trace Test', description: 'test' },
          tenantId: 'tenant-1',
          projectId: 'project-1',
        },
        deps,
        onTraceEvent,
      );

      // Should have start, Arch result, and complete events.
      expect(traceEvents).toHaveLength(3);
      expect(traceEvents[0].type).toBe('delegate_start');
      expect(traceEvents[1].type).toBe('system_arch_result');
      expect(traceEvents[2].type).toBe('delegate_complete');

      // Delegate boundary events should mark as system agent.
      expect(traceEvents[0].data.systemAgent).toBe(true);
      expect(traceEvents[2].data.systemAgent).toBe(true);
    });

    it('should handle network errors gracefully', async () => {
      runArchAgent.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await handleSystemAgentDelegate(
        {
          target: 'system/arch',
          input: { projectName: 'Net Error', description: 'test' },
          tenantId: 'tenant-1',
          projectId: 'project-1',
        },
        deps,
        onTraceEvent,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');

      // Should still emit trace events
      const completeEvent = traceEvents.find((e) => e.type === 'delegate_complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent?.data.success).toBe(false);
    });
  });
});
