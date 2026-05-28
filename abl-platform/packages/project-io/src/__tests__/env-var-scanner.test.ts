import { describe, it, expect } from 'vitest';
import {
  extractEnvVarReferences,
  extractSecretReferences,
  extractAuthProfileReferences,
  scanProjectEnvVars,
  scanProjectAuthProfiles,
} from '../export/env-var-scanner.js';

describe('extractEnvVarReferences', () => {
  it('finds {{env.KEY}} references', () => {
    const dsl = 'Use API key {{env.API_KEY}} and token {{env.SLACK_TOKEN}}';
    expect(extractEnvVarReferences(dsl)).toEqual(['API_KEY', 'SLACK_TOKEN']);
  });

  it('returns empty array when no matches', () => {
    expect(extractEnvVarReferences('no env vars here')).toEqual([]);
  });

  it('deduplicates repeated references', () => {
    const dsl = '{{env.API_KEY}} and again {{env.API_KEY}}';
    expect(extractEnvVarReferences(dsl)).toEqual(['API_KEY']);
  });

  it('returns sorted results', () => {
    const dsl = '{{env.ZEBRA}} {{env.ALPHA}} {{env.MIDDLE}}';
    expect(extractEnvVarReferences(dsl)).toEqual(['ALPHA', 'MIDDLE', 'ZEBRA']);
  });
});

describe('extractSecretReferences', () => {
  it('finds {{secrets.KEY}} references', () => {
    const dsl = 'Use {{secrets.OPENAI_KEY}} for LLM calls';
    expect(extractSecretReferences(dsl)).toEqual(['OPENAI_KEY']);
  });

  it('returns empty array when no matches', () => {
    expect(extractSecretReferences('no secrets here')).toEqual([]);
  });

  it('deduplicates repeated references', () => {
    const dsl = '{{secrets.KEY}} and {{secrets.KEY}}';
    expect(extractSecretReferences(dsl)).toEqual(['KEY']);
  });
});

describe('extractEnvVarReferences and extractSecretReferences in same content', () => {
  it('extracts both patterns from the same DSL', () => {
    const dsl = 'config: {{env.BASE_URL}} auth: {{secrets.TOKEN}} also {{env.REGION}}';
    expect(extractEnvVarReferences(dsl)).toEqual(['BASE_URL', 'REGION']);
    expect(extractSecretReferences(dsl)).toEqual(['TOKEN']);
  });
});

describe('scanProjectEnvVars', () => {
  it('scans across multiple agents and tools', () => {
    const agents = [
      { dslContent: 'use {{env.API_KEY}} and {{secrets.OPENAI_KEY}}' },
      { dslContent: 'use {{env.SLACK_TOKEN}}' },
    ];
    const tools = [
      { dslContent: 'tool uses {{env.DB_HOST}} and {{secrets.DB_PASS}}' },
      { content: 'other tool {{env.REGION}}' },
    ];
    expect(scanProjectEnvVars(agents, tools)).toEqual([
      'API_KEY',
      'DB_HOST',
      'REGION',
      'SLACK_TOKEN',
    ]);
  });

  it('does not classify explicit secret placeholders as required env vars', () => {
    const agents = [{ dslContent: 'use {{secrets.OPENAI_KEY}} and {{env.PUBLIC_BASE_URL}}' }];
    const tools = [{ dslContent: 'tool uses {{secrets.DB_PASS}} and {{env.REGION}}' }];

    expect(scanProjectEnvVars(agents, tools)).toEqual(['PUBLIC_BASE_URL', 'REGION']);
  });

  it('deduplicates across agents and tools', () => {
    const agents = [{ dslContent: '{{env.SHARED_KEY}}' }];
    const tools = [{ dslContent: '{{env.SHARED_KEY}}' }];
    expect(scanProjectEnvVars(agents, tools)).toEqual(['SHARED_KEY']);
  });

  it('returns empty array when no references found', () => {
    const agents = [{ dslContent: 'plain text' }];
    const tools = [{ dslContent: 'no vars' }];
    expect(scanProjectEnvVars(agents, tools)).toEqual([]);
  });

  it('handles empty dslContent gracefully', () => {
    const agents = [{ dslContent: '' }];
    const tools = [{ content: undefined, dslContent: undefined }];
    expect(scanProjectEnvVars(agents, tools)).toEqual([]);
  });

  it('results are sorted alphabetically', () => {
    const agents = [{ dslContent: '{{env.ZEBRA}} {{env.ALPHA}}' }];
    const tools = [{ dslContent: '{{secrets.MIDDLE}}' }];
    expect(scanProjectEnvVars(agents, tools)).toEqual(['ALPHA', 'ZEBRA']);
  });
});

