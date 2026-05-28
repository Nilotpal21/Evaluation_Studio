import { describe, expect, it } from 'vitest';

import { ErrorCode, handleApiError, isDuplicateKeyError } from '../lib/api-response';

describe('handleApiError', () => {
  it('exports duplicate-key classification for route-level conflict handling', () => {
    expect(isDuplicateKeyError(Object.assign(new Error('duplicate key'), { code: 11000 }))).toBe(
      true,
    );
    expect(isDuplicateKeyError(new Error('E11000 duplicate key error'))).toBe(true);
    expect(isDuplicateKeyError(new Error('other failure'))).toBe(false);
  });

  it('reports duplicate project slug collisions as duplicate project names', async () => {
    const duplicateSlugError = Object.assign(new Error('E11000 duplicate key error'), {
      code: 11000,
      keyPattern: { tenantId: 1, slug: 1 },
      keyValue: { tenantId: 'tenant-1', slug: 'support-bot' },
    });

    const response = handleApiError(duplicateSlugError, 'Projects.create');
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      success: false,
      errors: [
        {
          msg: 'Project with the same name already exists',
          code: ErrorCode.NAME_CONFLICT,
        },
      ],
    });
  });

  it('aliases generic slug duplicate-key messages to name', async () => {
    const duplicateSlugError = Object.assign(new Error('E11000 duplicate key error'), {
      code: 11000,
      keyPattern: { tenantId: 1, slug: 1 },
      keyValue: { tenantId: 'tenant-1', slug: 'support-bot' },
    });

    const response = handleApiError(duplicateSlugError, 'Pipelines POST');
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      success: false,
      errors: [
        {
          msg: 'A resource with this name already exists',
          code: ErrorCode.NAME_CONFLICT,
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('slug');
  });

  it('keeps non-technical duplicate-key field names in generic messages', async () => {
    const duplicateEmailError = Object.assign(new Error('E11000 duplicate key error'), {
      code: 11000,
      keyPattern: { tenantId: 1, email: 1 },
      keyValue: { tenantId: 'tenant-1', email: 'member@example.com' },
    });

    const response = handleApiError(duplicateEmailError, 'Members POST');
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      success: false,
      errors: [
        {
          msg: 'A resource with this email already exists',
          code: ErrorCode.NAME_CONFLICT,
        },
      ],
    });
  });
});
