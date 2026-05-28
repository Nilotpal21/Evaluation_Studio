import { beforeEach, describe, expect, it, vi } from 'vitest';

const { projectAgentFindMock, resolveToolImplementationsMock, findMcpServerConfigsByProjectMock } =
  vi.hoisted(() => ({
    projectAgentFindMock: vi.fn(),
    resolveToolImplementationsMock: vi.fn(),
    findMcpServerConfigsByProjectMock: vi.fn(),
  }));

vi.mock('@agent-platform/database/models', () => ({
  ProjectAgent: {
    find: projectAgentFindMock,
  },
}));

vi.mock('@agent-platform/shared/tools/resolve', () => ({
  resolveToolImplementations: resolveToolImplementationsMock,
}));

vi.mock('@agent-platform/shared/repos', () => ({
  findMcpServerConfigsByProject: findMcpServerConfigsByProjectMock,
}));

vi.mock('@/lib/arch-ai/message-services', () => ({
  sessionService: {},
  journalService: {},
  projectMemoryService: {},
}));

import { validateProjectAgentCode } from '@/lib/arch-ai/tools/in-project-tools';

describe('Arch AI agent edit runtime validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectAgentFindMock.mockResolvedValue([]);
    findMcpServerConfigsByProjectMock.mockResolvedValue([]);
  });

  it('warns but does not block edits that reference a missing ProjectTool implementation', async () => {
    resolveToolImplementationsMock.mockResolvedValue({
      resolvedByAgent: new Map(),
      errors: [
        {
          code: 'E721',
          message:
            "Tool 'lookup_customer' not found in project. Create it in the Tool Library first.",
        },
      ],
      warnings: [],
      snapshotEntries: [],
      timings: {
        dbQueryMs: 0,
        redisCacheLookupMs: 0,
        redisCacheHits: 0,
        redisCacheMisses: 0,
        compilationMs: 0,
        redisCacheWriteMs: 0,
        totalMs: 0,
      },
    });

    const result = await validateProjectAgentCode(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'project-1',
      'SupportAgent',
      `AGENT: SupportAgent
GOAL: "Help customers"
TOOLS:
  lookup_customer(customer_id: string) -> object
    description: "Look up customer details"
`,
    );

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.warnings[0]?.message).toContain('E721');
      expect(result.warnings[0]?.message).toContain('lookup_customer');
    }
  });

  it('rejects edits that introduce a cross-agent return completion regression', async () => {
    projectAgentFindMock.mockResolvedValue([
      {
        name: 'SupportRouter',
        dslContent: `SUPERVISOR: SupportRouter
GOAL: "Route customers to the right specialist"
PERSONA: "Concise support router"
GUARDRAILS:
  content_safety:
    kind: input
    tier: 1
    check: "Block harmful content"
    action: block
    threshold: 0.8
MEMORY:
  session:
    - name: current_intent
      type: string
      initial_value: null
HANDOFF:
  - TO: ProductInfo
    WHEN: true
    CONTEXT:
      pass: []
      summary: "User needs product information."
    RETURN: true
`,
      },
      {
        name: 'ProductInfo',
        dslContent: `AGENT: ProductInfo
GOAL: "Answer product information questions and return to the router"
PERSONA: "Helpful product specialist"
GUARDRAILS:
  content_safety:
    kind: input
    tier: 1
    check: "Block harmful content"
    action: block
    threshold: 0.8
MEMORY:
  session:
    - name: current_topic
      type: string
      initial_value: null
GATHER:
  product_question:
    type: string
    required: true
    prompt: "Which product would you like to know about?"
COMPLETE:
  - WHEN: product_question IS SET
    RESPOND: ""
`,
      },
    ]);

    const result = await validateProjectAgentCode(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'project-1',
      'ProductInfo',
      `AGENT: ProductInfo
GOAL: "Answer product information questions conversationally"
PERSONA: "Helpful product specialist"
GUARDRAILS:
  content_safety:
    kind: input
    tier: 1
    check: "Block harmful content"
    action: block
    threshold: 0.8
MEMORY:
  session:
    - name: current_topic
      type: string
      initial_value: null
`,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]?.message).toContain('CO-04');
      expect(result.errors[0]?.message).toContain('Proposed edit introduces');
      expect(result.hint).toContain('preserve a COMPLETE condition');
    }
  });

  it('validates agent renames against the planned handoff cascade', async () => {
    projectAgentFindMock.mockResolvedValue([
      {
        name: 'SupportRouter',
        dslContent: `SUPERVISOR: SupportRouter
GOAL: "Route customers to booking"
PERSONA: "Concise support router"
HANDOFF:
  - TO: Booking
    WHEN: true
    CONTEXT:
      pass: []
      summary: "User needs booking help."
    RETURN: true
COMPLETE:
  - WHEN: true
    RESPOND: "Done"
`,
      },
      {
        name: 'Booking',
        dslContent: `AGENT: Booking
GOAL: "Book appointments"
PERSONA: "Helpful booking specialist"
COMPLETE:
  - WHEN: true
    RESPOND: "Booked"
`,
      },
    ]);

    const result = await validateProjectAgentCode(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'project-1',
      'Booking',
      `AGENT: BookingV2
GOAL: "Book appointments"
PERSONA: "Helpful booking specialist"
COMPLETE:
  - WHEN: true
    RESPOND: "Booked"
`,
    );

    expect(result.valid).toBe(true);
  });

  it('does not treat pre-existing rename-related diagnostics as new blockers', async () => {
    projectAgentFindMock.mockResolvedValue([
      {
        name: 'SupportRouter',
        dslContent: `SUPERVISOR: SupportRouter
GOAL: "Route customers to booking"
PERSONA: "Concise support router"
HANDOFF:
  - TO: Booking
    WHEN: true
    CONTEXT:
      pass: []
      summary: "User needs booking help."
    RETURN: true
COMPLETE:
  - WHEN: true
    RESPOND: "Done"
`,
      },
      {
        name: 'Booking',
        dslContent: `AGENT: Booking
GOAL: "Book appointments"
PERSONA: "Helpful booking specialist"
`,
      },
    ]);

    const result = await validateProjectAgentCode(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'project-1',
      'Booking',
      `AGENT: BookingV2
GOAL: "Book appointments"
PERSONA: "Helpful booking specialist"
`,
    );

    expect(result.valid).toBe(true);
  });

  it('does not block unrelated edits on pre-existing sibling tool-binding errors', async () => {
    projectAgentFindMock.mockResolvedValue([
      {
        name: 'SupportAgent',
        dslContent: `AGENT: SupportAgent
GOAL: "Help customers"
PERSONA: "Helpful support agent"
COMPLETE:
  - WHEN: true
    RESPOND: "Done"
`,
      },
      {
        name: 'BrokenToolAgent',
        dslContent: `AGENT: BrokenToolAgent
GOAL: "Owns a pre-existing broken inline tool"
PERSONA: "Tool owner"
TOOLS:
  broken_lookup(id: string) -> object
    description: "Broken HTTP binding"
    type: http
    endpoint: "not-a-url"
    method: GET
COMPLETE:
  - WHEN: true
    RESPOND: "Done"
`,
      },
    ]);

    const result = await validateProjectAgentCode(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'project-1',
      'SupportAgent',
      `AGENT: SupportAgent
GOAL: "Help customers politely"
PERSONA: "Helpful support agent"
COMPLETE:
  - WHEN: true
    RESPOND: "Done"
`,
    );

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.warnings.some((warning) => warning.agent === 'BrokenToolAgent')).toBe(true);
    }
  });
});
