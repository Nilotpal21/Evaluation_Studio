/**
 * Drift guard: the validation schema's status enum and the Mongoose model's
 * `AUTH_PROFILE_STATUSES` are intentionally separate constants — the schema's
 * copy is inlined to avoid pulling Mongoose-bearing imports into the validation
 * barrel (test files that `vi.mock('@agent-platform/database/models')` would
 * otherwise break). This test asserts they stay in lockstep.
 */

import { describe, it, expect } from 'vitest';
import { AUTH_PROFILE_STATUS_VALUES } from '../../validation/auth-profile.schema.js';
import { AUTH_PROFILE_STATUSES } from '@agent-platform/database/models';

describe('auth profile status enum sync', () => {
  it('schema and model expose the same status values', () => {
    expect([...AUTH_PROFILE_STATUS_VALUES].sort()).toEqual([...AUTH_PROFILE_STATUSES].sort());
  });
});
