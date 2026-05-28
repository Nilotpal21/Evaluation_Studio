import { describe, it, expect } from 'vitest';
import { EmailCatalog, formatEmailMessage } from '../emails.js';

describe('EmailCatalog', () => {
  it('has all required keys', () => {
    const required = [
      'PLATFORM_NAME',
      'FOOTER',
      'GREETING',
      'GREETING_DEFAULT',
      'VERIFY_SUBJECT',
      'VERIFY_BODY',
      'VERIFY_BUTTON',
      'VERIFY_CODE_PROMPT',
      'VERIFY_EXPIRY',
      'RESET_SUBJECT',
      'RESET_BODY',
      'RESET_BUTTON',
      'RESET_EXPIRY',
      'INVITE_SUBJECT',
      'INVITE_BODY',
      'INVITE_BUTTON',
      'INVITE_EXPIRY',
    ];
    for (const key of required) {
      expect(EmailCatalog).toHaveProperty(key);
    }
  });

  it('all values are non-empty strings', () => {
    for (const [key, value] of Object.entries(EmailCatalog)) {
      expect(value, `${key} should be a non-empty string`).toBeTruthy();
      expect(typeof value).toBe('string');
    }
  });
});

describe('formatEmailMessage', () => {
  it('returns plain string for parameterless keys', () => {
    const result = formatEmailMessage('VERIFY_SUBJECT');
    expect(result).toBe('Verify your email address');
  });

  it('interpolates parameters', () => {
    const result = formatEmailMessage('GREETING', { name: 'Alice' });
    expect(result).toBe('Hi Alice,');
  });

  it('interpolates multiple parameters', () => {
    const result = formatEmailMessage('INVITE_SUBJECT', {
      inviterName: 'Bob',
      workspaceName: 'Acme',
    });
    expect(result).toBe('Bob invited you to Acme');
  });

  it('defaults to English locale', () => {
    const result = formatEmailMessage('GREETING_DEFAULT');
    expect(result).toBe('Hi,');
  });
});
