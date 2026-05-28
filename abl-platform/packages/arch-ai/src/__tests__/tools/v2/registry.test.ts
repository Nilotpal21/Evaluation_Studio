import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ToolRegistry,
  isInternalTool,
  isInteractiveTool,
  type ToolDefinition,
  type InternalToolDefinition,
  type InteractiveToolDefinition,
  type MinimalTurnContext,
} from '../../../tools/v2/registry.js';

describe('ToolRegistry', () => {
  function createMockContext(): MinimalTurnContext {
    return {
      sessionId: 'test-session',
      tenantId: 'test-tenant',
      userId: 'test-user',
      signal: new AbortController().signal,
      emit: () => {},
    };
  }

  describe('register', () => {
    it('registers valid internal tool', () => {
      const registry = new ToolRegistry();
      const tool: InternalToolDefinition<{ query: string }, string> = {
        name: 'search',
        kind: 'internal',
        description: 'Search documents',
        inputSchema: z.object({ query: z.string() }),
        execute: async () => 'result',
      };

      registry.register(tool);
      expect(registry.size).toBe(1);
      expect(registry.get('search')).toBe(tool);
    });

    it('registers valid interactive tool', () => {
      const registry = new ToolRegistry();
      const tool: InteractiveToolDefinition<{ question: string }> = {
        name: 'ask_user',
        kind: 'interactive',
        description: 'Ask user for input',
        inputSchema: z.object({ question: z.string() }),
      };

      registry.register(tool);
      expect(registry.size).toBe(1);
      expect(registry.get('ask_user')).toBe(tool);
    });

    it('registers tool with readOnly hint', () => {
      const registry = new ToolRegistry();
      const tool: InternalToolDefinition = {
        name: 'read_data',
        kind: 'internal',
        readOnly: true,
        description: 'Read data',
        inputSchema: z.object({}),
        execute: async () => ({}),
      };

      registry.register(tool);
      expect(registry.get('read_data')?.readOnly).toBe(true);
    });

    it('registers tool with statusLabel', () => {
      const registry = new ToolRegistry();
      const tool: InternalToolDefinition = {
        name: 'process',
        kind: 'internal',
        statusLabel: 'Processing data...',
        description: 'Process data',
        inputSchema: z.object({}),
        execute: async () => ({}),
      };

      registry.register(tool);
      expect(registry.get('process')?.statusLabel).toBe('Processing data...');
    });

    it('throws on invalid tool kind', () => {
      const registry = new ToolRegistry();
      const tool = {
        name: 'invalid',
        kind: 'unknown' as never,
        description: 'Invalid',
        inputSchema: z.object({}),
      };

      expect(() => registry.register(tool)).toThrow(
        "ToolRegistry: tool 'invalid' has invalid kind 'unknown'",
      );
    });

    it('throws when interactive tool has execute', () => {
      const registry = new ToolRegistry();
      const tool = {
        name: 'bad_interactive',
        kind: 'interactive' as const,
        description: 'Bad interactive tool',
        inputSchema: z.object({}),
        execute: async () => ({}),
      };

      expect(() => registry.register(tool)).toThrow(
        "ToolRegistry: interactive tool 'bad_interactive' MUST NOT have an execute function",
      );
    });

    it('throws when internal tool lacks execute', () => {
      const registry = new ToolRegistry();
      const tool = {
        name: 'bad_internal',
        kind: 'internal' as const,
        description: 'Bad internal tool',
        inputSchema: z.object({}),
      };

      expect(() => registry.register(tool)).toThrow(
        "ToolRegistry: internal tool 'bad_internal' MUST have an execute function",
      );
    });

    it('throws on duplicate tool name', () => {
      const registry = new ToolRegistry();
      const tool1: InternalToolDefinition = {
        name: 'duplicate',
        kind: 'internal',
        description: 'First',
        inputSchema: z.object({}),
        execute: async () => ({}),
      };
      const tool2: InternalToolDefinition = {
        name: 'duplicate',
        kind: 'internal',
        description: 'Second',
        inputSchema: z.object({}),
        execute: async () => ({}),
      };

      registry.register(tool1);
      expect(() => registry.register(tool2)).toThrow(
        "ToolRegistry: duplicate tool registration for 'duplicate'",
      );
    });

    it('throws when registry reaches MAX_TOOLS limit', () => {
      const registry = new ToolRegistry();
      // Register 100 tools (MAX_TOOLS)
      for (let i = 0; i < 100; i++) {
        registry.register({
          name: `tool${i}`,
          kind: 'internal',
          description: `Tool ${i}`,
          inputSchema: z.object({}),
          execute: async () => ({}),
        });
      }

      expect(registry.size).toBe(100);
      expect(() =>
        registry.register({
          name: 'overflow',
          kind: 'internal',
          description: 'Overflow',
          inputSchema: z.object({}),
          execute: async () => ({}),
        }),
      ).toThrow('ToolRegistry: size limit (100) reached');
    });
  });

  describe('registerAll', () => {
    it('registers multiple tools', () => {
      const registry = new ToolRegistry();
      const tools: ToolDefinition[] = [
        {
          name: 'tool1',
          kind: 'internal',
          description: 'Tool 1',
          inputSchema: z.object({}),
          execute: async () => ({}),
        },
        {
          name: 'tool2',
          kind: 'interactive',
          description: 'Tool 2',
          inputSchema: z.object({}),
        },
      ];

      registry.registerAll(tools);
      expect(registry.size).toBe(2);
      expect(registry.get('tool1')).toBeDefined();
      expect(registry.get('tool2')).toBeDefined();
    });

    it('throws if any tool in batch is invalid', () => {
      const registry = new ToolRegistry();
      const tools = [
        {
          name: 'valid',
          kind: 'internal' as const,
          description: 'Valid',
          inputSchema: z.object({}),
          execute: async () => ({}),
        },
        {
          name: 'invalid',
          kind: 'internal' as const,
          description: 'Invalid',
          inputSchema: z.object({}),
          // Missing execute
        },
      ];

      expect(() => registry.registerAll(tools)).toThrow(
        "ToolRegistry: internal tool 'invalid' MUST have an execute function",
      );
      // First tool should have been registered before error
      expect(registry.get('valid')).toBeDefined();
    });
  });

  describe('get', () => {
    it('returns tool by name', () => {
      const registry = new ToolRegistry();
      const tool: InternalToolDefinition = {
        name: 'test_tool',
        kind: 'internal',
        description: 'Test',
        inputSchema: z.object({}),
        execute: async () => ({}),
      };

      registry.register(tool);
      expect(registry.get('test_tool')).toBe(tool);
    });

    it('returns undefined for non-existent tool', () => {
      const registry = new ToolRegistry();
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  describe('list', () => {
    it('returns empty array for empty registry', () => {
      const registry = new ToolRegistry();
      expect(registry.list()).toEqual([]);
    });

    it('returns all registered tools', () => {
      const registry = new ToolRegistry();
      const tool1: InternalToolDefinition = {
        name: 'tool1',
        kind: 'internal',
        description: 'Tool 1',
        inputSchema: z.object({}),
        execute: async () => ({}),
      };
      const tool2: InteractiveToolDefinition = {
        name: 'tool2',
        kind: 'interactive',
        description: 'Tool 2',
        inputSchema: z.object({}),
      };

      registry.register(tool1);
      registry.register(tool2);

      const list = registry.list();
      expect(list).toHaveLength(2);
      expect(list).toContain(tool1);
      expect(list).toContain(tool2);
    });

    it('returns readonly array', () => {
      const registry = new ToolRegistry();
      registry.register({
        name: 'test',
        kind: 'internal',
        description: 'Test',
        inputSchema: z.object({}),
        execute: async () => ({}),
      });

      const list = registry.list();
      expect(Object.isFrozen(list)).toBe(false); // Array itself not frozen, but typed as readonly
      // TypeScript prevents mutations at compile time
    });
  });

  describe('listByKind', () => {
    it('returns only internal tools', () => {
      const registry = new ToolRegistry();
      registry.register({
        name: 'internal1',
        kind: 'internal',
        description: 'Internal 1',
        inputSchema: z.object({}),
        execute: async () => ({}),
      });
      registry.register({
        name: 'internal2',
        kind: 'internal',
        description: 'Internal 2',
        inputSchema: z.object({}),
        execute: async () => ({}),
      });
      registry.register({
        name: 'interactive1',
        kind: 'interactive',
        description: 'Interactive 1',
        inputSchema: z.object({}),
      });

      const internal = registry.listByKind('internal');
      expect(internal).toHaveLength(2);
      expect(internal.every((t) => t.kind === 'internal')).toBe(true);
    });

    it('returns only interactive tools', () => {
      const registry = new ToolRegistry();
      registry.register({
        name: 'internal1',
        kind: 'internal',
        description: 'Internal 1',
        inputSchema: z.object({}),
        execute: async () => ({}),
      });
      registry.register({
        name: 'interactive1',
        kind: 'interactive',
        description: 'Interactive 1',
        inputSchema: z.object({}),
      });
      registry.register({
        name: 'interactive2',
        kind: 'interactive',
        description: 'Interactive 2',
        inputSchema: z.object({}),
      });

      const interactive = registry.listByKind('interactive');
      expect(interactive).toHaveLength(2);
      expect(interactive.every((t) => t.kind === 'interactive')).toBe(true);
    });

    it('returns empty array when no tools match kind', () => {
      const registry = new ToolRegistry();
      registry.register({
        name: 'internal1',
        kind: 'internal',
        description: 'Internal 1',
        inputSchema: z.object({}),
        execute: async () => ({}),
      });

      const interactive = registry.listByKind('interactive');
      expect(interactive).toEqual([]);
    });
  });

  describe('listByNames', () => {
    it('returns tools matching name list', () => {
      const registry = new ToolRegistry();
      registry.register({
        name: 'tool1',
        kind: 'internal',
        description: 'Tool 1',
        inputSchema: z.object({}),
        execute: async () => ({}),
      });
      registry.register({
        name: 'tool2',
        kind: 'internal',
        description: 'Tool 2',
        inputSchema: z.object({}),
        execute: async () => ({}),
      });
      registry.register({
        name: 'tool3',
        kind: 'internal',
        description: 'Tool 3',
        inputSchema: z.object({}),
        execute: async () => ({}),
      });

      const filtered = registry.listByNames(['tool1', 'tool3']);
      expect(filtered).toHaveLength(2);
      expect(filtered.map((t) => t.name)).toEqual(['tool1', 'tool3']);
    });

    it('returns empty array when no names match', () => {
      const registry = new ToolRegistry();
      registry.register({
        name: 'tool1',
        kind: 'internal',
        description: 'Tool 1',
        inputSchema: z.object({}),
        execute: async () => ({}),
      });

      const filtered = registry.listByNames(['nonexistent']);
      expect(filtered).toEqual([]);
    });

    it('handles empty name list', () => {
      const registry = new ToolRegistry();
      registry.register({
        name: 'tool1',
        kind: 'internal',
        description: 'Tool 1',
        inputSchema: z.object({}),
        execute: async () => ({}),
      });

      const filtered = registry.listByNames([]);
      expect(filtered).toEqual([]);
    });
  });

  describe('size', () => {
    it('returns zero for empty registry', () => {
      const registry = new ToolRegistry();
      expect(registry.size).toBe(0);
    });

    it('returns correct count after registrations', () => {
      const registry = new ToolRegistry();
      expect(registry.size).toBe(0);

      registry.register({
        name: 'tool1',
        kind: 'internal',
        description: 'Tool 1',
        inputSchema: z.object({}),
        execute: async () => ({}),
      });
      expect(registry.size).toBe(1);

      registry.register({
        name: 'tool2',
        kind: 'interactive',
        description: 'Tool 2',
        inputSchema: z.object({}),
      });
      expect(registry.size).toBe(2);
    });
  });

  describe('subset', () => {
    it('creates new registry with named tools only', () => {
      const registry = new ToolRegistry();
      registry.register({
        name: 'tool1',
        kind: 'internal',
        description: 'Tool 1',
        inputSchema: z.object({}),
        execute: async () => ({}),
      });
      registry.register({
        name: 'tool2',
        kind: 'internal',
        description: 'Tool 2',
        inputSchema: z.object({}),
        execute: async () => ({}),
      });
      registry.register({
        name: 'tool3',
        kind: 'internal',
        description: 'Tool 3',
        inputSchema: z.object({}),
        execute: async () => ({}),
      });

      const sub = registry.subset(['tool1', 'tool3']);
      expect(sub.size).toBe(2);
      expect(sub.get('tool1')).toBeDefined();
      expect(sub.get('tool2')).toBeUndefined();
      expect(sub.get('tool3')).toBeDefined();
    });

    it('returns empty registry when no names match', () => {
      const registry = new ToolRegistry();
      registry.register({
        name: 'tool1',
        kind: 'internal',
        description: 'Tool 1',
        inputSchema: z.object({}),
        execute: async () => ({}),
      });

      const sub = registry.subset(['nonexistent']);
      expect(sub.size).toBe(0);
    });

    it('creates independent registry', () => {
      const registry = new ToolRegistry();
      registry.register({
        name: 'tool1',
        kind: 'internal',
        description: 'Tool 1',
        inputSchema: z.object({}),
        execute: async () => ({}),
      });

      const sub = registry.subset(['tool1']);
      sub.register({
        name: 'tool2',
        kind: 'internal',
        description: 'Tool 2',
        inputSchema: z.object({}),
        execute: async () => ({}),
      });

      expect(registry.size).toBe(1);
      expect(sub.size).toBe(2);
    });
  });

  describe('type guards', () => {
    describe('isInternalTool', () => {
      it('returns true for internal tool', () => {
        const tool: InternalToolDefinition = {
          name: 'internal',
          kind: 'internal',
          description: 'Internal',
          inputSchema: z.object({}),
          execute: async () => ({}),
        };

        expect(isInternalTool(tool)).toBe(true);
      });

      it('returns false for interactive tool', () => {
        const tool: InteractiveToolDefinition = {
          name: 'interactive',
          kind: 'interactive',
          description: 'Interactive',
          inputSchema: z.object({}),
        };

        expect(isInternalTool(tool)).toBe(false);
      });
    });

    describe('isInteractiveTool', () => {
      it('returns true for interactive tool', () => {
        const tool: InteractiveToolDefinition = {
          name: 'interactive',
          kind: 'interactive',
          description: 'Interactive',
          inputSchema: z.object({}),
        };

        expect(isInteractiveTool(tool)).toBe(true);
      });

      it('returns false for internal tool', () => {
        const tool: InternalToolDefinition = {
          name: 'internal',
          kind: 'internal',
          description: 'Internal',
          inputSchema: z.object({}),
          execute: async () => ({}),
        };

        expect(isInteractiveTool(tool)).toBe(false);
      });
    });
  });

  describe('MinimalTurnContext', () => {
    it('context has required fields', () => {
      const ctx = createMockContext();
      expect(ctx.sessionId).toBe('test-session');
      expect(ctx.tenantId).toBe('test-tenant');
      expect(ctx.userId).toBe('test-user');
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
      expect(typeof ctx.emit).toBe('function');
    });

    it('context supports optional mode and projectId', () => {
      const ctx: MinimalTurnContext = {
        ...createMockContext(),
        mode: 'in-project',
        projectId: 'project-123',
      };

      expect(ctx.mode).toBe('in-project');
      expect(ctx.projectId).toBe('project-123');
    });

    it('context supports optional services', () => {
      const ctx: MinimalTurnContext = {
        ...createMockContext(),
        services: { logger: {}, db: {} },
      };

      expect(ctx.services).toBeDefined();
      expect(Object.keys(ctx.services!)).toEqual(['logger', 'db']);
    });
  });

  describe('tool execution', () => {
    it('internal tool execute receives args and context', async () => {
      let receivedArgs: unknown;
      let receivedCtx: unknown;

      const tool: InternalToolDefinition<{ input: string }, string> = {
        name: 'test_execute',
        kind: 'internal',
        description: 'Test',
        inputSchema: z.object({ input: z.string() }),
        execute: async (args, ctx) => {
          receivedArgs = args;
          receivedCtx = ctx;
          return `Result: ${args.input}`;
        },
      };

      const ctx = createMockContext();
      const result = await tool.execute({ input: 'test' }, ctx);

      expect(result).toBe('Result: test');
      expect(receivedArgs).toEqual({ input: 'test' });
      expect(receivedCtx).toBe(ctx);
    });

    it('internal tool can use abort signal', async () => {
      const controller = new AbortController();
      const tool: InternalToolDefinition<{}, string> = {
        name: 'abortable',
        kind: 'internal',
        description: 'Abortable',
        inputSchema: z.object({}),
        execute: async (_, ctx) => {
          if (ctx.signal.aborted) {
            throw new Error('Aborted');
          }
          return 'Success';
        },
      };

      const ctx = { ...createMockContext(), signal: controller.signal };
      controller.abort();

      await expect(tool.execute({}, ctx)).rejects.toThrow('Aborted');
    });
  });
});
