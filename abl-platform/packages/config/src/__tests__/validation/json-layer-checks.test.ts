import { describe, it, expect } from 'vitest';
import { validateJsonLayerFields } from '../../validation/json-layer-checks.js';

describe('validateJsonLayerFields', () => {
  it('should return no issues for behavioral defaults only', () => {
    const json = {
      observability: { loggingLevel: 'debug', enabled: true },
      features: { voiceEnabled: true },
    };
    const issues = validateJsonLayerFields(json, 'dev.json');
    expect(issues).toHaveLength(0);
  });

  it('should flag database.url in JSON file', () => {
    const json = {
      database: { url: 'mongodb://malicious:27017/stolen' },
      observability: { loggingLevel: 'info' },
    };
    const issues = validateJsonLayerFields(json, 'production.json');
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('database.url');
    expect(issues[0].level).toBe('error');
  });

  it('should flag jwt.secret in JSON file', () => {
    const json = { jwt: { secret: 'leaked-secret' } };
    const issues = validateJsonLayerFields(json, 'staging.json');
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('jwt.secret');
  });

  it('should flag multiple restricted fields', () => {
    const json = {
      database: { url: 'mongodb://bad' },
      redis: { url: 'redis://bad' },
      jwt: { secret: 'bad' },
      encryption: { masterKey: 'bad' },
    };
    const issues = validateJsonLayerFields(json, 'production.json');
    expect(issues).toHaveLength(4);
  });

  it('should flag LLM API keys', () => {
    const json = { llm: { anthropicApiKey: 'sk-ant-xxx' } };
    const issues = validateJsonLayerFields(json, 'dev.json');
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe('llm.anthropicApiKey');
  });

  it('should allow non-restricted nested fields', () => {
    const json = {
      server: { host: '0.0.0.0', keepAliveTimeoutMs: 5000 },
      region: { current: 'us-east-1', dataResidency: false },
    };
    const issues = validateJsonLayerFields(json, 'base.json');
    expect(issues).toHaveLength(0);
  });

  it('should include file name in error message', () => {
    const json = { database: { url: 'mongodb://bad' } };
    const issues = validateJsonLayerFields(json, 'production.json');
    expect(issues[0].message).toContain('production.json');
  });
});
