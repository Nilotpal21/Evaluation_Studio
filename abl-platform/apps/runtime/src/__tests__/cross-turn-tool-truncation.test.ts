import { describe, it, expect } from 'vitest';
import { truncatePriorTurnToolResults } from '../services/execution/reasoning-executor.js';
import { DEFAULT_COMPACTION_POLICY } from '../services/execution/compaction-policy.js';
import type { CompactionPolicy } from '@abl/compiler/platform/ir/schema.js';

describe('truncatePriorTurnToolResults', () => {
  function toolResultMsg(content: string, toolUseId = 'call_1') {
    return {
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: toolUseId, content }],
    };
  }

  function assistantToolCallMsg(toolName = 'product_search') {
    return {
      role: 'assistant' as const,
      content: [{ type: 'tool_use' as const, id: 'call_1', name: toolName, input: {} }],
    };
  }

  it('truncates tool results from prior turns', () => {
    const messages: Array<{ role: string; content: unknown }> = [
      // Turn 1
      { role: 'user', content: 'Show me red sneakers' },
      assistantToolCallMsg(),
      toolResultMsg('{"products": [{"title": "Sneaker 1", "price": "500"}]}'),
      { role: 'assistant', content: 'Here are sneakers...' },
      // Turn 2 (current)
      { role: 'user', content: 'What about Nike ones?' },
    ];

    truncatePriorTurnToolResults(messages);

    const toolResultBlock = (messages[2].content as any[])[0];
    expect(toolResultBlock.content).toBe('[Prior turn result — summarized]');
    expect(messages[4].content).toBe('What about Nike ones?');
  });

  it('leaves current turn tool results intact', () => {
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'Show me sneakers' },
      assistantToolCallMsg(),
      toolResultMsg('{"products": [{"title": "Sneaker 1"}]}'),
    ];

    truncatePriorTurnToolResults(messages);

    const toolResultBlock = (messages[2].content as any[])[0];
    expect(toolResultBlock.content).not.toBe('[Prior turn result — summarized]');
  });

  it('handles messages with no tool results', () => {
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Thanks' },
    ];

    truncatePriorTurnToolResults(messages);
    expect(messages).toHaveLength(3);
  });

  it('compacts assistant responses that follow truncated tool results', () => {
    const longResponse =
      'Here are the top sneakers I found for you: ' +
      '1. Nike Air Max 90 - AED 500, available in red and black. ' +
      '2. Adidas Ultraboost - AED 650, available in white. ' +
      '3. Puma RS-X - AED 400, available in blue and grey. ' +
      'All of these are currently in stock at your nearest store. ' +
      'Would you like me to check sizes for any of these?';

    const messages: Array<{ role: string; content: unknown }> = [
      // Turn 1
      { role: 'user', content: 'Show me red sneakers' },
      assistantToolCallMsg(),
      toolResultMsg('{"products": [{"title": "Sneaker 1", "price": "500"}]}'),
      { role: 'assistant', content: longResponse },
      // Turn 2 (current)
      { role: 'user', content: 'What about Nike ones?' },
    ];

    truncatePriorTurnToolResults(messages);

    // Tool result truncated
    expect((messages[2].content as any[])[0].content).toBe('[Prior turn result — summarized]');
    // Assistant response compacted
    const compacted = messages[3].content as string;
    expect(compacted).toContain(longResponse.slice(0, 200));
    expect(compacted).toContain('re-invoke tools if the user changes or refines their request');
    expect(compacted.length).toBeLessThan(longResponse.length);
  });

  it('handles multiple prior turns with tool results', () => {
    const messages: Array<{ role: string; content: unknown }> = [
      // Turn 1
      { role: 'user', content: 'Show me sneakers' },
      assistantToolCallMsg(),
      toolResultMsg('{"products": [...long result 1...]}', 'call_t1'),
      { role: 'assistant', content: 'Here are sneakers' },
      // Turn 2
      { role: 'user', content: 'Now show me offers' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_t2', name: 'offer_search', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_t2',
            content: '{"offers": [...long result 2...]}',
          },
        ],
      },
      { role: 'assistant', content: 'Here are offers' },
      // Turn 3 (current)
      { role: 'user', content: 'Tell me more about offer 1' },
    ];

    truncatePriorTurnToolResults(messages);

    // Turn 1 tool results: truncated
    expect((messages[2].content as any[])[0].content).toBe('[Prior turn result — summarized]');
    // Turn 2 tool results: truncated
    expect((messages[6].content as any[])[0].content).toBe('[Prior turn result — summarized]');
    // Turn 3 user message: untouched
    expect(messages[8].content).toBe('Tell me more about offer 1');
  });
});

describe('truncatePriorTurnToolResults with policy', () => {
  function toolResultMsg(content: string, toolUseId = 'call_1') {
    return {
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: toolUseId, content }],
    };
  }

  function assistantToolCallMsg(toolName = 'product_search') {
    return {
      role: 'assistant' as const,
      content: [{ type: 'tool_use' as const, id: 'call_1', name: toolName, input: {} }],
    };
  }

  it('does nothing when prior_turns strategy is none', () => {
    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      prior_turns: { strategy: 'none', assistant_preview_chars: 200 },
    };

    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'Show me sneakers' },
      assistantToolCallMsg(),
      toolResultMsg('{"products": [{"title": "Sneaker 1"}]}'),
      { role: 'assistant', content: 'Here are sneakers with full details...' },
      { role: 'user', content: 'What about Nike?' },
    ];

    truncatePriorTurnToolResults(messages, policy);

    // Nothing truncated
    expect((messages[2].content as any[])[0].content).toBe(
      '{"products": [{"title": "Sneaker 1"}]}',
    );
    expect(messages[3].content).toBe('Here are sneakers with full details...');
  });

  it('only truncates tool results when strategy is placeholder', () => {
    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      prior_turns: { strategy: 'placeholder', assistant_preview_chars: 200 },
    };

    const longResponse = 'A '.repeat(200);
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'Show me sneakers' },
      assistantToolCallMsg(),
      toolResultMsg('{"products": [{"title": "Sneaker 1"}]}'),
      { role: 'assistant', content: longResponse },
      { role: 'user', content: 'What about Nike?' },
    ];

    truncatePriorTurnToolResults(messages, policy);

    // Tool result truncated
    expect((messages[2].content as any[])[0].content).toBe('[Prior turn result — summarized]');
    // Assistant response NOT compacted (placeholder strategy doesn't compact assistant)
    expect(messages[3].content).toBe(longResponse);
  });

  it('uses custom assistant_preview_chars from policy', () => {
    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      prior_turns: { strategy: 'compact', assistant_preview_chars: 50 },
    };

    const longResponse = 'Here are the sneakers: ' + 'detail '.repeat(100);
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: 'Show me sneakers' },
      assistantToolCallMsg(),
      toolResultMsg('{"products": []}'),
      { role: 'assistant', content: longResponse },
      { role: 'user', content: 'What about Nike?' },
    ];

    truncatePriorTurnToolResults(messages, policy);

    const compacted = messages[3].content as string;
    // Should use 50 chars, not the default 200
    expect(compacted).toContain(longResponse.slice(0, 50));
    expect(compacted).not.toContain(longResponse.slice(0, 51));
  });
});
