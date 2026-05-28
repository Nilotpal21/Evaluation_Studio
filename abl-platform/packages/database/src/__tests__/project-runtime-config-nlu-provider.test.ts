/**
 * Tests for nlu_provider and advanced sidecar fields on ProjectRuntimeConfig.extraction
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';
import { ProjectRuntimeConfig } from '../models/project-runtime-config.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

describe('ProjectRuntimeConfig nlu_provider fields', () => {
  const validConfig = () => ({
    tenantId: 'tenant-nlu-1',
    projectId: 'proj-nlu-1',
  });

  it('should default nlu_provider to "standard"', () => {
    const doc = new ProjectRuntimeConfig(validConfig());
    expect(doc.extraction.nlu_provider).toBe('standard');
  });

  it('should accept nlu_provider "advanced" with a sidecar URL', () => {
    const doc = new ProjectRuntimeConfig({
      ...validConfig(),
      extraction: {
        nlu_provider: 'advanced',
        advanced_sidecar_url: 'http://kore-nlu:8090',
      },
    });
    expect(doc.extraction.nlu_provider).toBe('advanced');
    expect(doc.extraction.advanced_sidecar_url).toBe('http://kore-nlu:8090');
  });

  it('should have advanced_sidecar_url as optional', () => {
    const doc = new ProjectRuntimeConfig({
      ...validConfig(),
      extraction: {
        nlu_provider: 'standard',
      },
    });
    expect(doc.extraction.nlu_provider).toBe('standard');
    expect(doc.extraction.advanced_sidecar_url).toBeUndefined();
  });

  it('should default advanced_sidecar_timeout_ms to 3000', () => {
    const doc = new ProjectRuntimeConfig(validConfig());
    expect(doc.extraction.advanced_sidecar_timeout_ms).toBe(3000);
  });

  it('should default advanced_sidecar_circuit_breaker_threshold to 5', () => {
    const doc = new ProjectRuntimeConfig(validConfig());
    expect(doc.extraction.advanced_sidecar_circuit_breaker_threshold).toBe(5);
  });

  it('should reject invalid nlu_provider enum value', () => {
    const doc = new ProjectRuntimeConfig({
      ...validConfig(),
      extraction: {
        nlu_provider: 'invalid_provider',
      },
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors['extraction.nlu_provider']).toBeDefined();
  });

  it('should allow custom advanced_sidecar_timeout_ms', () => {
    const doc = new ProjectRuntimeConfig({
      ...validConfig(),
      extraction: {
        nlu_provider: 'advanced',
        advanced_sidecar_url: 'http://kore-nlu:8090',
        advanced_sidecar_timeout_ms: 5000,
      },
    });
    expect(doc.extraction.advanced_sidecar_timeout_ms).toBe(5000);
  });

  it('should allow custom advanced_sidecar_circuit_breaker_threshold', () => {
    const doc = new ProjectRuntimeConfig({
      ...validConfig(),
      extraction: {
        nlu_provider: 'advanced',
        advanced_sidecar_url: 'http://kore-nlu:8090',
        advanced_sidecar_circuit_breaker_threshold: 10,
      },
    });
    expect(doc.extraction.advanced_sidecar_circuit_breaker_threshold).toBe(10);
  });

  it('should persist and retrieve nlu_provider fields from MongoDB', async (ctx) => {
    if (!isMongoReady()) return ctx.skip();
    const doc = new ProjectRuntimeConfig({
      ...validConfig(),
      extraction: {
        strategy: 'auto',
        nlu_provider: 'advanced',
        advanced_sidecar_url: 'http://kore-nlu:8090',
        advanced_sidecar_timeout_ms: 4000,
        advanced_sidecar_circuit_breaker_threshold: 3,
      },
    });
    await doc.save();

    const found = await ProjectRuntimeConfig.findOne({
      tenantId: 'tenant-nlu-1',
      projectId: 'proj-nlu-1',
    });
    expect(found).toBeDefined();
    expect(found!.extraction.nlu_provider).toBe('advanced');
    expect(found!.extraction.advanced_sidecar_url).toBe('http://kore-nlu:8090');
    expect(found!.extraction.advanced_sidecar_timeout_ms).toBe(4000);
    expect(found!.extraction.advanced_sidecar_circuit_breaker_threshold).toBe(3);
  });
});
