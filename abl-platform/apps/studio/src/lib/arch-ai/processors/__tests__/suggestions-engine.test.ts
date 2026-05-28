import { describe, it, expect, afterEach, vi } from 'vitest';

// Mock redis-client so cache reads return null and writes are observable.
vi.mock('@/lib/redis-client', () => {
  const store = new Map<string, string>();
  const client = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    __store: store,
  };
  return {
    getRedisClient: () => client,
    __getMockClient: () => client,
  };
});

const SEND_EMAIL_AGENT_DSL = `agent notifier
description: "Sends customer notifications"

TOOLS:
  send_email(to: string, subject: string, body: string) -> {ok: boolean}
`;

const NO_MATCH_AGENT_DSL = `agent boring
description: "Plain agent"

TOOLS:
  do_something(x: string) -> {ok: boolean}
`;

describe('computeIntegrationSuggestions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function freshImports() {
    vi.resetModules();
    const redisMod = await import('@/lib/redis-client');
    const client = (redisMod as unknown as { __getMockClient: () => any }).__getMockClient();
    client.__store.clear();
    client.get.mockClear();
    client.set.mockClear();
    const { computeIntegrationSuggestions } = await import('../integration-suggestions');
    const { ProjectAgent, ProjectTool, ArchIntegrationDraft } =
      await import('@agent-platform/database/models');
    return {
      computeIntegrationSuggestions,
      ProjectAgent,
      ProjectTool,
      ArchIntegrationDraft,
      client,
    };
  }

  function mockFind<T>(model: { find: any }, leanResult: T) {
    return vi.spyOn(model, 'find').mockReturnValue({
      select: () => ({
        lean: async () => leanResult,
      }),
      lean: async () => leanResult,
    } as any);
  }

  it('returns empty array when no agents have unbound tools', async () => {
    const { computeIntegrationSuggestions, ProjectAgent, ProjectTool, ArchIntegrationDraft } =
      await freshImports();

    mockFind(ProjectAgent, [{ name: 'boring', dslContent: NO_MATCH_AGENT_DSL }]);
    mockFind(ProjectTool, []);
    mockFind(ArchIntegrationDraft, []);

    const result = await computeIntegrationSuggestions({
      user: { tenantId: 't1' },
      projectId: 'p1',
    });

    expect(result).toEqual([]);
  });

  it('returns suggestion for an agent with an unbound send_email tool', async () => {
    const { computeIntegrationSuggestions, ProjectAgent, ProjectTool, ArchIntegrationDraft } =
      await freshImports();

    mockFind(ProjectAgent, [{ name: 'notifier', dslContent: SEND_EMAIL_AGENT_DSL }]);
    mockFind(ProjectTool, []);
    mockFind(ArchIntegrationDraft, []);

    const result = await computeIntegrationSuggestions({
      user: { tenantId: 't1' },
      projectId: 'p1',
    });

    expect(result).toHaveLength(1);
    expect(result[0].targetAgentNames).toEqual(['notifier']);
    expect(result[0].rationale).toContain('send_email');
    const providerKeys = result[0].providerOptions.map((p) => p.providerKey);
    expect(providerKeys).toContain('gmail');
    expect(providerKeys).toContain('sendgrid');
  });

  it('biases ordering so suggestions for the page-context agent come first', async () => {
    const { computeIntegrationSuggestions, ProjectAgent, ProjectTool, ArchIntegrationDraft } =
      await freshImports();

    const otherAgentDsl = `agent helper
description: "another sender"

TOOLS:
  send_email(to: string, subject: string, body: string) -> {ok: boolean}
`;

    mockFind(ProjectAgent, [
      { name: 'helper', dslContent: otherAgentDsl },
      { name: 'notifier', dslContent: SEND_EMAIL_AGENT_DSL },
    ]);
    mockFind(ProjectTool, []);
    mockFind(ArchIntegrationDraft, []);

    const result = await computeIntegrationSuggestions(
      { user: { tenantId: 't1' }, projectId: 'p1' },
      {
        area: 'studio',
        page: 'agent-detail',
        entity: { type: 'agent', id: 'a-notifier', name: 'notifier' },
      },
    );

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].targetAgentNames).toEqual(['notifier']);
  });

  it('cache hit returns the cached value without re-querying DB', async () => {
    const {
      computeIntegrationSuggestions,
      ProjectAgent,
      ProjectTool,
      ArchIntegrationDraft,
      client,
    } = await freshImports();

    const cached = [
      {
        title: 'Connect slack for notifier?',
        rationale: 'cached rationale',
        providerOptions: [{ name: 'slack', providerKey: 'slack' }],
        targetAgentNames: ['notifier'],
      },
    ];
    client.__store.set('arch:integration_suggestions:t1:p1', JSON.stringify(cached));

    const agentSpy = vi.spyOn(ProjectAgent, 'find');
    const toolSpy = vi.spyOn(ProjectTool, 'find');
    const draftSpy = vi.spyOn(ArchIntegrationDraft, 'find');

    const result = await computeIntegrationSuggestions({
      user: { tenantId: 't1' },
      projectId: 'p1',
    });

    expect(result).toEqual(cached);
    expect(agentSpy).not.toHaveBeenCalled();
    expect(toolSpy).not.toHaveBeenCalled();
    expect(draftSpy).not.toHaveBeenCalled();
  });
});
