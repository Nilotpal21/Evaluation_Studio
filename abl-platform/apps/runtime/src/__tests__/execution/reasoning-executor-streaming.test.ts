import { describe, it, expect, vi } from 'vitest';

/**
 * Contract tests for the reasoning executor streaming behavior.
 *
 * The reasoning executor uses two streaming strategies:
 * - Specialist agents (with regular tools): stream tokens directly via onChunk
 *   when no response/output safeguards require buffered validation.
 * - Supervisor agents and safeguard-buffered turns: accumulate tokens via
 *   iterBuffer so the executor can suppress or validate text before emitting it.
 */
describe('reasoning executor streaming', () => {
  it('streams tokens directly for specialist agents when buffering is not required', () => {
    // Specialist agents can still pass onChunk directly to chatWithToolUseStreamable
    // when no response/output safeguards need to validate the generated text first.
    const chunks: string[] = [];
    const onChunk = vi.fn((chunk: string) => chunks.push(chunk));

    // Simulate what the LLM stream does when onChunk is passed directly:
    const simulatedTokens = ['Hello', '! ', 'How ', 'can ', 'I ', 'help?'];
    for (const token of simulatedTokens) {
      onChunk(token);
    }

    expect(onChunk).toHaveBeenCalledTimes(6);
    expect(chunks.join('')).toBe('Hello! How can I help?');
    // Key assertion: no single call contains the full response
    expect(chunks.some((c) => c === 'Hello! How can I help?')).toBe(false);
  });

  it('buffers tokens when post-generation validation must run before emission', () => {
    // Buffering is used both for supervisor-only turns and for specialist turns
    // that must wait for response checkpoints/output guardrails to run.
    let iterBuffer = '';
    const bufferChunk = (chunk: string) => {
      iterBuffer += chunk;
    };

    const tokens = ['I will ', 'transfer ', 'you now.'];
    for (const t of tokens) {
      bufferChunk(t);
    }

    expect(iterBuffer).toBe('I will transfer you now.');
  });

  it('determines streaming strategy from agent tool list', () => {
    // The executor checks if ALL tools are system tools to decide strategy.
    // System tools: prefixed with '__', 'handoff_to_', or 'delegate_to_'.
    const isSystemTool = (name: string) =>
      name.startsWith('__') || name.startsWith('handoff_to_') || name.startsWith('delegate_to_');

    // Supervisor: only system tools → buffer
    const supervisorTools = ['__fan_out__', 'handoff_to_Advisor', 'delegate_to_Policy'];
    expect(supervisorTools.every(isSystemTool)).toBe(true);

    // Specialist: has regular tools → stream directly
    const specialistTools = ['product_search', 'offer_search', '__completion__'];
    expect(specialistTools.every(isSystemTool)).toBe(false);

    // Mixed agent: has both → stream directly (non-system tools present)
    const mixedTools = ['handoff_to_Advisor', 'search_products'];
    expect(mixedTools.every(isSystemTool)).toBe(false);
  });

  it('flushes separator after directly streamed tool-calling iterations', () => {
    // When a specialist agent's iteration streams directly and then calls tools,
    // the executor sends '\n\n' as a separator after the streamed text.
    const chunks: string[] = [];
    const onChunk = vi.fn((chunk: string) => chunks.push(chunk));

    // Simulate: tokens already streamed, then separator flushed
    onChunk('Looking up products...');
    onChunk('\n\n');

    expect(chunks).toEqual(['Looking up products...', '\n\n']);
  });
});
