/**
 * WorkflowDefinition Input Validation
 *
 * Manual validation (no Zod — project convention).
 */

import { WORKFLOW_STATUSES, WORKFLOW_TYPES } from '@agent-platform/shared-kernel';
import type { ValidationError } from './contact-validation.js';

const VALID_TYPES: readonly string[] = WORKFLOW_TYPES;
const VALID_STATUSES: readonly string[] = WORKFLOW_STATUSES;

export function validateCreateWorkflow(params: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];

  // Required fields
  if (!params.tenantId || typeof params.tenantId !== 'string' || !params.tenantId.trim()) {
    errors.push({ field: 'tenantId', message: 'Required non-empty string' });
  }
  if (!params.projectId || typeof params.projectId !== 'string' || !params.projectId.trim()) {
    errors.push({ field: 'projectId', message: 'Required non-empty string' });
  }
  if (!params.name || typeof params.name !== 'string' || !params.name.trim()) {
    errors.push({ field: 'name', message: 'Required non-empty string' });
  } else if ((params.name as string).length > 200) {
    errors.push({ field: 'name', message: 'Max 200 characters' });
  }
  // Optional typed fields
  if (params.type !== undefined) {
    if (typeof params.type !== 'string' || !VALID_TYPES.includes(params.type)) {
      errors.push({ field: 'type', message: `Must be one of: ${VALID_TYPES.join(', ')}` });
    }
  }

  if (params.entryAgent !== undefined && typeof params.entryAgent !== 'string') {
    errors.push({ field: 'entryAgent', message: 'Must be a string' });
  }

  if (params.status !== undefined) {
    if (typeof params.status !== 'string' || !VALID_STATUSES.includes(params.status)) {
      errors.push({ field: 'status', message: `Must be one of: ${VALID_STATUSES.join(', ')}` });
    }
  }

  if (params.slaMinutes !== undefined) {
    if (
      typeof params.slaMinutes !== 'number' ||
      !Number.isInteger(params.slaMinutes) ||
      params.slaMinutes <= 0
    ) {
      errors.push({ field: 'slaMinutes', message: 'Must be a positive integer' });
    }
  }

  if (params.steps !== undefined && !Array.isArray(params.steps)) {
    errors.push({ field: 'steps', message: 'Must be an array' });
  }

  if (params.triggers !== undefined && !Array.isArray(params.triggers)) {
    errors.push({ field: 'triggers', message: 'Must be an array' });
  }

  if (params.escalationRules !== undefined && !Array.isArray(params.escalationRules)) {
    errors.push({ field: 'escalationRules', message: 'Must be an array' });
  }

  return errors;
}

export function validateUpdateWorkflow(params: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];

  if (params.name !== undefined) {
    if (typeof params.name !== 'string' || !params.name.trim()) {
      errors.push({ field: 'name', message: 'Must be a non-empty string' });
    } else if (params.name.length > 200) {
      errors.push({ field: 'name', message: 'Max 200 characters' });
    }
  }

  if (params.type !== undefined) {
    if (typeof params.type !== 'string' || !VALID_TYPES.includes(params.type)) {
      errors.push({ field: 'type', message: `Must be one of: ${VALID_TYPES.join(', ')}` });
    }
  }

  if (params.entryAgent !== undefined && typeof params.entryAgent !== 'string') {
    errors.push({ field: 'entryAgent', message: 'Must be a string' });
  }

  if (params.status !== undefined) {
    if (typeof params.status !== 'string' || !VALID_STATUSES.includes(params.status)) {
      errors.push({ field: 'status', message: `Must be one of: ${VALID_STATUSES.join(', ')}` });
    }
  }

  if (params.slaMinutes !== undefined) {
    if (
      typeof params.slaMinutes !== 'number' ||
      !Number.isInteger(params.slaMinutes) ||
      params.slaMinutes <= 0
    ) {
      errors.push({ field: 'slaMinutes', message: 'Must be a positive integer' });
    }
  }

  if (params.steps !== undefined && !Array.isArray(params.steps)) {
    errors.push({ field: 'steps', message: 'Must be an array' });
  }

  if (params.triggers !== undefined && !Array.isArray(params.triggers)) {
    errors.push({ field: 'triggers', message: 'Must be an array' });
  }

  if (params.escalationRules !== undefined && !Array.isArray(params.escalationRules)) {
    errors.push({ field: 'escalationRules', message: 'Must be an array' });
  }

  return errors;
}
