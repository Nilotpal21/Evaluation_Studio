import { describe, it, expect } from 'vitest';
import { extractReplyText } from '../../../services/email/email-reply-parser.js';

describe('extractReplyText', () => {
  it('returns full text when there is no quoted content', () => {
    const text = 'Hello, I need help with my account.';
    expect(extractReplyText(text)).toBe(text);
  });

  it('strips "On ... wrote:" quoted blocks', () => {
    const text = [
      'Thanks for the info!',
      '',
      'On Mon, Jun 1, 2026 at 9:00 AM Agent <agent@co.com> wrote:',
      '> I can help you with that.',
      '> What is your account number?',
    ].join('\n');

    const result = extractReplyText(text);
    expect(result).toBe('Thanks for the info!');
  });

  it('strips email signatures (-- delimiter)', () => {
    const text = [
      'Sure, my account is 12345.',
      '',
      '--',
      'John Doe',
      'VP of Sales',
      'john@company.com',
    ].join('\n');

    const result = extractReplyText(text);
    expect(result).toBe('Sure, my account is 12345.');
  });

  it('strips "Sent from my iPhone" signatures', () => {
    const text = ['Yes please proceed.', '', 'Sent from my iPhone'].join('\n');
    const result = extractReplyText(text);
    expect(result).toBe('Yes please proceed.');
  });

  it('returns original text if parser returns empty', () => {
    const text = '> This is all quoted content\n> No original reply';
    const result = extractReplyText(text);
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles empty input', () => {
    expect(extractReplyText('')).toBe('');
  });

  it('handles undefined/null gracefully', () => {
    expect(extractReplyText(undefined as any)).toBe('');
    expect(extractReplyText(null as any)).toBe('');
  });
});