describe('extractAuthProfileReferences', () => {
  it('extracts AUTH: references from DSL', () => {
    const dsl = `TOOL my-tool\n  TYPE: http\n  URL: https://api.example.com\n  AUTH: production-openai`;
    const result = extractAuthProfileReferences(dsl);
    expect(result).toContain('production-openai');
  });

  it('normalizes auth_profile_ref syntax to the referenced profile name', () => {
    const dsl = `TOOL my-tool\n  TYPE: http\n  AUTH: auth_profile_ref billing-shared`;
    const result = extractAuthProfileReferences(dsl);
    expect(result).toEqual(['billing-shared']);
  });

  it('extracts modern auth_profile properties from signature-first tool DSL', () => {
    const dsl = `lookup_customer() -> object\n  type: http\n  auth_profile: "crm-shared"`;
    const result = extractAuthProfileReferences(dsl);
    expect(result).toEqual(['crm-shared']);
  });

  it('ignores config-backed auth_profile values because they are not fixed profile names', () => {
    const dsl = `lookup_customer() -> object\n  type: http\n  auth_profile: "{{config.CRM_AUTH_PROFILE}}"`;
    const result = extractAuthProfileReferences(dsl);
    expect(result).toEqual([]);
  });

  it('ignores standalone AUTH auth-type directives like custom', () => {
    const dsl = `TOOL my-tool\n  TYPE: http\n  AUTH: custom`;
    const result = extractAuthProfileReferences(dsl);
    expect(result).toEqual([]);
  });

  it('handles multiple auth references', () => {
    const dsl = `TOOL tool-a\n  AUTH: profile-one\n\nTOOL tool-b\n  AUTH: profile-two`;
    const result = extractAuthProfileReferences(dsl);
    expect(result).toEqual(['profile-one', 'profile-two']);
  });

  it('deduplicates repeated auth references', () => {
    const dsl = `TOOL tool-a\n  AUTH: shared-profile\n\nTOOL tool-b\n  AUTH: shared-profile`;
    const result = extractAuthProfileReferences(dsl);
    expect(result).toEqual(['shared-profile']);
  });

  it('returns empty array when no AUTH: references', () => {
    const dsl = 'TOOL my-tool\n  TYPE: http\n  URL: https://api.example.com';
    expect(extractAuthProfileReferences(dsl)).toEqual([]);
  });

  it('is case-insensitive for AUTH keyword', () => {
    const dsl = `TOOL tool-a\n  auth: lowercase-profile\n  Auth: mixedcase-profile`;
    const result = extractAuthProfileReferences(dsl);
    expect(result).toEqual(['lowercase-profile', 'mixedcase-profile']);
  });
});

describe('scanProjectAuthProfiles', () => {
  it('scans across multiple agents and tools', () => {
    const agents = [
      { dslContent: 'TOOL t1\n  AUTH: profile-a' },
      { dslContent: 'TOOL t2\n  AUTH: profile-b' },
    ];
    const tools = [{ dslContent: 'TOOL t3\n  AUTH: profile-c' }];
    expect(scanProjectAuthProfiles(agents, tools)).toEqual(['profile-a', 'profile-b', 'profile-c']);
  });

  it('deduplicates across agents and tools', () => {
    const agents = [{ dslContent: 'TOOL t1\n  AUTH: shared' }];
    const tools = [{ dslContent: 'TOOL t2\n  AUTH: shared' }];
    expect(scanProjectAuthProfiles(agents, tools)).toEqual(['shared']);
  });

  it('returns empty array when no auth references', () => {
    const agents = [{ dslContent: 'plain text' }];
    const tools = [{ dslContent: 'no auth' }];
    expect(scanProjectAuthProfiles(agents, tools)).toEqual([]);
  });
});
