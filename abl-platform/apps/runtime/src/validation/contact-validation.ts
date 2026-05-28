/**
 * Contact Input Validation
 *
 * Manual validation (no Zod — project convention).
 */

export interface ValidationError {
  field: string;
  message: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s\-().]{7,20}$/;
const VALID_TYPES = ['employee', 'customer', 'anonymous'];

export function validateCreateContact(params: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];

  // tenantId: required
  if (!params.tenantId || typeof params.tenantId !== 'string' || !params.tenantId.trim()) {
    errors.push({ field: 'tenantId', message: 'Required non-empty string' });
  }

  // identity + identityType: if one set, both required
  validateIdentityPair(params, errors);

  // type
  if (params.type !== undefined) {
    if (typeof params.type !== 'string' || !VALID_TYPES.includes(params.type)) {
      errors.push({ field: 'type', message: `Must be one of: ${VALID_TYPES.join(', ')}` });
    }
  }

  // displayName
  if (params.displayName !== undefined) {
    if (typeof params.displayName !== 'string' || params.displayName.length > 200) {
      errors.push({ field: 'displayName', message: 'Must be a string, max 200 characters' });
    }
  }

  // employeeId
  if (params.employeeId !== undefined) {
    if (typeof params.employeeId !== 'string' || params.employeeId.length > 100) {
      errors.push({ field: 'employeeId', message: 'Must be a string, max 100 characters' });
    }
  }

  // company
  if (params.company !== undefined) {
    if (typeof params.company !== 'string' || params.company.length > 200) {
      errors.push({ field: 'company', message: 'Must be a string, max 200 characters' });
    }
  }

  // tags
  if (params.tags !== undefined) {
    if (!Array.isArray(params.tags)) {
      errors.push({ field: 'tags', message: 'Must be an array of strings' });
    } else {
      if (params.tags.length > 50) {
        errors.push({ field: 'tags', message: 'Max 50 items' });
      }
      for (let i = 0; i < params.tags.length; i++) {
        if (typeof params.tags[i] !== 'string' || (params.tags[i] as string).length > 50) {
          errors.push({
            field: `tags[${i}]`,
            message: 'Each tag must be a string, max 50 characters',
          });
          break;
        }
      }
    }
  }

  return errors;
}

export function validateUpdateContact(params: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];

  // identity + identityType: if one set, both required
  validateIdentityPair(params, errors);

  // type
  if (params.type !== undefined) {
    if (typeof params.type !== 'string' || !VALID_TYPES.includes(params.type)) {
      errors.push({ field: 'type', message: `Must be one of: ${VALID_TYPES.join(', ')}` });
    }
  }

  // displayName
  if (params.displayName !== undefined) {
    if (typeof params.displayName !== 'string' || params.displayName.length > 200) {
      errors.push({ field: 'displayName', message: 'Must be a string, max 200 characters' });
    }
  }

  // employeeId
  if (params.employeeId !== undefined) {
    if (typeof params.employeeId !== 'string' || params.employeeId.length > 100) {
      errors.push({ field: 'employeeId', message: 'Must be a string, max 100 characters' });
    }
  }

  // company
  if (params.company !== undefined) {
    if (typeof params.company !== 'string' || params.company.length > 200) {
      errors.push({ field: 'company', message: 'Must be a string, max 200 characters' });
    }
  }

  // tags
  if (params.tags !== undefined) {
    if (!Array.isArray(params.tags)) {
      errors.push({ field: 'tags', message: 'Must be an array of strings' });
    } else {
      if (params.tags.length > 50) {
        errors.push({ field: 'tags', message: 'Max 50 items' });
      }
      for (let i = 0; i < params.tags.length; i++) {
        if (typeof params.tags[i] !== 'string' || (params.tags[i] as string).length > 50) {
          errors.push({
            field: `tags[${i}]`,
            message: 'Each tag must be a string, max 50 characters',
          });
          break;
        }
      }
    }
  }

  return errors;
}

function validateIdentityPair(params: Record<string, unknown>, errors: ValidationError[]): void {
  const hasIdentity = params.identity !== undefined;
  const hasIdentityType = params.identityType !== undefined;

  if (hasIdentity && !hasIdentityType) {
    errors.push({ field: 'identityType', message: 'Required when identity is provided' });
    return;
  }
  if (!hasIdentity && hasIdentityType) {
    errors.push({ field: 'identity', message: 'Required when identityType is provided' });
    return;
  }

  if (hasIdentity && hasIdentityType) {
    const identity = params.identity as string;
    const identityType = params.identityType as string;

    if (typeof identity !== 'string' || !identity.trim()) {
      errors.push({ field: 'identity', message: 'Must be a non-empty string' });
      return;
    }

    switch (identityType) {
      case 'email':
        if (!EMAIL_RE.test(identity)) {
          errors.push({ field: 'identity', message: 'Invalid email format' });
        }
        break;
      case 'phone':
        if (!PHONE_RE.test(identity)) {
          errors.push({ field: 'identity', message: 'Invalid phone format' });
        }
        break;
      case 'external':
        if (!identity.trim()) {
          errors.push({ field: 'identity', message: 'External identity must be non-empty' });
        }
        break;
      default:
        errors.push({ field: 'identityType', message: 'Must be one of: email, phone, external' });
    }
  }
}
