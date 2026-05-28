import { describe, it, expect } from 'vitest';
import { resolveTestScripts } from '../../../commands/benchmark/test-runner.js';

describe('resolveTestScripts', () => {
  describe('integration scripts', () => {
    it('carries services[] for each integration script', () => {
      const scripts = resolveTestScripts([], 'integration'); // [] = @all

      const agentConv = scripts.find((s) => s.serviceName === 'agent-conversation-e2e');
      expect(agentConv).toBeDefined();
      expect(agentConv!.services).toEqual(['runtime']);

      const kbIngestion = scripts.find((s) => s.serviceName === 'kb-ingestion-e2e');
      expect(kbIngestion).toBeDefined();
      expect(kbIngestion!.services).toEqual(['search-ai']);

      const channelMsg = scripts.find((s) => s.serviceName === 'channel-message-e2e');
      expect(channelMsg).toBeDefined();
      expect(channelMsg!.services).toEqual(['runtime', 'studio']);
    });

    it('filters by service name and picks up matching integration scripts', () => {
      const scripts = resolveTestScripts(['runtime'], 'integration');
      const names = scripts.map((s) => s.serviceName);

      expect(names).toContain('agent-conversation-e2e');
      expect(names).toContain('multi-agent-orchestration');
      expect(names).toContain('channel-message-e2e');
      expect(names).not.toContain('kb-ingestion-e2e');
    });

    it('filters by integration script name directly', () => {
      const scripts = resolveTestScripts(['kb-ingestion-e2e'], 'integration');
      expect(scripts).toHaveLength(1);
      expect(scripts[0].serviceName).toBe('kb-ingestion-e2e');
      expect(scripts[0].services).toEqual(['search-ai']);
    });
  });

  describe('service scripts', () => {
    it('does not populate services[] for service scripts', () => {
      const scripts = resolveTestScripts([], 'service');
      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) {
        expect(script.services).toBeUndefined();
      }
    });
  });

  describe('saturation scripts', () => {
    it('does not populate services[] for saturation scripts', () => {
      const scripts = resolveTestScripts([], 'saturation');
      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) {
        expect(script.services).toBeUndefined();
      }
    });
  });
});
