import { describe, it, expect, beforeEach } from 'vitest';
import {
  PIIVault,
  maskValue,
  type PIIConsumer,
} from '@abl/compiler/platform/security/pii-vault.js';

describe('PIIVault session integration', () => {
  let vault: PIIVault;

  beforeEach(() => {
    vault = new PIIVault();
  });

  // ---------------------------------------------------------------------------
  // 1. tokenize / detokenize round-trip
  // ---------------------------------------------------------------------------
  it('tokenizes input and detokenizes for tools', () => {
    const input = 'Call me at 555-123-4567 please';
    const { text: tokenized, tokens } = vault.tokenize(input);

    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('phone');
    expect(tokens[0].original).toBe('555-123-4567');
    expect(tokenized).toContain('{{PII:phone:');
    expect(tokenized).not.toContain('555-123-4567');

    // detokenize restores original
    const restored = vault.detokenize(tokenized);
    expect(restored).toBe(input);
  });

  // ---------------------------------------------------------------------------
  // 2. renderForConsumer — logs (redacted)
  // ---------------------------------------------------------------------------
  it('renders redacted view for logs', () => {
    const { text: tokenized } = vault.tokenize('Email: alice@example.com');

    const logView = vault.renderForConsumer(tokenized, 'logs');
    expect(logView).toBe('Email: [REDACTED_EMAIL]');
    expect(logView).not.toContain('alice');
  });

  // ---------------------------------------------------------------------------
  // 3. renderForConsumer — user (masked)
  // ---------------------------------------------------------------------------
  it('renders masked view for user', () => {
    const { text: tokenized } = vault.tokenize('Phone: 555-123-4567');

    const userView = vault.renderForConsumer(tokenized, 'user');
    expect(userView).toBe('Phone: ***-***-4567');
  });

  // ---------------------------------------------------------------------------
  // 4. clear clears all tokens
  // ---------------------------------------------------------------------------
  it('clears all tokens from vault', () => {
    vault.tokenize('SSN is 123-45-6789');
    expect(vault.getTokenCount()).toBe(1);

    vault.clear();
    expect(vault.getTokenCount()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 5. renderForConsumer — llm (token as-is)
  // ---------------------------------------------------------------------------
  it('renders token as-is for llm consumer', () => {
    const { text: tokenized } = vault.tokenize('SSN is 123-45-6789');

    const llmView = vault.renderForConsumer(tokenized, 'llm');
    expect(llmView).toBe(tokenized);
    expect(llmView).toContain('{{PII:ssn:');
  });

  // ---------------------------------------------------------------------------
  // 6. SSN tokenization and per-consumer rendering
  // ---------------------------------------------------------------------------
  it('handles SSN tokenization and per-consumer rendering', () => {
    const input = 'My SSN is 123-45-6789';
    const { text: tokenized, tokens } = vault.tokenize(input);

    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('ssn');
    expect(tokens[0].original).toBe('123-45-6789');

    // tools: safe redacted default (ABLP-535: confirmed 'tools' → 'redacted' is the secure default)
    expect(vault.renderForConsumer(tokenized, 'tools')).toBe('My SSN is [REDACTED_SSN]');
    // user: masked
    expect(vault.renderForConsumer(tokenized, 'user')).toBe('My SSN is ***-**-****');
    // logs: redacted
    expect(vault.renderForConsumer(tokenized, 'logs')).toBe('My SSN is [REDACTED_SSN]');
    // llm: token
    expect(vault.renderForConsumer(tokenized, 'llm')).toBe(tokenized);
  });

  // ---------------------------------------------------------------------------
  // 7. credit card tokenization and per-consumer rendering
  // ---------------------------------------------------------------------------
  it('handles credit card tokenization and per-consumer rendering', () => {
    // Visa test number that passes Luhn check
    const input = 'Card: 4111 1111 1111 1111';
    const { text: tokenized, tokens } = vault.tokenize(input);

    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('credit_card');

    expect(vault.renderForConsumer(tokenized, 'tools')).toBe('Card: [REDACTED_CARD]');
    expect(vault.renderForConsumer(tokenized, 'user')).toBe('Card: ****-****-****-1111');
    expect(vault.renderForConsumer(tokenized, 'logs')).toBe('Card: [REDACTED_CARD]');
    expect(vault.renderForConsumer(tokenized, 'llm')).toBe(tokenized);
  });

  // ---------------------------------------------------------------------------
  // 8. IP address tokenization and per-consumer rendering
  // ---------------------------------------------------------------------------
  it('handles IP address tokenization and per-consumer rendering', () => {
    const input = 'Server at 192.168.1.100';
    const { text: tokenized, tokens } = vault.tokenize(input);

    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('ip_address');

    expect(vault.renderForConsumer(tokenized, 'tools')).toBe('Server at [REDACTED_IP]');
    expect(vault.renderForConsumer(tokenized, 'user')).toBe('Server at ***.***.***.***');
    expect(vault.renderForConsumer(tokenized, 'logs')).toBe('Server at [REDACTED_IP]');
    expect(vault.renderForConsumer(tokenized, 'llm')).toBe(tokenized);
  });

  // ---------------------------------------------------------------------------
  // 9. tokenize with exemptions
  // ---------------------------------------------------------------------------
  it('tokenizes with exemptions and renders correctly', () => {
    const input = 'Email alice@example.com and SSN 123-45-6789';
    const { text: tokenized, tokens } = vault.tokenize(input, new Set(['email']));

    // email is exempt — only SSN should be tokenized
    const ssnTokens = tokens.filter((t) => t.type === 'ssn');
    const emailTokens = tokens.filter((t) => t.type === 'email');
    expect(ssnTokens).toHaveLength(1);
    expect(emailTokens).toHaveLength(0);

    // email preserved in plain text, SSN tokenized
    expect(tokenized).toContain('alice@example.com');
    expect(tokenized).toContain('{{PII:ssn:');

    // tools view uses the safe redacted default, while exempted email stays unchanged
    const toolsView = vault.renderForConsumer(tokenized, 'tools');
    expect(toolsView).toContain('alice@example.com');
    expect(toolsView).toContain('[REDACTED_SSN]');
    expect(toolsView).not.toContain('123-45-6789');
  });

  // ---------------------------------------------------------------------------
  // 10. detokenize after clear returns tokens unchanged
  // ---------------------------------------------------------------------------
  it('detokenize after clear returns tokens unchanged', () => {
    const { text: tokenized } = vault.tokenize('Phone: 555-123-4567');
    vault.clear();

    // tokens are gone — detokenize cannot resolve, so tokens stay as-is
    const result = vault.detokenize(tokenized);
    expect(result).toBe(tokenized);
    expect(result).toContain('{{PII:phone:');
  });

  // ---------------------------------------------------------------------------
  // Additional coverage: no PII in input
  // ---------------------------------------------------------------------------
  it('returns original text unchanged when no PII is detected', () => {
    const input = 'Hello world, no secrets here';
    const { text, tokens } = vault.tokenize(input);

    expect(text).toBe(input);
    expect(tokens).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Additional coverage: renderForConsumer with unknown token id
  // ---------------------------------------------------------------------------
  it('returns token string as-is when token id is not in vault', () => {
    const fakeTokenized = 'Result: {{PII:phone:00000000-0000-0000-0000-000000000000}}';

    // none of the consumers should crash
    const consumers: PIIConsumer[] = ['llm', 'user', 'logs', 'tools'];
    for (const c of consumers) {
      const result = vault.renderForConsumer(fakeTokenized, c);
      expect(result).toBe(fakeTokenized);
    }
  });

  // ---------------------------------------------------------------------------
  // Additional coverage: multiple PII values in single input
  // ---------------------------------------------------------------------------
  it('tokenizes multiple PII values in a single input', () => {
    const input = 'Email alice@example.com, SSN 123-45-6789, IP 10.0.0.1';
    const { text: tokenized, tokens } = vault.tokenize(input);

    expect(tokens.length).toBeGreaterThanOrEqual(3);
    expect(tokenized).not.toContain('alice@example.com');
    expect(tokenized).not.toContain('123-45-6789');
    expect(tokenized).not.toContain('10.0.0.1');

    // round-trip
    const restored = vault.detokenize(tokenized);
    expect(restored).toBe(input);
  });

  // ---------------------------------------------------------------------------
  // maskValue unit tests
  // ---------------------------------------------------------------------------
  describe('maskValue', () => {
    it('masks phone with last 4 digits', () => {
      expect(maskValue('555-123-4567', 'phone')).toBe('***-***-4567');
    });

    it('masks short phone as ***', () => {
      expect(maskValue('12', 'phone')).toBe('***');
    });

    it('masks email showing first char and domain', () => {
      expect(maskValue('alice@example.com', 'email')).toBe('a***@example.com');
    });

    it('masks malformed email as ***@***', () => {
      expect(maskValue('notanemail', 'email')).toBe('***@***');
    });

    it('masks credit card with last 4 digits', () => {
      expect(maskValue('4111 1111 1111 1111', 'credit_card')).toBe('****-****-****-1111');
    });

    it('masks short credit card as ****', () => {
      expect(maskValue('12', 'credit_card')).toBe('****');
    });

    it('masks SSN as fixed pattern', () => {
      expect(maskValue('123-45-6789', 'ssn')).toBe('***-**-****');
    });

    it('masks IP address as fixed pattern', () => {
      expect(maskValue('192.168.1.1', 'ip_address')).toBe('***.***.***.***');
    });

    it('masks unknown type as ***', () => {
      // Cast to exercise default branch
      expect(maskValue('secret', 'unknown_type' as never)).toBe('***');
    });
  });

  // ---------------------------------------------------------------------------
  // getTokenCount tracks vault size
  // ---------------------------------------------------------------------------
  it('getTokenCount tracks vault size', () => {
    expect(vault.getTokenCount()).toBe(0);
    vault.tokenize('SSN 123-45-6789');
    expect(vault.getTokenCount()).toBe(1);
    vault.tokenize('Email bob@test.com');
    expect(vault.getTokenCount()).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Session integration: vault can be attached to session-like object
  // ---------------------------------------------------------------------------
  it('vault can be assigned to a session-like structure', () => {
    const session: { piiVault?: PIIVault } = {};
    session.piiVault = vault;

    const { text: tokenized } = session.piiVault.tokenize('Call 555-123-4567');
    const toolsView = session.piiVault.renderForConsumer(tokenized, 'tools');
    expect(toolsView).toBe('Call [REDACTED_PHONE]');

    session.piiVault.clear();
    expect(session.piiVault.getTokenCount()).toBe(0);
  });
});
