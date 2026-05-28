/**
 * Tests for truncateOldToolResults — staleness-based tool result truncation.
 */

import { describe, it, expect } from 'vitest';
import { truncateOldToolResults } from '../services/execution/reasoning-executor.js';

/** Build a tool-result user message for a given iteration */
function makeToolResultMsg(toolName: string, content: string, toolUseId = 'tool_use_1') {
  return {
    role: 'user' as const,
    content: [
      {
        type: 'tool_result' as const,
        tool_use_id: toolUseId,
        content,
      },
    ],
  };
}

/** Build an assistant message with tool_use */
function makeAssistantMsg(text = '') {
  return {
    role: 'assistant' as const,
    content: text || [{ type: 'tool_use', id: 'tool_use_1', name: 'some_tool', input: {} }],
  };
}

/** Build a plain user text message */
function makeUserMsg(text: string) {
  return { role: 'user' as const, content: text };
}

describe('truncateOldToolResults', () => {
  it('does nothing when currentIteration <= keepRecent', () => {
    const messages = [
      makeUserMsg('Hello'),
      makeAssistantMsg(),
      makeToolResultMsg('check_balance', '{"balance": 1000}'),
    ];
    const original = JSON.parse(JSON.stringify(messages));
    truncateOldToolResults(messages, 1, 2);
    expect(messages).toEqual(original);
  });

  it('does nothing when currentIteration equals keepRecent', () => {
    const messages = [
      makeUserMsg('Hello'),
      makeAssistantMsg(),
      makeToolResultMsg('check_balance', '{"balance": 1000}'),
      makeAssistantMsg(),
      makeToolResultMsg('get_details', '{"name": "Alice"}'),
    ];
    const original = JSON.parse(JSON.stringify(messages));
    truncateOldToolResults(messages, 2, 2);
    expect(messages).toEqual(original);
  });

  it('truncates oldest tool result when iteration exceeds keepRecent', () => {
    const messages = [
      makeUserMsg('Hello'),
      makeAssistantMsg(),
      makeToolResultMsg('check_balance', '{"balance": 1000}'),
      makeAssistantMsg(),
      makeToolResultMsg('get_details', '{"name": "Alice"}'),
      makeAssistantMsg(),
      makeToolResultMsg('update_record', '{"success": true}'),
    ];

    truncateOldToolResults(messages, 3, 2);

    // Oldest (first) tool result should be truncated
    const firstToolResult = (messages[2].content as any[])[0];
    expect(firstToolResult.content).toBe('[Result available — see earlier in conversation]');

    // Recent tool results should be intact
    const secondToolResult = (messages[4].content as any[])[0];
    expect(secondToolResult.content).toBe('{"name": "Alice"}');

    const thirdToolResult = (messages[6].content as any[])[0];
    expect(thirdToolResult.content).toBe('{"success": true}');
  });

  it('truncates multiple old results on iteration 5 with keepRecent=2', () => {
    const messages = [
      makeUserMsg('Hello'),
      makeAssistantMsg(),
      makeToolResultMsg('tool_1', 'result_1'),
      makeAssistantMsg(),
      makeToolResultMsg('tool_2', 'result_2'),
      makeAssistantMsg(),
      makeToolResultMsg('tool_3', 'result_3'),
      makeAssistantMsg(),
      makeToolResultMsg('tool_4', 'result_4'),
      makeAssistantMsg(),
      makeToolResultMsg('tool_5', 'result_5'),
    ];

    truncateOldToolResults(messages, 5, 2);

    // Iterations 1-3 should be truncated (oldest 3)
    expect((messages[2].content as any[])[0].content).toBe(
      '[Result available — see earlier in conversation]',
    );
    expect((messages[4].content as any[])[0].content).toBe(
      '[Result available — see earlier in conversation]',
    );
    expect((messages[6].content as any[])[0].content).toBe(
      '[Result available — see earlier in conversation]',
    );

    // Iterations 4-5 should be intact (most recent 2)
    expect((messages[8].content as any[])[0].content).toBe('result_4');
    expect((messages[10].content as any[])[0].content).toBe('result_5');
  });

  it('preserves tool_use_id in truncated results', () => {
    const messages = [
      makeUserMsg('Hello'),
      makeAssistantMsg(),
      makeToolResultMsg('check_balance', '{"balance": 1000}', 'use_abc123'),
      makeAssistantMsg(),
      makeToolResultMsg('get_details', '{"name": "Alice"}'),
      makeAssistantMsg(),
      makeToolResultMsg('update_record', '{"success": true}'),
    ];

    truncateOldToolResults(messages, 3, 2);

    const firstToolResult = (messages[2].content as any[])[0];
    expect(firstToolResult.tool_use_id).toBe('use_abc123');
    expect(firstToolResult.type).toBe('tool_result');
  });

  it('handles multiple tool results in a single message (parallel tool calls)', () => {
    const messages = [
      makeUserMsg('Hello'),
      makeAssistantMsg(),
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result', tool_use_id: 'id_1', content: 'result_a' },
          { type: 'tool_result', tool_use_id: 'id_2', content: 'result_b' },
        ],
      },
      makeAssistantMsg(),
      makeToolResultMsg('recent_tool', 'recent_result'),
      makeAssistantMsg(),
      makeToolResultMsg('latest_tool', 'latest_result'),
    ];

    truncateOldToolResults(messages, 3, 2);

    // Both results in the old parallel message should be truncated
    const parallelResults = messages[2].content as any[];
    expect(parallelResults[0].content).toBe('[Result available — see earlier in conversation]');
    expect(parallelResults[1].content).toBe('[Result available — see earlier in conversation]');

    // Recent results intact
    expect((messages[4].content as any[])[0].content).toBe('recent_result');
    expect((messages[6].content as any[])[0].content).toBe('latest_result');
  });

  it('skips plain text user messages', () => {
    const messages = [
      makeUserMsg('Hello'),
      makeAssistantMsg(),
      makeToolResultMsg('tool_1', 'result_1'),
      makeUserMsg('Follow up question'),
      makeAssistantMsg(),
      makeToolResultMsg('tool_2', 'result_2'),
      makeAssistantMsg(),
      makeToolResultMsg('tool_3', 'result_3'),
    ];

    truncateOldToolResults(messages, 3, 2);

    // Only first tool result should be truncated
    expect((messages[2].content as any[])[0].content).toBe(
      '[Result available — see earlier in conversation]',
    );

    // Plain text user message unchanged
    expect(messages[3].content).toBe('Follow up question');

    // Recent tool results intact
    expect((messages[5].content as any[])[0].content).toBe('result_2');
    expect((messages[7].content as any[])[0].content).toBe('result_3');
  });

  it('handles empty messages array', () => {
    const messages: any[] = [];
    truncateOldToolResults(messages, 3, 2);
    expect(messages).toEqual([]);
  });

  it('uses default keepRecent of 2', () => {
    const messages = [
      makeUserMsg('Hello'),
      makeAssistantMsg(),
      makeToolResultMsg('tool_1', 'result_1'),
      makeAssistantMsg(),
      makeToolResultMsg('tool_2', 'result_2'),
      makeAssistantMsg(),
      makeToolResultMsg('tool_3', 'result_3'),
    ];

    // Call without explicit keepRecent — should default to 2
    truncateOldToolResults(messages, 3);

    expect((messages[2].content as any[])[0].content).toBe(
      '[Result available — see earlier in conversation]',
    );
    expect((messages[4].content as any[])[0].content).toBe('result_2');
    expect((messages[6].content as any[])[0].content).toBe('result_3');
  });
});
