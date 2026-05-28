import { describe, expect, it } from 'vitest';

import {
  PHASE2_CORE_AUTH_TYPES,
  getAuthProfileSupportDecision,
  isPhase2CoreAuthType,
  listSelectablePhase2CoreAuthTypes,
} from '../../validation/auth-profile-phase2.schema.js';

describe('auth-profile support matrix', () => {
  it('recognizes the scoped Phase 2 core auth types', () => {
    expect(PHASE2_CORE_AUTH_TYPES).toEqual(['basic', 'custom_header', 'aws_iam', 'mtls']);
    expect(isPhase2CoreAuthType('basic')).toBe(true);
    expect(isPhase2CoreAuthType('aws_iam')).toBe(true);
    expect(isPhase2CoreAuthType('oauth2_app')).toBe(false);
  });

  it('marks header auth types as supported on the HTTP tool path', () => {
    expect(getAuthProfileSupportDecision('basic', 'http_tool')).toMatchObject({
      level: 'supported',
      runtimeHonored: true,
      reasonCode: 'SUPPORTED_HTTP_HEADERS',
    });
    expect(getAuthProfileSupportDecision('custom_header', 'http_tool')).toMatchObject({
      level: 'supported',
      runtimeHonored: true,
      reasonCode: 'SUPPORTED_HTTP_HEADERS',
    });
  });

  it('marks aws_iam and mtls as attach_only on raw connections', () => {
    expect(getAuthProfileSupportDecision('aws_iam', 'raw_connection')).toMatchObject({
      level: 'attach_only',
      runtimeHonored: false,
      reasonCode: 'ATTACH_ONLY_NO_SIGNING_HOOK',
    });
    expect(getAuthProfileSupportDecision('mtls', 'raw_connection')).toMatchObject({
      level: 'attach_only',
      runtimeHonored: false,
      reasonCode: 'ATTACH_ONLY_NO_TLS_PROPAGATION',
    });
  });

  it('keeps all four types selectable in the auth profile editor', () => {
    expect(listSelectablePhase2CoreAuthTypes('auth_profile_editor')).toEqual([
      'basic',
      'custom_header',
      'aws_iam',
      'mtls',
    ]);
  });
});
