import { describe, it, expect, beforeEach } from 'vitest';
import { PromptLoaderService } from '../prompts/prompt-loader.service.js';

// ─── Tests ───────────────────────────────────────────────────────────────

describe('PromptLoaderService', () => {
  let service: PromptLoaderService;

  beforeEach(() => {
    service = new PromptLoaderService();
  });

  describe('constructor', () => {
    it('initializes service with empty cache', () => {
      const stats = service.getCacheStats();
      expect(stats.size).toBe(0);
      expect(stats.keys).toEqual([]);
    });
  });

  describe('loadPrompt', () => {
    it('loads prompt by name and version', () => {
      const prompt = service.loadPrompt('critical-field-detection', 1);

      expect(prompt).toBeDefined();
      expect(prompt.metadata).toBeDefined();
      expect(prompt.metadata.version).toBe(1);
      expect(prompt.metadata.author).toBe('System');
      expect(prompt.metadata.model).toBe('claude-sonnet-4-20250514');
      expect(prompt.system_prompt).toContain('expert at analyzing data schemas');
    });

    it('loads different version of same prompt', () => {
      const promptV1 = service.loadPrompt('critical-field-detection', 1);
      const promptV2 = service.loadPrompt('critical-field-detection', 2);

      expect(promptV1.metadata.version).toBe(1);
      expect(promptV2.metadata.version).toBe(2);
      expect(promptV1.system_prompt).not.toBe(promptV2.system_prompt);
    });

    it('caches loaded prompts', () => {
      const prompt1 = service.loadPrompt('critical-field-detection', 1);
      const statsAfterFirst = service.getCacheStats();

      expect(statsAfterFirst.size).toBe(1);
      expect(statsAfterFirst.keys).toContain('critical-field-detection:v1');

      // Second load should use cache
      const prompt2 = service.loadPrompt('critical-field-detection', 1);
      const statsAfterSecond = service.getCacheStats();

      expect(statsAfterSecond.size).toBe(1); // Still 1 cached
      expect(prompt1).toEqual(prompt2); // Same object
    });

    it('caches multiple versions separately', () => {
      service.loadPrompt('critical-field-detection', 1);
      service.loadPrompt('critical-field-detection', 2);

      const stats = service.getCacheStats();
      expect(stats.size).toBe(2);
      expect(stats.keys).toContain('critical-field-detection:v1');
      expect(stats.keys).toContain('critical-field-detection:v2');
    });

    it('defaults to version 1 when version not specified', () => {
      const prompt = service.loadPrompt('critical-field-detection');

      expect(prompt.metadata.version).toBe(1);
    });

    it('throws error for non-existent prompt', () => {
      expect(() => {
        service.loadPrompt('non-existent-prompt', 1);
      }).toThrow('Prompt not found: non-existent-prompt v1');
    });

    it('throws error for non-existent version', () => {
      expect(() => {
        service.loadPrompt('critical-field-detection', 999);
      }).toThrow('Prompt not found: critical-field-detection v999');
    });

    it('parses YAML prompt structure correctly', () => {
      const prompt = service.loadPrompt('critical-field-detection', 1);

      // Metadata
      expect(prompt.metadata.version).toBe(1);
      expect(prompt.metadata.author).toBe('System');
      expect(prompt.metadata.created).toBe('2026-03-07');
      expect(prompt.metadata.description).toContain('Critical field detection');
      expect(prompt.metadata.model).toBe('claude-sonnet-4-20250514');
      expect(prompt.metadata.performance.max_latency_ms).toBe(5000);
      expect(prompt.metadata.performance.max_tokens).toBe(2000);

      // System prompt
      expect(prompt.system_prompt).toBeDefined();
      expect(typeof prompt.system_prompt).toBe('string');

      // Tool
      expect(prompt.tool).toBeDefined();
      expect(prompt.tool.name).toBe('detect_critical_fields');

      // Test cases
      expect(prompt.test_cases).toBeDefined();
      expect(Array.isArray(prompt.test_cases)).toBe(true);
      expect(prompt.test_cases!.length).toBeGreaterThan(0);

      // Changelog
      expect(prompt.changelog).toBeDefined();
      expect(Array.isArray(prompt.changelog)).toBe(true);
    });
  });

  describe('loadLatestPrompt', () => {
    it('loads latest version of prompt', () => {
      const latest = service.loadLatestPrompt('critical-field-detection');

      expect(latest).toBeDefined();
      expect(latest.metadata.version).toBe(2); // v2 is latest
    });

    it('throws error for non-existent prompt', () => {
      expect(() => {
        service.loadLatestPrompt('non-existent-prompt');
      }).toThrow('No versions found for prompt: non-existent-prompt');
    });

    it('caches loaded latest version', () => {
      service.loadLatestPrompt('critical-field-detection');

      const stats = service.getCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.keys).toContain('critical-field-detection:v2');
    });
  });

  describe('renderPrompt', () => {
    it('replaces single placeholder', () => {
      const template = 'Hello, {name}!';
      const rendered = service.renderPrompt(template, { name: 'Alice' });

      expect(rendered).toBe('Hello, Alice!');
    });

    it('replaces multiple placeholders', () => {
      const template = 'Domain: {domain}, Connector: {connector}, Type: {type}';
      const rendered = service.renderPrompt(template, {
        domain: 'Project Management',
        connector: 'Jira',
        type: 'issue',
      });

      expect(rendered).toBe('Domain: Project Management, Connector: Jira, Type: issue');
    });

    it('replaces same placeholder multiple times', () => {
      const template = '{name} is great. {name} is awesome. {name} rocks!';
      const rendered = service.renderPrompt(template, { name: 'Claude' });

      expect(rendered).toBe('Claude is great. Claude is awesome. Claude rocks!');
    });

    it('handles placeholders with no matching variable', () => {
      const template = 'Hello, {name}! You are {age} years old.';
      const rendered = service.renderPrompt(template, { name: 'Alice' });

      expect(rendered).toBe('Hello, Alice! You are {age} years old.');
    });

    it('converts non-string values to strings', () => {
      const template = 'Count: {count}, Active: {active}, Price: {price}';
      const rendered = service.renderPrompt(template, {
        count: 42,
        active: true,
        price: 19.99,
      });

      expect(rendered).toBe('Count: 42, Active: true, Price: 19.99');
    });

    it('handles empty variables object', () => {
      const template = 'Hello, {name}!';
      const rendered = service.renderPrompt(template, {});

      expect(rendered).toBe('Hello, {name}!');
    });

    it('handles special regex characters in placeholders', () => {
      const template = 'Pattern: {pattern}, Value: {value}';
      const rendered = service.renderPrompt(template, {
        pattern: '$100.00',
        value: '(test)',
      });

      expect(rendered).toBe('Pattern: $100.00, Value: (test)');
    });

    it('renders real prompt with variables', () => {
      const prompt = service.loadPrompt('critical-field-detection', 1);
      const rendered = service.renderPrompt(prompt.system_prompt, {
        domain: 'Project Management',
        connectorType: 'jira',
      });

      expect(rendered).toContain('Project Management');
      expect(rendered).toContain('jira');
      expect(rendered).not.toContain('{domain}');
      expect(rendered).not.toContain('{connectorType}');
    });
  });

  describe('clearCache', () => {
    it('clears all caches when no name specified', () => {
      service.loadPrompt('critical-field-detection', 1);
      service.loadPrompt('critical-field-detection', 2);

      const statsBeforeClear = service.getCacheStats();
      expect(statsBeforeClear.size).toBe(2);

      service.clearCache();

      const statsAfterClear = service.getCacheStats();
      expect(statsAfterClear.size).toBe(0);
      expect(statsAfterClear.keys).toEqual([]);
    });

    it('clears specific prompt cache when name specified', () => {
      service.loadPrompt('critical-field-detection', 1);
      service.loadPrompt('critical-field-detection', 2);

      service.clearCache('critical-field-detection');

      const stats = service.getCacheStats();
      expect(stats.size).toBe(0);
      expect(stats.keys).toEqual([]);
    });

    it('does not affect other prompts when clearing specific prompt', () => {
      service.loadPrompt('critical-field-detection', 1);

      // Load the same prompt twice to populate cache
      service.loadPrompt('critical-field-detection', 1);

      // Clear non-existent prompt
      service.clearCache('other-prompt');

      const stats = service.getCacheStats();
      expect(stats.size).toBe(1); // critical-field-detection still cached
      expect(stats.keys).toContain('critical-field-detection:v1');
    });

    it('reloads prompt after cache clear', () => {
      const prompt1 = service.loadPrompt('critical-field-detection', 1);
      service.clearCache();
      const prompt2 = service.loadPrompt('critical-field-detection', 1);

      expect(prompt1).toEqual(prompt2); // Same content
      const stats = service.getCacheStats();
      expect(stats.size).toBe(1); // Re-cached
    });
  });

  describe('getCacheStats', () => {
    it('returns correct cache size and keys', () => {
      service.loadPrompt('critical-field-detection', 1);
      service.loadPrompt('critical-field-detection', 2);

      const stats = service.getCacheStats();

      expect(stats.size).toBe(2);
      expect(stats.keys).toHaveLength(2);
      expect(stats.keys).toContain('critical-field-detection:v1');
      expect(stats.keys).toContain('critical-field-detection:v2');
    });

    it('returns empty stats for new service', () => {
      const stats = service.getCacheStats();

      expect(stats.size).toBe(0);
      expect(stats.keys).toEqual([]);
    });
  });

  describe('version management', () => {
    it('detects multiple versions of same prompt', () => {
      // Load v1 and v2
      const v1 = service.loadPrompt('critical-field-detection', 1);
      const v2 = service.loadPrompt('critical-field-detection', 2);

      expect(v1.metadata.version).toBe(1);
      expect(v2.metadata.version).toBe(2);
      expect(v1.metadata.created).toBe('2026-03-07');
      expect(v2.metadata.created).toBe('2026-03-08');
    });

    it('loads latest when multiple versions exist', () => {
      const latest = service.loadLatestPrompt('critical-field-detection');

      // Should be v2
      expect(latest.metadata.version).toBe(2);
      expect(latest.metadata.description).toContain('v2 with improved accuracy');
    });

    it('handles changelog across versions', () => {
      const v1 = service.loadPrompt('critical-field-detection', 1);
      const v2 = service.loadPrompt('critical-field-detection', 2);

      expect(v1.changelog).toBeDefined();
      expect(v2.changelog).toBeDefined();
      expect(v2.changelog!.length).toBeGreaterThan(v1.changelog!.length); // v2 has more history
    });
  });

  describe('performance metadata', () => {
    it('includes performance constraints in metadata', () => {
      const prompt = service.loadPrompt('critical-field-detection', 1);

      expect(prompt.metadata.performance).toBeDefined();
      expect(prompt.metadata.performance.max_latency_ms).toBe(5000);
      expect(prompt.metadata.performance.max_tokens).toBe(2000);
    });

    it('different versions have different performance constraints', () => {
      const v1 = service.loadPrompt('critical-field-detection', 1);
      const v2 = service.loadPrompt('critical-field-detection', 2);

      expect(v1.metadata.performance.max_latency_ms).toBe(5000);
      expect(v2.metadata.performance.max_latency_ms).toBe(4500); // Improved in v2
    });
  });
});
