import { describe, expect, it } from 'vitest';
import { buildBm25Index, searchBm25, type L3Chunk } from '../knowledge/l3-search.js';

const SAMPLE_CHUNKS: L3Chunk[] = [
  {
    file: 'abl-reference/gather.mdx',
    heading: 'GATHER (information collection)',
    text: 'The GATHER section defines structured information that the agent needs to collect from the user during a conversation. Each field specifies a data type, prompt, validation rules, and collection behavior.',
    words: 30,
  },
  {
    file: 'abl-reference/flow.mdx',
    heading: 'FLOW (structured execution steps)',
    text: 'The FLOW section adds structured execution steps to any agent. It defines a step-by-step execution graph where each step declares actions and transitions to other steps.',
    words: 28,
  },
  {
    file: 'guides/memory-and-state.mdx',
    heading: 'Memory & State',
    text: 'ABL agents use two kinds of memory to track information during and across conversations. Session variables hold data within a single conversation. Persistent memory stores facts that survive across sessions.',
    words: 32,
  },
  {
    file: 'abl-reference/tools.mdx',
    heading: 'MCP tools',
    text: 'MCP Model Context Protocol tools connect to external MCP servers that provide tool definitions dynamically. The agent discovers available tools at session start from the MCP server.',
    words: 28,
  },
];

describe('L3 BM25 Search', () => {
  const index = buildBm25Index(SAMPLE_CHUNKS);

  it('builds index with correct metadata', () => {
    expect(index.N).toBe(4);
    expect(index.avgdl).toBeGreaterThan(0);
    expect(Object.keys(index.df).length).toBeGreaterThan(0);
    expect(index.chunks).toHaveLength(4);
  });

  it('returns ranked results for a gather query', () => {
    const results = searchBm25(index, 'gather collect user information fields', 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].file).toBe('abl-reference/gather.mdx');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('returns flow results for flow query', () => {
    const results = searchBm25(index, 'FLOW step execution graph transitions', 3);
    expect(results[0].file).toBe('abl-reference/flow.mdx');
  });

  it('returns memory results for memory query', () => {
    const results = searchBm25(index, 'persistent memory session variables', 3);
    expect(results[0].file).toBe('guides/memory-and-state.mdx');
  });

  it('returns MCP results for MCP query', () => {
    const results = searchBm25(index, 'MCP server tool connect', 3);
    expect(results[0].file).toBe('abl-reference/tools.mdx');
  });

  it('returns zero scores for completely unrelated query', () => {
    const results = searchBm25(index, 'xyzzy frobnicator', 3);
    expect(results.every((r) => r.score === 0)).toBe(true);
  });

  it('respects topK limit', () => {
    const results = searchBm25(index, 'agent execution steps memory tools', 2);
    expect(results).toHaveLength(2);
  });
});

describe('stopword filtering', () => {
  const STOPWORD_CHUNKS: L3Chunk[] = [
    {
      file: 'api-reference/conversation-api.mdx',
      heading: 'Conversation API',
      text: 'The conversation API provides three interaction modes: agent-backed chat, streaming LLM completions, and non-streaming completions. POST /api/v1/chat/agent sends a message to an agent.',
      words: 28,
    },
    {
      file: 'faq/faq.mdx',
      heading: 'How do I use the REST API channel?',
      text: 'How do I use the REST API channel? You can use the REST API to send messages programmatically. The API requires authentication via JWT or API key.',
      words: 28,
    },
    {
      file: 'guides/channels.mdx',
      heading: 'Channel setup',
      text: 'Configure channels for your agent including web chat, WhatsApp, SMS, and voice. Each channel has its own authentication and webhook setup requirements.',
      words: 22,
    },
  ];

  const stopwordIndex = buildBm25Index(STOPWORD_CHUNKS);

  it('ranks conversation-api above FAQ for "how to use the conversation api"', () => {
    const results = searchBm25(stopwordIndex, 'how to use the conversation api', 3);
    expect(results[0].file).toBe('api-reference/conversation-api.mdx');
  });

  it('does not treat common words as high-signal', () => {
    const results = searchBm25(stopwordIndex, 'conversation api', 3);
    expect(results[0].file).toBe('api-reference/conversation-api.mdx');
  });
});
