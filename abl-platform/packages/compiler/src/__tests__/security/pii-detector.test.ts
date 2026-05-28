/**
 * PII Detector Tests
 *
 * Tests the PII detection, redaction, and containment checking module.
 * Covers email, SSN, credit card, phone, and IP address patterns,
 * as well as multi-PII scenarios, overlap handling, and edge cases.
 */
import { describe, test, expect } from 'vitest';
import {
  detectPII,
  redactPII,
  containsPII,
  detectPIISelective,
  getPIIRedactLabel,
} from '../../platform/security/pii-detector.js';
import {
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
  registerBuiltInRecognizers,
} from '../../platform/security/pii-recognizer-registry.js';
import {
  createSafePIIDetection as createSafePIIDetectionFromSecurityBarrel,
  getPIIRedactLabel as getPIIRedactLabelFromSecurityBarrel,
} from '../../platform/security/index.js';

// =============================================================================
// 1. EMAIL DETECTION
// =============================================================================

describe('PII Detector', () => {
  describe('Public security barrel', () => {
    test('re-exports safe detection helpers', () => {
      expect(getPIIRedactLabelFromSecurityBarrel('email')).toBe('[REDACTED_EMAIL]');
      expect(createSafePIIDetectionFromSecurityBarrel('ssn', 4, 15)).toEqual({
        type: 'ssn',
        start: 4,
        end: 15,
        value: '[REDACTED_SSN]',
        confidence: 1.0,
      });
    });
  });

  describe('Email Detection', () => {
    test('detects standard email address', () => {
      const result = detectPII('Contact me at user@example.com please');
      expect(result.hasPII).toBe(true);
      expect(result.detections).toHaveLength(1);
      expect(result.detections[0].type).toBe('email');
      expect(result.detections[0].value).toBe('[REDACTED_EMAIL]');
    });

    test('detects email with dots and plus tag in local part', () => {
      const result = detectPII('Email: first.last+tag@domain.co.uk');
      expect(result.hasPII).toBe(true);
      expect(result.detections).toHaveLength(1);
      expect(result.detections[0].type).toBe('email');
      expect(result.detections[0].value).toBe('[REDACTED_EMAIL]');
    });

    test('does not trigger on @ in non-email context', () => {
      const result = detectPII('Use @mentions in chat');
      expect(result.detections.filter((d) => d.type === 'email')).toHaveLength(0);
    });
  });

  // =============================================================================
  // 2. SSN DETECTION
  // =============================================================================

  describe('SSN Detection', () => {
    test('detects standard SSN format xxx-xx-xxxx', () => {
      const result = detectPII('My SSN is 123-45-6789');
      expect(result.hasPII).toBe(true);
      expect(result.detections).toHaveLength(1);
      expect(result.detections[0].type).toBe('ssn');
      expect(result.detections[0].value).toBe('[REDACTED_SSN]');
    });

    test('matches plain 9-digit numbers without dashes (LLD D-7 detection-expanding fix)', () => {
      // Detection-expanding bug fix per LLD D-7: undashed 9-digit SSNs now
      // match. False-positive guardrails (confidence_threshold + per-project
      // context-word boost) live in the runtime — not the compiler — so the
      // raw compiler-level detection should fire.
      const result = detectPII('Account number 123456789');
      const ssnDetections = result.detections.filter((d) => d.type === 'ssn');
      expect(ssnDetections).toHaveLength(1);
    });
  });

  // =============================================================================
  // 3. CREDIT CARD DETECTION
  // =============================================================================

  describe('Credit Card Detection', () => {
    test('detects valid Visa number with spaces (passes Luhn)', () => {
      const result = detectPII('Card: 4111 1111 1111 1111');
      expect(result.hasPII).toBe(true);
      const ccDetections = result.detections.filter((d) => d.type === 'credit_card');
      expect(ccDetections).toHaveLength(1);
      expect(ccDetections[0].value).toBe('[REDACTED_CARD]');
    });

    test('detects valid card number with dashes', () => {
      const result = detectPII('Card: 4111-1111-1111-1111');
      expect(result.hasPII).toBe(true);
      const ccDetections = result.detections.filter((d) => d.type === 'credit_card');
      expect(ccDetections).toHaveLength(1);
      expect(ccDetections[0].value).toBe('[REDACTED_CARD]');
    });

    test('does not flag non-Luhn digit sequences as credit cards', () => {
      const result = detectPII('Order ID: 1234 5678 9012 3456');
      const ccDetections = result.detections.filter((d) => d.type === 'credit_card');
      // 1234567890123456 fails Luhn — not a valid card number
      expect(ccDetections).toHaveLength(0);
    });
  });

  // =============================================================================
  // 4. PHONE DETECTION
  // =============================================================================

  describe('Phone Detection', () => {
    test('detects US format phone number (555) 123-4567', () => {
      const result = detectPII('Call me at (555) 123-4567');
      expect(result.hasPII).toBe(true);
      const phoneDetections = result.detections.filter((d) => d.type === 'phone');
      expect(phoneDetections).toHaveLength(1);
      expect(phoneDetections[0].value).toBe('[REDACTED_PHONE]');
    });

    test('detects phone with country code +1-555-123-4567', () => {
      const result = detectPII('Phone: +1-555-123-4567');
      expect(result.hasPII).toBe(true);
      const phoneDetections = result.detections.filter((d) => d.type === 'phone');
      expect(phoneDetections).toHaveLength(1);
    });

    test('does not match short numbers like 911', () => {
      const result = detectPII('In an emergency, call 911');
      const phoneDetections = result.detections.filter((d) => d.type === 'phone');
      expect(phoneDetections).toHaveLength(0);
    });
  });

  // =============================================================================
  // 5. IP ADDRESS DETECTION
  // =============================================================================

  describe('IP Address Detection', () => {
    test('detects valid IPv4 address 192.168.1.1', () => {
      const result = detectPII('Server at 192.168.1.1');
      expect(result.hasPII).toBe(true);
      const ipDetections = result.detections.filter((d) => d.type === 'ip_address');
      expect(ipDetections).toHaveLength(1);
      expect(ipDetections[0].value).toBe('[REDACTED_IP]');
    });

    test('detects edge case 0.0.0.0', () => {
      const result = detectPII('Bind to 0.0.0.0');
      const ipDetections = result.detections.filter((d) => d.type === 'ip_address');
      expect(ipDetections).toHaveLength(1);
      expect(ipDetections[0].value).toBe('[REDACTED_IP]');
    });

    test('detects edge case 255.255.255.255', () => {
      const result = detectPII('Broadcast 255.255.255.255');
      const ipDetections = result.detections.filter((d) => d.type === 'ip_address');
      expect(ipDetections).toHaveLength(1);
      expect(ipDetections[0].value).toBe('[REDACTED_IP]');
    });

    test('does not detect invalid octets like 999.999.999.999', () => {
      const result = detectPII('Not an IP: 999.999.999.999');
      const ipDetections = result.detections.filter((d) => d.type === 'ip_address');
      expect(ipDetections).toHaveLength(0);
    });
  });

  // =============================================================================
  // 6. MULTIPLE PII IN ONE STRING
  // =============================================================================

  describe('Multiple PII in one string', () => {
    test('detects both email and phone in the same text', () => {
      const text = 'Reach me at user@example.com or (555) 123-4567';
      const result = detectPII(text);
      expect(result.hasPII).toBe(true);

      const emailDetections = result.detections.filter((d) => d.type === 'email');
      const phoneDetections = result.detections.filter((d) => d.type === 'phone');
      expect(emailDetections).toHaveLength(1);
      expect(phoneDetections).toHaveLength(1);
    });

    test('reports correct start and end positions', () => {
      const text = 'Email: user@example.com';
      const result = detectPII(text);

      expect(result.detections).toHaveLength(1);
      const detection = result.detections[0];
      expect(detection.start).toBe(text.indexOf('user@example.com'));
      expect(detection.end).toBe(text.indexOf('user@example.com') + 'user@example.com'.length);
      expect(text.substring(detection.start, detection.end)).toBe('user@example.com');
      expect(detection.value).toBe('[REDACTED_EMAIL]');
      expect(detection.value).not.toBe(text.substring(detection.start, detection.end));
    });

    test('sanitizes detection values for every detected type', () => {
      const text = 'Email user@example.com SSN 123-45-6789 Phone 555-123-4567';
      const result = detectPII(text);

      expect(result.detections).toHaveLength(3);
      for (const detection of result.detections) {
        expect(detection.value).toBe(getPIIRedactLabel(detection.type));
        expect(detection.value).not.toBe(text.substring(detection.start, detection.end));
      }
    });

    test('detects multiple different PII types', () => {
      const text = 'SSN: 123-45-6789, IP: 10.0.0.1, Email: admin@test.com';
      const result = detectPII(text);

      const types = result.detections.map((d) => d.type);
      expect(types).toContain('ssn');
      expect(types).toContain('ip_address');
      expect(types).toContain('email');
    });
  });

  // =============================================================================
  // 7. REDACTION
  // =============================================================================

  describe('Redaction', () => {
    test('redactPII replaces email with [REDACTED_EMAIL]', () => {
      const result = redactPII('Contact user@example.com for info');
      expect(result).toBe('Contact [REDACTED_EMAIL] for info');
      expect(result).not.toContain('user@example.com');
    });

    test('redactPII replaces phone with [REDACTED_PHONE]', () => {
      const result = redactPII('Call (555) 123-4567 now');
      expect(result).toContain('[REDACTED_PHONE]');
      expect(result).not.toContain('4567');
    });

    test('redactPII replaces SSN with [REDACTED_SSN]', () => {
      const result = redactPII('SSN: 123-45-6789');
      expect(result).toBe('SSN: [REDACTED_SSN]');
    });

    test('redactPII replaces credit card with [REDACTED_CARD]', () => {
      const result = redactPII('Card: 4111 1111 1111 1111');
      expect(result).toBe('Card: [REDACTED_CARD]');
    });

    test('redactPII replaces IP address with [REDACTED_IP]', () => {
      const result = redactPII('Server: 192.168.1.1');
      expect(result).toBe('Server: [REDACTED_IP]');
    });

    test('redacts multiple PII types in one string correctly', () => {
      const result = redactPII('Email me at admin@corp.com from 10.0.0.1');
      expect(result).toContain('[REDACTED_EMAIL]');
      expect(result).toContain('[REDACTED_IP]');
      expect(result).not.toContain('admin@corp.com');
      expect(result).not.toContain('10.0.0.1');
    });
  });

  // =============================================================================
  // 8. containsPII
  // =============================================================================

  describe('containsPII', () => {
    test('returns true for text containing an email', () => {
      expect(containsPII('Send to user@example.com')).toBe(true);
    });

    test('returns true for text containing a phone number', () => {
      expect(containsPII('Call (555) 123-4567')).toBe(true);
    });

    test('returns true for text containing an SSN', () => {
      expect(containsPII('SSN 123-45-6789')).toBe(true);
    });

    test('returns true for text containing a valid credit card', () => {
      expect(containsPII('Pay with 4111 1111 1111 1111')).toBe(true);
    });

    test('returns true for text containing an IP address', () => {
      expect(containsPII('Host 192.168.1.1')).toBe(true);
    });

    test('returns false for clean text with no PII', () => {
      expect(containsPII('Hello world, this is a normal message')).toBe(false);
    });

    test('returns false for text with invalid PII-like patterns', () => {
      expect(containsPII('Number 999.999.999.999 is not valid')).toBe(false);
    });
  });

  // =============================================================================
  // 9. NO PII
  // =============================================================================

  describe('No PII', () => {
    test('clean text returns hasPII false, empty detections, and original text as redacted', () => {
      const text = 'This is a perfectly clean message with no sensitive data.';
      const result = detectPII(text);

      expect(result.hasPII).toBe(false);
      expect(result.detections).toHaveLength(0);
      expect(result.redacted).toBe(text);
    });

    test('text with numbers that do not form PII patterns', () => {
      const text = 'Order #12345 was placed on 2024-01-15 for $99.99';
      const result = detectPII(text);

      const ssnDetections = result.detections.filter((d) => d.type === 'ssn');
      const ccDetections = result.detections.filter((d) => d.type === 'credit_card');
      expect(ssnDetections).toHaveLength(0);
      expect(ccDetections).toHaveLength(0);
    });
  });

  // =============================================================================
  // 10. OVERLAP HANDLING
  // =============================================================================

  describe('Overlap Handling', () => {
    test('when detections overlap, earlier/longer match is kept', () => {
      // Construct a scenario where a phone-like pattern is embedded in a credit card number.
      // The credit card pattern will match the full 16 digits, while a phone pattern
      // might match a subset. The overlap remover should keep the earlier/longer match.
      const text = 'Number: 4111 1111 1111 1111';
      const result = detectPII(text);

      // All detections at any given position should be non-overlapping
      for (let i = 1; i < result.detections.length; i++) {
        const prev = result.detections[i - 1];
        const curr = result.detections[i];
        expect(curr.start).toBeGreaterThanOrEqual(prev.end);
      }
    });

    test('detections are sorted by start position', () => {
      const text = 'IP: 10.0.0.1 and email: test@example.com';
      const result = detectPII(text);

      for (let i = 1; i < result.detections.length; i++) {
        expect(result.detections[i].start).toBeGreaterThanOrEqual(result.detections[i - 1].start);
      }
    });

    test('non-overlapping detections are all preserved', () => {
      const text = 'SSN: 123-45-6789, Email: a@b.com, IP: 1.2.3.4';
      const result = detectPII(text);

      // All three distinct PII types should be detected since they do not overlap
      const types = result.detections.map((d) => d.type);
      expect(types).toContain('ssn');
      expect(types).toContain('email');
      expect(types).toContain('ip_address');
    });

    test('custom MemberId recognizer wins over embedded built-in phone match', () => {
      const registry = new PIIRecognizerRegistry();
      registerBuiltInRecognizers(registry);
      registry.register(
        new RegexPIIRecognizer(
          'custom-member-id',
          ['MemberId'],
          /\b[A-Za-z0-9]{6,15}\b/g,
          'MemberId',
          undefined,
          'custom',
        ),
      );

      const result = detectPII('ID A8006170900', registry);

      expect(result.detections).toHaveLength(1);
      expect(result.detections[0].type).toBe('MemberId');
      expect(result.redacted).toBe('ID [REDACTED_MEMBER_ID]');
    });
  });

  // ===========================================================================
  // SELECTIVE REDACTION
  // ===========================================================================

  describe('Selective Redaction', () => {
    test('redacts all PII when no exempt types', () => {
      const result = detectPIISelective('Call me at 555-123-4567 or email user@example.com');
      expect(result.redacted).toContain('[REDACTED_PHONE]');
      expect(result.redacted).toContain('[REDACTED_EMAIL]');
      expect(result.exemptedTypes).toEqual([]);
      expect(result.redactedTypes).toContain('phone');
      expect(result.redactedTypes).toContain('email');
    });

    test('exempts phone when gathering phone field', () => {
      const result = detectPIISelective(
        'My phone is 555-123-4567 and SSN is 123-45-6789',
        new Set(['phone']),
      );
      expect(result.redacted).toContain('555-123-4567');
      expect(result.redacted).toContain('[REDACTED_SSN]');
      expect(result.exemptedTypes).toContain('phone');
      expect(result.redactedTypes).toContain('ssn');
      expect(result.redactedTypes).not.toContain('phone');
    });

    test('exempts email when gathering email field', () => {
      const result = detectPIISelective(
        'My email is user@example.com and card is 4111 1111 1111 1111',
        new Set(['email']),
      );
      expect(result.redacted).toContain('user@example.com');
      expect(result.redacted).toContain('[REDACTED_CARD]');
      expect(result.exemptedTypes).toContain('email');
    });

    test('exempts multiple types simultaneously', () => {
      const result = detectPIISelective(
        'Phone 555-123-4567, email user@example.com, SSN 123-45-6789',
        new Set(['phone', 'email']),
      );
      expect(result.redacted).toContain('555-123-4567');
      expect(result.redacted).toContain('user@example.com');
      expect(result.redacted).toContain('[REDACTED_SSN]');
    });

    test('detects ALL types even when exempted (for audit)', () => {
      const result = detectPIISelective('My phone is 555-123-4567', new Set(['phone']));
      expect(result.hasPII).toBe(true);
      expect(result.detections).toHaveLength(1);
      expect(result.detections[0].type).toBe('phone');
      expect(result.detections[0].value).toBe('[REDACTED_PHONE]');
    });

    test('returns empty exemptedTypes when no PII matches exempt set', () => {
      const result = detectPIISelective('My email is user@example.com', new Set(['phone']));
      expect(result.redacted).toContain('[REDACTED_EMAIL]');
      expect(result.exemptedTypes).toEqual([]);
    });
  });
});
