import { describe, test, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the service under test
// ---------------------------------------------------------------------------

const mockFind = vi.fn();
const mockSessionFindOne = vi.fn();
vi.mock('@agent-platform/database/models', () => ({
  Message: { find: (...args: any[]) => mockFind(...args) },
  Session: { findOne: (...args: any[]) => mockSessionFindOne(...args) },
  ProjectRuntimeConfig: {
    findOne: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        pii_redaction: { enabled: true, redact_input: true, redact_output: true },
      }),
    }),
  },
  PIIPattern: {
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

const mockQuery = vi.fn();
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({ query: mockQuery }),
}));

const mockDecryptForTenantAuto = vi.fn();
vi.mock('@agent-platform/shared/encryption', () => ({
  decryptForTenantAuto: (...args: any[]) => mockDecryptForTenantAuto(...args),
  isAlreadyEncrypted: (value: string) => {
    const parts = value.split(':');
    return parts.length === 3 && parts.every((p: string) => /^[0-9a-f]+$/i.test(p));
  },
  isLegacyFormat: (value: string) => {
    // Match hex 3-part format used by test fixtures
    const parts = value.split(':');
    return parts.length === 3 && parts.every((p: string) => /^[0-9a-f]+$/i.test(p));
  },
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

vi.mock('mongoose', () => ({
  default: { connection: { readyState: 1 } },
  connection: { readyState: 1 },
}));

const { ConversationReader } = await import('../pipeline/services/conversation-reader.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMongoMessageDocs(count: number, sessionId = 'sess-1') {
  return Array.from({ length: count }, (_, i) => ({
    _id: `msg-${i}`,
    sessionId,
    tenantId: 'tenant-1',
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `aabb00${i.toString(16).padStart(2, '0')}:ccdd00${i.toString(16).padStart(2, '0')}:eeff00${i.toString(16).padStart(2, '0')}`,
    encrypted: true,
    channel: 'web_chat',
    timestamp: new Date(Date.now() + i * 1000),
    metadata: {},
  }));
}

function makeTraceRows() {
  return [
    {
      session_id: 'sess-1',
      event_type: 'tool.call.completed',
      agent_name: 'BillingAgent',
      data: 'encrypted-tool-data',
      timestamp: new Date().toISOString(),
      duration_ms: 150,
      has_error: 0,
    },
    {
      session_id: 'sess-1',
      event_type: 'agent.escalated',
      agent_name: 'BillingAgent',
      data: 'encrypted-escalation-data',
      timestamp: new Date().toISOString(),
      duration_ms: 0,
      has_error: 0,
    },
  ];
}

/** Helper to wrap row arrays as ClickHouse result sets */
function chResult(rows: Record<string, unknown>[]) {
  return { json: async () => ({ data: rows }) };
}

/** Create a chainable Mongoose query mock */
function mongooseChain(docs: Record<string, unknown>[]) {
  const chain: Record<string, any> = {};
  chain.sort = vi.fn().mockReturnValue(chain);
  chain.skip = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.lean = vi.fn().mockResolvedValue(docs);
  return chain;
}

function mongooseSessionChain(doc: Record<string, unknown> | null) {
  const chain = {
    lean: vi.fn().mockResolvedValue(doc),
  };
  return chain;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConversationReader', () => {
  let reader: InstanceType<typeof ConversationReader>;

  beforeEach(() => {
    mockFind.mockReset();
    mockSessionFindOne.mockReset();
    mockQuery.mockReset();
    mockDecryptForTenantAuto.mockReset();

    // Default: session not found (no retry)
    mockSessionFindOne.mockReturnValue(mongooseSessionChain(null));

    reader = new ConversationReader({ tenantId: 'tenant-1', projectId: 'project-1' });
  });

  // ---- readSession --------------------------------------------------------

  test('reads and decrypts messages for a session', async () => {
    const docs = makeMongoMessageDocs(4);
    mockFind.mockReturnValueOnce(mongooseChain(docs));
    mockSessionFindOne.mockReturnValue(
      mongooseSessionChain({ messageCount: 4, currentAgent: 'TestAgent', channel: 'web_chat' }),
    );
    mockDecryptForTenantAuto.mockImplementation(async (data: string) => `decrypted-${data}`);

    const result = await reader.readSession('tenant-1', 'sess-1');

    expect(result.tenantId).toBe('tenant-1');
    expect(result.sessionId).toBe('sess-1');
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0].content).toBe('decrypted-aabb0000:ccdd0000:eeff0000');
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.metadata.messageCount).toBe(4);
    expect(result.metadata.agentName).toBe('TestAgent');
    expect(mockSessionFindOne).toHaveBeenCalledWith(
      { _id: 'sess-1', tenantId: 'tenant-1' },
      { messageCount: 1, currentAgent: 1, channel: 1 },
    );
    expect(mockDecryptForTenantAuto).toHaveBeenCalledTimes(4);
  });

  test('returns empty result for session with no messages', async () => {
    mockFind.mockReturnValueOnce(mongooseChain([]));

    const result = await reader.readSession('tenant-1', 'sess-empty');

    expect(result.messages).toHaveLength(0);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.escalations).toHaveLength(0);
    expect(result.metadata.messageCount).toBe(0);
  });

  test('filters messages by role when roles option is provided', async () => {
    const docs = makeMongoMessageDocs(4);
    mockFind.mockImplementation(() => mongooseChain(docs));
    mockSessionFindOne.mockReturnValue(
      mongooseSessionChain({ messageCount: 4, currentAgent: 'TestAgent', channel: 'web_chat' }),
    );
    mockDecryptForTenantAuto.mockImplementation(async (data: string) => `decrypted-${data}`);

    const result = await reader.readSession('tenant-1', 'sess-1', {
      roles: ['user'],
    });

    // Only user messages (indices 0, 2)
    expect(result.messages).toHaveLength(2);
    expect(result.messages.every((m: { role: string }) => m.role === 'user')).toBe(true);
    expect(mockFind).toHaveBeenCalledTimes(1);
  });

  test('retries role-filtered reads until the raw Mongo message count catches up', async () => {
    const partialDocs = makeMongoMessageDocs(2);
    const fullDocs = makeMongoMessageDocs(4);
    mockFind
      .mockReturnValueOnce(mongooseChain(partialDocs))
      .mockReturnValueOnce(mongooseChain(fullDocs));
    mockSessionFindOne.mockReturnValue(
      mongooseSessionChain({ messageCount: 4, currentAgent: 'TestAgent', channel: 'web_chat' }),
    );
    mockDecryptForTenantAuto.mockImplementation(async (data: string) => `decrypted-${data}`);

    const result = await reader.readSession('tenant-1', 'sess-1', {
      roles: ['user'],
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages.every((m: { role: string }) => m.role === 'user')).toBe(true);
    expect(mockFind).toHaveBeenCalledTimes(2);
  });

  // ---- readSession with traces -------------------------------------------

  test('reads messages + traces when enrichWithTraces is true', async () => {
    const msgDocs = makeMongoMessageDocs(2);
    const traceRows = makeTraceRows();

    mockFind.mockReturnValueOnce(mongooseChain(msgDocs));
    mockQuery.mockResolvedValueOnce(chResult(traceRows));

    mockDecryptForTenantAuto.mockImplementation(async (data: string) => {
      if (data === 'encrypted-tool-data') {
        return JSON.stringify({
          toolName: 'lookupBill',
          arguments: { accountId: '123' },
          result: { status: 'paid' },
          success: true,
        });
      }
      if (data === 'encrypted-escalation-data') {
        return JSON.stringify({
          reason: 'Customer requested supervisor',
          severity: 'medium',
        });
      }
      return `decrypted-${data}`;
    });

    const result = await reader.readSession('tenant-1', 'sess-1', {
      enrichWithTraces: true,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe('lookupBill');
    expect(result.toolCalls[0].arguments).toEqual({ accountId: '123' });
    expect(result.toolCalls[0].success).toBe(true);
    expect(result.toolCalls[0].durationMs).toBe(150);
    expect(result.escalations).toHaveLength(1);
    expect(result.escalations[0].reason).toBe('Customer requested supervisor');
    expect(result.escalations[0].severity).toBe('medium');
  });

  test('reads plain JSON trace data without decryption fallback', async () => {
    const msgDocs = makeMongoMessageDocs(1);
    const plainJsonTraceRows = [
      {
        session_id: 'sess-1',
        event_type: 'tool.call.completed',
        agent_name: 'BillingAgent',
        data: JSON.stringify({
          toolName: 'getBalance',
          arguments: { userId: 'u1' },
          result: { balance: 100 },
          success: true,
        }),
        timestamp: new Date().toISOString(),
        duration_ms: 80,
        has_error: 0,
      },
    ];

    mockFind.mockReturnValueOnce(mongooseChain(msgDocs));
    mockQuery.mockResolvedValueOnce(chResult(plainJsonTraceRows));

    mockDecryptForTenantAuto.mockImplementation(async (data: string) => `decrypted-${data}`);

    const result = await reader.readSession('tenant-1', 'sess-1', {
      enrichWithTraces: true,
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe('getBalance');
    expect(result.toolCalls[0].arguments).toEqual({ userId: 'u1' });
    expect(result.toolCalls[0].success).toBe(true);
    expect(result.toolCalls[0].durationMs).toBe(80);
  });

  // ---- readBatch ----------------------------------------------------------

  test('readBatch processes multiple sessions', async () => {
    const sess1Docs = makeMongoMessageDocs(2, 'sess-1');
    const sess2Docs = makeMongoMessageDocs(3, 'sess-2');

    mockFind.mockReturnValueOnce(mongooseChain([...sess1Docs, ...sess2Docs]));
    mockDecryptForTenantAuto.mockImplementation(async (data: string) => `decrypted-${data}`);

    const results = await reader.readBatch('tenant-1', ['sess-1', 'sess-2']);

    expect(results.size).toBe(2);
    expect(results.get('sess-1')).toBeDefined();
    expect(results.get('sess-2')).toBeDefined();
    expect(results.get('sess-1')!.messages).toHaveLength(2);
    expect(results.get('sess-2')!.messages).toHaveLength(3);
    expect(mockFind).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      sessionId: { $in: ['sess-1', 'sess-2'] },
    });
  });

  test('readBatch returns empty map for empty session list', async () => {
    const results = await reader.readBatch('tenant-1', []);

    expect(results.size).toBe(0);
    expect(mockFind).not.toHaveBeenCalled();
  });

  // ---- formatTranscript ---------------------------------------------------

  test('formats transcript as human-readable string', async () => {
    const docs = makeMongoMessageDocs(2);
    mockFind.mockReturnValueOnce(mongooseChain(docs));
    mockDecryptForTenantAuto
      .mockResolvedValueOnce('Hello, I need help with my bill')
      .mockResolvedValueOnce('Sure, I can help you with that.');

    const result = await reader.readSession('tenant-1', 'sess-1');
    const transcript = reader.formatTranscript(result);

    expect(transcript).toContain('User: Hello, I need help with my bill');
    expect(transcript).toContain('Assistant: Sure, I can help you with that.');
  });

  test('formatTranscript handles system and tool roles', () => {
    const data = {
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      messages: [
        {
          messageId: 'msg-0',
          role: 'system' as const,
          content: 'You are a helpful assistant.',
          timestamp: new Date().toISOString(),
        },
        {
          messageId: 'msg-1',
          role: 'user' as const,
          content: 'Hi',
          timestamp: new Date().toISOString(),
        },
        {
          messageId: 'msg-2',
          role: 'assistant' as const,
          content: 'Hello!',
          timestamp: new Date().toISOString(),
        },
        {
          messageId: 'msg-3',
          role: 'tool' as const,
          content: 'Tool result data',
          timestamp: new Date().toISOString(),
        },
      ],
      toolCalls: [],
      escalations: [],
      metadata: { messageCount: 4 },
    };

    const transcript = reader.formatTranscript(data);

    expect(transcript).toContain('System: You are a helpful assistant.');
    expect(transcript).toContain('User: Hi');
    expect(transcript).toContain('Assistant: Hello!');
    expect(transcript).toContain('Tool: Tool result data');
  });

  // ---- Decryption failure -------------------------------------------------

  test('fails closed when message decryption fails', async () => {
    const docs = makeMongoMessageDocs(2);
    mockFind.mockReturnValueOnce(mongooseChain(docs));

    // First call succeeds, second throws
    mockDecryptForTenantAuto
      .mockResolvedValueOnce('decrypted content')
      .mockRejectedValueOnce(new Error('Decryption failed: invalid key'));

    await expect(reader.readSession('tenant-1', 'sess-1')).rejects.toThrow(
      'Message content unavailable after decryption for message msg-1',
    );
  });

  test('fails closed when the Mongo encryption plugin nulls message content', async () => {
    const docs = makeMongoMessageDocs(1);
    docs[0].content = null as unknown as string;
    mockFind.mockReturnValueOnce(mongooseChain(docs));

    await expect(reader.readSession('tenant-1', 'sess-1')).rejects.toThrow(
      'Message content unavailable after decryption for message msg-0',
    );
  });

  test('handles trace decryption failure gracefully', async () => {
    const msgDocs = makeMongoMessageDocs(1);
    const traceRows = [
      {
        session_id: 'sess-1',
        event_type: 'tool.call.completed',
        agent_name: 'Agent',
        data: 'bad-encrypted-data',
        timestamp: new Date().toISOString(),
        duration_ms: 100,
        has_error: 0,
      },
    ];

    mockFind.mockReturnValueOnce(mongooseChain(msgDocs));
    mockQuery.mockResolvedValueOnce(chResult(traceRows));

    mockDecryptForTenantAuto.mockImplementation(async (data: string) => `decrypted-${data}`);

    const result = await reader.readSession('tenant-1', 'sess-1', {
      enrichWithTraces: true,
    });

    // Message should be fine, but the broken trace should be skipped
    expect(result.messages).toHaveLength(1);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.escalations).toHaveLength(0);
  });

  test('renders trace tool arguments through the pipeline PII read boundary', async () => {
    const msgDocs = makeMongoMessageDocs(1);
    const plainJsonTraceRows = [
      {
        session_id: 'sess-1',
        event_type: 'tool.call.completed',
        agent_name: 'BillingAgent',
        data: JSON.stringify({
          toolName: 'sendReceipt',
          arguments: { email: 'john.doe@gmail.com' },
          result: { status: 'sent', email: 'john.doe@gmail.com' },
          success: true,
        }),
        timestamp: new Date().toISOString(),
        duration_ms: 80,
        has_error: 0,
      },
    ];

    mockFind.mockReturnValueOnce(mongooseChain(msgDocs));
    mockQuery.mockResolvedValueOnce(chResult(plainJsonTraceRows));
    mockDecryptForTenantAuto.mockImplementation(async (data: string) => `decrypted-${data}`);

    const result = await reader.readSession('tenant-1', 'sess-1', {
      enrichWithTraces: true,
    });

    expect(result.toolCalls[0].arguments.email).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
    expect(JSON.stringify(result.toolCalls[0])).not.toContain('john.doe@gmail.com');
  });
});
