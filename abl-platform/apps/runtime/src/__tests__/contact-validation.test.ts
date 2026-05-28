/**
 * Contact Validation Tests
 */

import { describe, test, expect } from 'vitest';
import { validateCreateContact, validateUpdateContact } from '../validation/contact-validation';

describe('Contact Validation', () => {
  describe('validateCreateContact', () => {
    test('valid create params pass', () => {
      const errors = validateCreateContact({
        tenantId: 'org-1',
        type: 'customer',
        identity: 'john@example.com',
        identityType: 'email',
        displayName: 'John Doe',
      });
      expect(errors).toHaveLength(0);
    });

    test('missing tenantId fails', () => {
      const errors = validateCreateContact({
        type: 'customer',
        identity: 'john@example.com',
        identityType: 'email',
      });
      expect(errors.some((e) => e.field === 'tenantId')).toBe(true);
    });

    test('invalid email format detected', () => {
      const errors = validateCreateContact({
        tenantId: 'org-1',
        identity: 'not-an-email',
        identityType: 'email',
      });
      expect(errors.some((e) => e.field === 'identity' && e.message.includes('email'))).toBe(true);
    });

    test('valid email format passes', () => {
      const errors = validateCreateContact({
        tenantId: 'org-1',
        identity: 'user@example.com',
        identityType: 'email',
      });
      expect(errors).toHaveLength(0);
    });

    test('invalid phone format detected', () => {
      const errors = validateCreateContact({
        tenantId: 'org-1',
        identity: '12',
        identityType: 'phone',
      });
      expect(errors.some((e) => e.field === 'identity' && e.message.includes('phone'))).toBe(true);
    });

    test('valid phone format passes', () => {
      const errors = validateCreateContact({
        tenantId: 'org-1',
        identity: '+1-555-123-4567',
        identityType: 'phone',
      });
      expect(errors).toHaveLength(0);
    });

    test('identity without identityType fails', () => {
      const errors = validateCreateContact({
        tenantId: 'org-1',
        identity: 'john@example.com',
      });
      expect(errors.some((e) => e.field === 'identityType')).toBe(true);
    });

    test('identityType without identity fails', () => {
      const errors = validateCreateContact({
        tenantId: 'org-1',
        identityType: 'email',
      });
      expect(errors.some((e) => e.field === 'identity')).toBe(true);
    });

    test('max length enforcement for displayName', () => {
      const errors = validateCreateContact({
        tenantId: 'org-1',
        displayName: 'x'.repeat(201),
      });
      expect(errors.some((e) => e.field === 'displayName')).toBe(true);
    });

    test('invalid type enum rejected', () => {
      const errors = validateCreateContact({
        tenantId: 'org-1',
        type: 'invalid_type',
      });
      expect(errors.some((e) => e.field === 'type')).toBe(true);
    });

    test('tags validation: max items', () => {
      const errors = validateCreateContact({
        tenantId: 'org-1',
        tags: Array(51).fill('tag'),
      });
      expect(errors.some((e) => e.field === 'tags')).toBe(true);
    });

    test('tags validation: item max length', () => {
      const errors = validateCreateContact({
        tenantId: 'org-1',
        tags: ['x'.repeat(51)],
      });
      expect(errors.some((e) => e.field.startsWith('tags['))).toBe(true);
    });
  });

  describe('validateUpdateContact', () => {
    test('valid update params pass', () => {
      const errors = validateUpdateContact({
        displayName: 'Jane Doe',
        type: 'employee',
      });
      expect(errors).toHaveLength(0);
    });

    test('invalid type rejected on update', () => {
      const errors = validateUpdateContact({
        type: 'bad_type',
      });
      expect(errors.some((e) => e.field === 'type')).toBe(true);
    });

    test('empty update is valid', () => {
      const errors = validateUpdateContact({});
      expect(errors).toHaveLength(0);
    });
  });
});
