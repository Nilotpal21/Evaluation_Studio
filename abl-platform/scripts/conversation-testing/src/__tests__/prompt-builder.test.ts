import { describe, expect, it } from 'vitest';
import {
  buildScenarioPrompt,
  buildPersonaPrompt,
  formatHistory,
  detectEndSentinel,
} from '../prompt-builder.js';
import type { RunConfig, Scenario } from '../types.js';

describe('buildScenarioPrompt', () => {
  const baseConfig: RunConfig = {
    runs: 10,
    preset: 'balanced',
    domain: {
      projectName: 'TestBot',
      welcomeMessage: 'Welcome to TestBot! I can help with billing and support.',
    },
  };

  it('includes the project name in the prompt', () => {
    const prompt = buildScenarioPrompt(baseConfig);
    expect(prompt).toContain('TestBot');
  });

  it('includes the welcome message as domain source', () => {
    const prompt = buildScenarioPrompt(baseConfig);
    expect(prompt).toContain('Welcome to TestBot! I can help with billing and support.');
  });

  it('uses domain hint over welcome message when provided', () => {
    const config: RunConfig = {
      ...baseConfig,
      domain: {
        ...baseConfig.domain,
        hint: 'Enterprise HR chatbot for employee onboarding',
      },
    };
    const prompt = buildScenarioPrompt(config);
    expect(prompt).toContain('Enterprise HR chatbot for employee onboarding');
    // Welcome message should not be the primary domain source
    expect(prompt).not.toContain('Welcome to TestBot! I can help with billing and support.');
  });

  it('includes the preset text', () => {
    const prompt = buildScenarioPrompt(baseConfig);
    // balanced preset contains "mix of conversation styles"
    expect(prompt).toContain('mix of conversation styles');
  });

  it('includes the number of scenarios', () => {
    const prompt = buildScenarioPrompt(baseConfig);
    expect(prompt).toContain('10');
  });

  it('includes intent distribution rules with 40% cap', () => {
    const prompt = buildScenarioPrompt(baseConfig);
    // ceil(10 * 0.4) = 4
    expect(prompt).toContain('4 scenarios');
    expect(prompt).toContain('40%');
  });

  it('includes custom instructions when provided', () => {
    const config: RunConfig = {
      ...baseConfig,
      instructions: 'Focus on refunds and cancellations',
    };
    const prompt = buildScenarioPrompt(config);
    expect(prompt).toContain('Focus on refunds and cancellations');
    expect(prompt).toContain('Additional instructions');
  });

  it('does not include instructions section when absent', () => {
    const prompt = buildScenarioPrompt(baseConfig);
    expect(prompt).not.toContain('Additional instructions');
  });

  it('includes output format specification', () => {
    const prompt = buildScenarioPrompt(baseConfig);
    expect(prompt).toContain('"intent"');
    expect(prompt).toContain('"persona"');
    expect(prompt).toContain('"goal"');
    expect(prompt).toContain('"behavior"');
    expect(prompt).toContain('"endCondition"');
  });
});

describe('formatHistory', () => {
  it('returns a placeholder for empty history', () => {
    const result = formatHistory([]);
    expect(result).toContain('No messages yet');
  });

  it('formats alternating User/Agent labels correctly', () => {
    const messages = [
      { role: 'user' as const, text: 'Hello there' },
      { role: 'agent' as const, text: 'Hi! How can I help?' },
      { role: 'user' as const, text: 'I need billing help' },
    ];
    const result = formatHistory(messages);
    expect(result).toBe('User: Hello there\nAgent: Hi! How can I help?\nUser: I need billing help');
  });

  it('handles a single user message', () => {
    const result = formatHistory([{ role: 'user', text: 'Just me' }]);
    expect(result).toBe('User: Just me');
  });

  it('handles a single agent message', () => {
    const result = formatHistory([{ role: 'agent', text: 'Just the bot' }]);
    expect(result).toBe('Agent: Just the bot');
  });
});

describe('buildPersonaPrompt', () => {
  const scenario: Scenario = {
    intent: 'billing_dispute',
    persona: 'Frustrated small-business owner',
    goal: 'Get a refund for an unauthorized charge',
    behavior: 'Short sentences, impatient, demands quick resolution',
    endCondition: 'When the refund is confirmed or agent escalates',
  };

  it('includes scenario fields in the prompt messages', () => {
    const result = buildPersonaPrompt(scenario, []);
    const systemContent = result[0].content;
    expect(systemContent).toContain('Frustrated small-business owner');
    expect(systemContent).toContain('Get a refund for an unauthorized charge');
    expect(systemContent).toContain('Short sentences, impatient');
    expect(systemContent).toContain('When the refund is confirmed');
  });

  it('includes formatted history in the last message', () => {
    const history = [
      { role: 'user' as const, text: 'I was charged wrongly' },
      { role: 'agent' as const, text: 'Let me look into that for you' },
    ];
    const result = buildPersonaPrompt(scenario, history);
    const lastMessage = result[result.length - 1].content;
    expect(lastMessage).toContain('User: I was charged wrongly');
    expect(lastMessage).toContain('Agent: Let me look into that for you');
  });

  it('mentions [END_CONVERSATION] sentinel in the prompt', () => {
    const result = buildPersonaPrompt(scenario, []);
    const systemContent = result[0].content;
    expect(systemContent).toContain('[END_CONVERSATION]');
  });

  it('returns an array of LLMMessage objects', () => {
    const result = buildPersonaPrompt(scenario, []);
    expect(result.length).toBeGreaterThanOrEqual(3);
    for (const msg of result) {
      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('content');
      expect(['user', 'assistant']).toContain(msg.role);
    }
  });
});

describe('detectEndSentinel', () => {
  it('matches [END_CONVERSATION] in uppercase', () => {
    expect(detectEndSentinel('[END_CONVERSATION]')).toBe(true);
  });

  it('matches [end conversation] in lowercase with space', () => {
    expect(detectEndSentinel('[end conversation]')).toBe(true);
  });

  it('matches [End_Conversation] in mixed case with underscore', () => {
    expect(detectEndSentinel('[End_Conversation]')).toBe(true);
  });

  it('matches [ENDCONVERSATION] with no separator', () => {
    expect(detectEndSentinel('[ENDCONVERSATION]')).toBe(true);
  });

  it('matches sentinel embedded in surrounding text', () => {
    expect(detectEndSentinel('Thanks for the help! [END_CONVERSATION]')).toBe(true);
  });

  it('rejects END CONVERSATION without brackets', () => {
    expect(detectEndSentinel('END CONVERSATION')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(detectEndSentinel('')).toBe(false);
  });

  it('rejects partial match without closing bracket', () => {
    expect(detectEndSentinel('[END_CONVERSATION')).toBe(false);
  });

  it('rejects partial match without opening bracket', () => {
    expect(detectEndSentinel('END_CONVERSATION]')).toBe(false);
  });
});
