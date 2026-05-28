import { describe, it, expect } from 'vitest';
import {
  executeRedact,
  executeFix,
  executeFilter,
} from '../../platform/guardrails/action-executors';

describe('Action executors', () => {
  describe('executeRedact', () => {
    it('should redact PII from content', () => {
      const result = executeRedact('My email is john@example.com', 'pii');
      expect(result).not.toContain('john@example.com');
      expect(result).toContain('[REDACTED');
    });

    it('should redact matched patterns', () => {
      const result = executeRedact(
        '<script>alert(1)</script> Hello',
        'pattern',
        '<script[^>]*>.*?</script>',
      );
      expect(result).not.toContain('<script>');
      expect(result).toContain('[REDACTED]');
    });
  });

  describe('executeFix', () => {
    it('should truncate content with truncate strategy', () => {
      const result = executeFix('Hello World Extra', 'truncate', 11);
      expect(result.length).toBeLessThanOrEqual(11);
    });

    it('should strip HTML with strip_html strategy', () => {
      const result = executeFix('<b>Hello</b> <script>bad</script>', 'strip_html');
      expect(result).not.toContain('<script>');
      expect(result).toContain('Hello');
    });

    it('should normalize with normalize strategy', () => {
      const result = executeFix('  Hello   World  \n\n\n  ', 'normalize');
      expect(result).toBe('Hello World');
    });

    it('should redact PII with redact_pii strategy', () => {
      const result = executeFix('My SSN is 123-45-6789', 'redact_pii');
      expect(result).not.toContain('123-45-6789');
    });
  });

  describe('executeFilter', () => {
    it('should remove sentences containing violations', () => {
      const result = executeFilter(
        'This is safe. This contains badword and is not. This is also safe.',
        ['badword'],
        10,
      );
      expect(result).toContain('This is safe');
      expect(result).not.toContain('badword');
    });

    it('should return null when filtered content too short', () => {
      const result = executeFilter('Only bad content here.', ['bad'], 100);
      expect(result).toBeNull();
    });
  });
});
