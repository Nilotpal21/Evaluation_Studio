import { describe, test, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

const mockGenerateText = vi.fn();
vi.mock('../pipeline/services/llm-client-factory.js', () => ({
  PipelineLLMResolutionError: class PipelineLLMResolutionError extends Error {},
  isPipelineLLMResolutionError: () => false,
  resolvePipelineLLM: () =>
    Promise.resolve({
      provider: 'openai',
      modelId: 'gpt-4o-mini',
      apiKey: 'test-key',
      source: 'tenant' as const,
    }),
}));
vi.mock('@agent-platform/llm', () => ({
  createVercelProvider: () => 'mock-model',
  generateText: (...args: any[]) => mockGenerateText(...args),
}));

const mockQuery = vi.fn();
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({ query: mockQuery }),
}));

vi.mock('../pipeline/services/semantic-layer.js', () => ({
  getSemanticLayerPrompt: () => 'Mock schema context for testing',
}));

const { validateSQL, NLQueryService } = await import('../pipeline/services/nl-query.service.js');

// ---------------------------------------------------------------------------
// validateSQL — pure function tests
// ---------------------------------------------------------------------------

describe('validateSQL', () => {
  test('accepts valid SELECT with tenant_id filter', () => {
    const sql =
      "SELECT avg(avg_sentiment) FROM abl_platform.conversation_sentiment WHERE tenant_id = 'acme'";
    expect(validateSQL(sql)).toBeNull();
  });

  test('rejects INSERT statement', () => {
    const sql = "INSERT INTO abl_platform.conversation_sentiment VALUES ('acme', 'proj', 'sess')";
    const result = validateSQL(sql);
    expect(result).not.toBeNull();
    expect(result).toContain('Only SELECT queries are allowed');
  });

  test('rejects DROP TABLE statement', () => {
    const sql = 'DROP TABLE abl_platform.conversation_sentiment';
    const result = validateSQL(sql);
    expect(result).not.toBeNull();
    expect(result).toContain('Only SELECT queries are allowed');
  });

  test('rejects DELETE statement', () => {
    const sql = "DELETE FROM abl_platform.conversation_sentiment WHERE tenant_id = 'acme'";
    const result = validateSQL(sql);
    expect(result).not.toBeNull();
    expect(result).toContain('Only SELECT queries are allowed');
  });

  test('rejects query without tenant_id filter', () => {
    const sql = 'SELECT count() FROM abl_platform.conversation_sentiment';
    const result = validateSQL(sql);
    expect(result).not.toBeNull();
    expect(result).toContain('tenant_id');
  });

  test('rejects UPDATE statement', () => {
    const sql =
      "UPDATE abl_platform.conversation_sentiment SET avg_sentiment = 0.5 WHERE tenant_id = 'acme'";
    const result = validateSQL(sql);
    expect(result).not.toBeNull();
    expect(result).toContain('Only SELECT queries are allowed');
  });

  test('rejects SELECT with embedded DROP', () => {
    const sql =
      "SELECT 1; DROP TABLE abl_platform.conversation_sentiment; -- WHERE tenant_id = 'acme'";
    const result = validateSQL(sql);
    expect(result).not.toBeNull();
    expect(result).toContain('Forbidden SQL operation');
  });

  test('rejects SELECT INTO', () => {
    const sql =
      "SELECT * INTO new_table FROM abl_platform.conversation_sentiment WHERE tenant_id = 'acme'";
    const result = validateSQL(sql);
    expect(result).not.toBeNull();
    expect(result).toContain('Forbidden SQL operation');
  });

  test('rejects TRUNCATE', () => {
    const sql = 'TRUNCATE TABLE abl_platform.conversation_sentiment';
    const result = validateSQL(sql);
    expect(result).not.toBeNull();
  });

  test('accepts SELECT with leading whitespace and tenant_id filter', () => {
    const sql =
      "  SELECT count() FROM abl_platform.conversation_sentiment WHERE tenant_id = 'acme'";
    expect(validateSQL(sql)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NLQueryService — integration tests with mocks
// ---------------------------------------------------------------------------

describe('NLQueryService', () => {
  let service: InstanceType<typeof NLQueryService>;

  beforeEach(() => {
    mockGenerateText.mockReset();
    mockQuery.mockReset();
    service = new NLQueryService();
  });

  test('generates and executes valid SQL', async () => {
    const generatedSQL =
      "SELECT avg(avg_sentiment) AS avg_sent FROM abl_platform.conversation_sentiment WHERE tenant_id = 'acme' AND project_id = 'proj-1' LIMIT 1000";

    mockGenerateText.mockResolvedValue({
      text: generatedSQL,
      usage: { inputTokens: 500, outputTokens: 50 },
    });

    mockQuery.mockResolvedValue({
      json: async () => ({ data: [{ avg_sent: 0.72 }] }),
    });

    const result = await service.executeQuery('acme', 'proj-1', 'What is the average sentiment?');

    expect(result.question).toBe('What is the average sentiment?');
    expect(result.sql).toBe(generatedSQL);
    expect(result.data).toEqual([{ avg_sent: 0.72 }]);
    expect(result.rowCount).toBe(1);

    // Verify ClickHouse was called with the generated SQL
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0].query).toBe(generatedSQL);
    expect(mockQuery.mock.calls[0][0].clickhouse_settings.max_execution_time).toBe(30);
  });

  test('throws on LLM generating invalid SQL (INSERT)', async () => {
    mockGenerateText.mockResolvedValue({
      text: "INSERT INTO abl_platform.conversation_sentiment VALUES ('acme', 'proj', 'sess')",
      usage: { inputTokens: 500, outputTokens: 30 },
    });

    await expect(service.executeQuery('acme', 'proj-1', 'Insert some data')).rejects.toThrow(
      'SQL validation failed',
    );

    // ClickHouse should NOT have been called
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('strips markdown code blocks from LLM response', async () => {
    const rawSQL =
      "SELECT count() FROM abl_platform.conversation_sentiment WHERE tenant_id = 'acme' AND project_id = 'proj-1'";

    mockGenerateText.mockResolvedValue({
      text: '```sql\n' + rawSQL + '\n```',
      usage: { inputTokens: 500, outputTokens: 50 },
    });

    mockQuery.mockResolvedValue({
      json: async () => ({ data: [{ 'count()': 42 }] }),
    });

    const result = await service.executeQuery('acme', 'proj-1', 'How many conversations?');

    expect(result.sql).toBe(rawSQL);
    expect(result.data).toEqual([{ 'count()': 42 }]);
  });

  test('throws when LLM generates SQL without tenant_id', async () => {
    mockGenerateText.mockResolvedValue({
      text: 'SELECT count() FROM abl_platform.conversation_sentiment',
      usage: { inputTokens: 500, outputTokens: 20 },
    });

    await expect(service.executeQuery('acme', 'proj-1', 'Count all conversations')).rejects.toThrow(
      'SQL validation failed',
    );

    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('passes tenantId and projectId as query params', async () => {
    const generatedSQL =
      "SELECT count() FROM abl_platform.conversation_sentiment WHERE tenant_id = 'acme' AND project_id = 'proj-1'";

    mockGenerateText.mockResolvedValue({
      text: generatedSQL,
      usage: { inputTokens: 500, outputTokens: 30 },
    });

    mockQuery.mockResolvedValue({
      json: async () => ({ data: [{ 'count()': 10 }] }),
    });

    await service.executeQuery('acme', 'proj-1', 'Count conversations');

    expect(mockQuery.mock.calls[0][0].query_params).toEqual({
      tenantId: 'acme',
      projectId: 'proj-1',
    });
  });
});
