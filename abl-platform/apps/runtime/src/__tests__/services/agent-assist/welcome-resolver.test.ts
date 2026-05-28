import { describe, expect, it } from 'vitest';
import type { AgentIR } from '@abl/compiler';
import { DEFAULT_MESSAGES } from '@abl/compiler';
import { resolveWelcomeTextFromIR } from '../../../services/agent-assist/welcome-resolver.js';

function makeIR(overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    ...(overrides as AgentIR),
  } as AgentIR;
}

describe('resolveWelcomeTextFromIR', () => {
  it('returns on_start.respond when present and static', () => {
    const ir = makeIR({ on_start: { respond: 'Welcome to ACME Support!' } });
    expect(resolveWelcomeTextFromIR(ir)).toBe('Welcome to ACME Support!');
  });

  it('falls through on_start.respond with unresolved {{placeholders}}', () => {
    const ir = makeIR({
      on_start: { respond: 'Hi {{user.name}}, welcome!' },
      messages: { greeting: 'Hello!' } as AgentIR['messages'],
    });
    expect(resolveWelcomeTextFromIR(ir)).toBe('Hello!');
  });

  it('falls through on_start.respond when blank/whitespace', () => {
    const ir = makeIR({
      on_start: { respond: '   ' },
      messages: { greeting: 'Howdy!' } as AgentIR['messages'],
    });
    expect(resolveWelcomeTextFromIR(ir)).toBe('Howdy!');
  });

  it('uses messages.greeting when on_start.respond is absent', () => {
    const ir = makeIR({
      messages: { greeting: 'Good day.' } as AgentIR['messages'],
    });
    expect(resolveWelcomeTextFromIR(ir)).toBe('Good day.');
  });

  it('falls through messages.greeting with placeholders', () => {
    const ir = makeIR({
      messages: { greeting: 'Hi {{user.first_name}}!' } as AgentIR['messages'],
    });
    expect(resolveWelcomeTextFromIR(ir)).toBe(DEFAULT_MESSAGES.greeting);
  });

  it('returns platform default when neither source is configured', () => {
    const ir = makeIR({});
    expect(resolveWelcomeTextFromIR(ir)).toBe(DEFAULT_MESSAGES.greeting);
  });

  it('returns platform default when on_start exists without respond', () => {
    const ir = makeIR({ on_start: { call: 'check_returning_user' } });
    expect(resolveWelcomeTextFromIR(ir)).toBe(DEFAULT_MESSAGES.greeting);
  });
});
