/**
 * WorkflowDefinition Validation Tests
 */

import { describe, test, expect } from 'vitest';
import { validateCreateWorkflow, validateUpdateWorkflow } from '../validation/workflow-validation';

describe('Workflow Validation', () => {
  describe('validateCreateWorkflow', () => {
    test('valid create params pass', () => {
      const errors = validateCreateWorkflow({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'onboarding-flow',

        type: 'cx_automation',
      });
      expect(errors).toHaveLength(0);
    });

    test('missing required fields fail', () => {
      const errors = validateCreateWorkflow({});
      expect(errors.some((e) => e.field === 'tenantId')).toBe(true);
      expect(errors.some((e) => e.field === 'projectId')).toBe(true);
      expect(errors.some((e) => e.field === 'name')).toBe(true);
    });

    test('missing tenantId fails', () => {
      const errors = validateCreateWorkflow({
        projectId: 'proj-1',
        name: 'flow',
      });
      expect(errors.some((e) => e.field === 'tenantId')).toBe(true);
    });

    test('missing projectId fails', () => {
      const errors = validateCreateWorkflow({
        tenantId: 'org-1',
        name: 'flow',
      });
      expect(errors.some((e) => e.field === 'projectId')).toBe(true);
    });

    test('invalid type enum rejected', () => {
      const errors = validateCreateWorkflow({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'flow',

        type: 'bad_type',
      });
      expect(errors.some((e) => e.field === 'type')).toBe(true);
    });

    test('valid type enum accepted', () => {
      for (const type of ['cx_automation', 'ex_automation', 'internal']) {
        const errors = validateCreateWorkflow({
          tenantId: 'org-1',
          projectId: 'proj-1',
          name: 'flow',

          type,
        });
        expect(errors.some((e) => e.field === 'type')).toBe(false);
      }
    });

    test('invalid status enum rejected', () => {
      const errors = validateCreateWorkflow({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'flow',

        status: 'bad_status',
      });
      expect(errors.some((e) => e.field === 'status')).toBe(true);
    });

    test('valid status enum accepted', () => {
      for (const status of ['draft', 'active', 'paused', 'archived']) {
        const errors = validateCreateWorkflow({
          tenantId: 'org-1',
          projectId: 'proj-1',
          name: 'flow',

          status,
        });
        expect(errors.some((e) => e.field === 'status')).toBe(false);
      }
    });

    test('slaMinutes must be a positive integer', () => {
      const negativeErrors = validateCreateWorkflow({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'flow',

        slaMinutes: -5,
      });
      expect(negativeErrors.some((e) => e.field === 'slaMinutes')).toBe(true);

      const zeroErrors = validateCreateWorkflow({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'flow',

        slaMinutes: 0,
      });
      expect(zeroErrors.some((e) => e.field === 'slaMinutes')).toBe(true);

      const floatErrors = validateCreateWorkflow({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'flow',

        slaMinutes: 5.5,
      });
      expect(floatErrors.some((e) => e.field === 'slaMinutes')).toBe(true);

      const validErrors = validateCreateWorkflow({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'flow',

        slaMinutes: 30,
      });
      expect(validErrors.some((e) => e.field === 'slaMinutes')).toBe(false);
    });

    test('name max length enforced', () => {
      const errors = validateCreateWorkflow({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'x'.repeat(201),
      });
      expect(errors.some((e) => e.field === 'name')).toBe(true);
    });

    test('steps must be an array if provided', () => {
      const errors = validateCreateWorkflow({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'flow',

        steps: 'not an array',
      });
      expect(errors.some((e) => e.field === 'steps')).toBe(true);
    });

    test('triggers must be an array if provided', () => {
      const errors = validateCreateWorkflow({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'flow',

        triggers: {},
      });
      expect(errors.some((e) => e.field === 'triggers')).toBe(true);
    });

    test('escalationRules must be an array if provided', () => {
      const errors = validateCreateWorkflow({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'flow',

        escalationRules: 'rules',
      });
      expect(errors.some((e) => e.field === 'escalationRules')).toBe(true);
    });

    test('valid arrays pass', () => {
      const errors = validateCreateWorkflow({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'flow',

        steps: [{ name: 'welcome' }],
        triggers: [{ event: 'signup' }],
        escalationRules: [{ after: 15, to: 'manager' }],
      });
      expect(errors).toHaveLength(0);
    });
  });

  describe('validateUpdateWorkflow', () => {
    test('valid update params pass', () => {
      const errors = validateUpdateWorkflow({
        name: 'updated-flow',
        status: 'paused',
      });
      expect(errors).toHaveLength(0);
    });

    test('empty update is valid', () => {
      const errors = validateUpdateWorkflow({});
      expect(errors).toHaveLength(0);
    });

    test('invalid type rejected on update', () => {
      const errors = validateUpdateWorkflow({
        type: 'bad_type',
      });
      expect(errors.some((e) => e.field === 'type')).toBe(true);
    });

    test('invalid status rejected on update', () => {
      const errors = validateUpdateWorkflow({
        status: 'bad_status',
      });
      expect(errors.some((e) => e.field === 'status')).toBe(true);
    });

    test('slaMinutes validated on update', () => {
      const errors = validateUpdateWorkflow({
        slaMinutes: -1,
      });
      expect(errors.some((e) => e.field === 'slaMinutes')).toBe(true);
    });

    test('empty name rejected on update', () => {
      const errors = validateUpdateWorkflow({
        name: '',
      });
      expect(errors.some((e) => e.field === 'name')).toBe(true);
    });

    test('name max length enforced on update', () => {
      const errors = validateUpdateWorkflow({
        name: 'x'.repeat(201),
      });
      expect(errors.some((e) => e.field === 'name')).toBe(true);
    });

    test('entryAgent must be a string on update', () => {
      const errors = validateUpdateWorkflow({
        entryAgent: 42,
      });
      expect(errors.some((e) => e.field === 'entryAgent')).toBe(true);
    });
  });
});
