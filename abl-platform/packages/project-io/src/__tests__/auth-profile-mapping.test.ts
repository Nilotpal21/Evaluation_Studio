import { describe, it, expect } from 'vitest';
import {
  extractAuthMappingRequirements,
  matchAuthProfileCandidates,
  applyAuthProfileMapping,
  stripCrossTenantAuthReferences,
} from '../import/auth-mapping.js';

describe('extractAuthMappingRequirements', () => {
  it('extracts auth requirements from manifest', () => {
    const manifest = {
      metadata: {
        required_auth_profiles: [
          { name: 'production-openai', authType: 'api_key', scope: 'project' as const },
        ],
      },
    };
    const result = extractAuthMappingRequirements(manifest);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('production-openai');
    expect(result[0].authType).toBe('api_key');
    expect(result[0].scope).toBe('project');
  });

  it('returns empty array when no metadata', () => {
    expect(extractAuthMappingRequirements(null)).toEqual([]);
    expect(extractAuthMappingRequirements({})).toEqual([]);
    expect(extractAuthMappingRequirements({ metadata: {} })).toEqual([]);
  });

  it('handles multiple auth profiles', () => {
    const manifest = {
      metadata: {
        required_auth_profiles: [
          { name: 'openai-prod', authType: 'api_key', scope: 'project' as const },
          { name: 'slack-oauth', authType: 'oauth2', scope: 'tenant' as const },
        ],
      },
    };
    const result = extractAuthMappingRequirements(manifest);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('openai-prod');
    expect(result[1].name).toBe('slack-oauth');
  });
});

describe('matchAuthProfileCandidates', () => {
  it('matches existing profiles by name and authType', () => {
    const requirements = [
      {
        name: 'production-openai',
        authType: 'api_key',
        scope: 'project' as const,
        config: {},
        referencedBy: [],
      },
    ];
    const existingProfiles = [
      { _id: 'p1', name: 'production-openai', authType: 'api_key' },
      { _id: 'p2', name: 'other-profile', authType: 'bearer' },
    ];
    const candidates = matchAuthProfileCandidates(requirements, existingProfiles);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].candidates).toHaveLength(1);
    expect(candidates[0].candidates[0]._id).toBe('p1');
    expect(candidates[0].autoMatched).toBe(true);
  });

  it('does not match when authType differs', () => {
    const requirements = [
      {
        name: 'production-openai',
        authType: 'api_key',
        scope: 'project' as const,
        config: {},
        referencedBy: [],
      },
    ];
    const existingProfiles = [{ _id: 'p1', name: 'production-openai', authType: 'bearer' }];
    const candidates = matchAuthProfileCandidates(requirements, existingProfiles);
    expect(candidates[0].candidates).toHaveLength(0);
    expect(candidates[0].autoMatched).toBe(false);
  });

  it('returns multiple candidates when names match', () => {
    const requirements = [
      {
        name: 'shared-api',
        authType: 'api_key',
        scope: 'project' as const,
        config: {},
        referencedBy: [],
      },
    ];
    const existingProfiles = [
      { _id: 'p1', name: 'shared-api', authType: 'api_key' },
      { _id: 'p2', name: 'shared-api', authType: 'api_key' },
    ];
    const candidates = matchAuthProfileCandidates(requirements, existingProfiles);
    expect(candidates[0].candidates).toHaveLength(2);
    expect(candidates[0].autoMatched).toBe(false); // ambiguous
  });
});

describe('applyAuthProfileMapping', () => {
  it('maps authProfileName to authProfileId', () => {
    const connections = [
      { name: 'gmail-conn', authProfileName: 'production-openai', connectorName: 'gmail' },
    ];
    const mapping = { 'production-openai': 'target-profile-id-123' };
    const result = applyAuthProfileMapping(connections, mapping);
    expect(result[0].authProfileId).toBe('target-profile-id-123');
    expect(result[0].authProfileName).toBeUndefined();
  });

  it('leaves connections without authProfileName untouched', () => {
    const connections = [{ name: 'simple-conn', connectorName: 'http' }];
    const mapping = { 'some-profile': 'some-id' };
    const result = applyAuthProfileMapping(connections, mapping);
    expect(result[0]).toEqual(connections[0]);
  });

  it('leaves connections with unmapped profile names untouched', () => {
    const connections = [
      { name: 'conn', authProfileName: 'unmapped-profile', connectorName: 'slack' },
    ];
    const mapping = { 'other-profile': 'some-id' };
    const result = applyAuthProfileMapping(connections, mapping);
    expect(result[0].authProfileName).toBe('unmapped-profile');
    expect(result[0]).not.toHaveProperty('authProfileId');
  });
});

describe('stripCrossTenantAuthReferences', () => {
  it('strips authProfileId from imported connections', () => {
    const connection = {
      name: 'gmail-conn',
      authProfileId: 'foreign-tenant-profile-id',
      connectorName: 'gmail',
    };
    const stripped = stripCrossTenantAuthReferences(connection);
    expect(stripped.authProfileId).toBeUndefined();
    expect(stripped.name).toBe('gmail-conn');
    expect(stripped.connectorName).toBe('gmail');
  });

  it('leaves connections without authProfileId untouched', () => {
    const connection = { name: 'simple-conn', connectorName: 'http' };
    const stripped = stripCrossTenantAuthReferences(connection);
    expect(stripped.name).toBe('simple-conn');
  });
});
