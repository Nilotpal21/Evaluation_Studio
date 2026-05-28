/**
 * Service Registry Tests
 *
 * Pure logic tests — no mocks needed.
 */

import { describe, it, expect } from 'vitest';
import {
  SERVICE_REGISTRY,
  SERVICE_CATEGORIES,
  SERVICE_TEST_ORDER,
  resolveServices,
} from '../../../commands/benchmark/service-registry.js';

describe('SERVICE_REGISTRY', () => {
  it('should contain 16 services', () => {
    expect(Object.keys(SERVICE_REGISTRY)).toHaveLength(16);
  });

  it('should have required fields for every entry', () => {
    for (const [name, entry] of Object.entries(SERVICE_REGISTRY)) {
      expect(entry.configKey).toBeTruthy();
      expect(entry.deploymentName).toBeTruthy();
      expect(['compute', 'data-stores', 'ai', 'integration']).toContain(entry.category);
      // k6Script may be null
      expect(typeof entry.k6Script === 'string' || entry.k6Script === null).toBe(true);
    }
  });

  it('should have unique configKeys', () => {
    const keys = Object.values(SERVICE_REGISTRY).map((e) => e.configKey);
    expect(keys).toHaveLength(new Set(keys).size);
  });

  it('should have unique deploymentNames', () => {
    const names = Object.values(SERVICE_REGISTRY).map((e) => e.deploymentName);
    expect(names).toHaveLength(new Set(names).size);
  });
});

describe('SERVICE_CATEGORIES', () => {
  it('should define 5 categories', () => {
    expect(Object.keys(SERVICE_CATEGORIES)).toHaveLength(5);
  });

  it('@all should contain all 16 services', () => {
    const all = SERVICE_CATEGORIES['@all'];
    expect(all).toHaveLength(16);
    for (const svc of all) {
      expect(SERVICE_REGISTRY[svc]).toBeDefined();
    }
  });

  it('category members should be valid service names', () => {
    for (const [cat, members] of Object.entries(SERVICE_CATEGORIES)) {
      for (const svc of members) {
        expect(SERVICE_REGISTRY[svc], `${svc} in ${cat} not in registry`).toBeDefined();
      }
    }
  });
});

describe('SERVICE_TEST_ORDER', () => {
  it('should contain all 16 services', () => {
    expect(SERVICE_TEST_ORDER).toHaveLength(16);
  });

  it('should list data stores before app services', () => {
    const mongoIdx = SERVICE_TEST_ORDER.indexOf('mongodb');
    const runtimeIdx = SERVICE_TEST_ORDER.indexOf('runtime');
    expect(mongoIdx).toBeLessThan(runtimeIdx);
  });

  it('should list AI services before app services', () => {
    const bgeIdx = SERVICE_TEST_ORDER.indexOf('bge-m3');
    const searchAiIdx = SERVICE_TEST_ORDER.indexOf('search-ai');
    expect(bgeIdx).toBeLessThan(searchAiIdx);
  });
});

describe('resolveServices', () => {
  it('should resolve individual service names', () => {
    const result = resolveServices(['runtime', 'mongodb']);
    expect(result).toEqual(['mongodb', 'runtime']);
  });

  it('should resolve category aliases', () => {
    const result = resolveServices(['@ai']);
    expect(result).toEqual(['bge-m3', 'docling', 'preprocessing']);
  });

  it('should deduplicate when category and service overlap', () => {
    const result = resolveServices(['@ai', 'bge-m3']);
    expect(result).toEqual(['bge-m3', 'docling', 'preprocessing']);
  });

  it('should return services in test order', () => {
    const result = resolveServices(['runtime', 'redis', 'bge-m3']);
    expect(result).toEqual(['redis', 'bge-m3', 'runtime']);
  });

  it('should throw on unknown service name', () => {
    expect(() => resolveServices(['nonexistent'])).toThrow('Unknown service or category');
  });

  it('should handle @all', () => {
    const result = resolveServices(['@all']);
    expect(result).toHaveLength(16);
    expect(result[0]).toBe('mongodb'); // first in test order
    expect(result[result.length - 1]).toBe('runtime'); // last in test order
  });

  it('should handle empty input', () => {
    const result = resolveServices([]);
    expect(result).toEqual([]);
  });

  it('should merge multiple categories', () => {
    const result = resolveServices(['@data-stores', '@ai']);
    expect(result).toHaveLength(9); // 6 data stores + 3 AI
  });
});
