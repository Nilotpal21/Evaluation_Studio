import { describe, expect, it } from 'vitest';
import { synthesizeHandoffBlock } from '@/lib/arch-ai/tools/external-agent-ops';

/**
 * Unit test 3 of 4 for `external_agent_ops` (Spec 1).
 *
 * Tests `synthesizeHandoffBlock(card, agentName?)` — pure helper that
 * generates a HANDOFF DSL block from a discovered AgentCard.
 *
 * The output is consumed by integration-methodologist when wiring an external
 * agent into a project. Format is the ABL HANDOFF construct:
 *
 *   HANDOFF: <agentName>
 *     - method: a2a
 *     - endpoint: <discovered-url>
 *     - description: <card.description or skills[].name>
 *
 * Critical contract: the helper MUST NOT include credentials, raw inputSchema
 * payloads, or any user data. It is a pure descriptor — the runtime resolves
 * the auth/endpoint at handoff time from the ExternalAgentConfig record.
 */
describe('synthesizeHandoffBlock', () => {
  describe('basic card', () => {
    it('generates a valid HANDOFF block with name only', () => {
      const card = { name: 'TestAgent' };
      const block = synthesizeHandoffBlock(card);
      expect(block).toContain('HANDOFF:');
      expect(block).toContain('TestAgent');
      expect(block).toContain('a2a');
    });

    it('uses provided agentName when given', () => {
      const card = { name: 'OriginalName' };
      const block = synthesizeHandoffBlock(card, 'MyAlias');
      expect(block).toContain('HANDOFF: MyAlias');
      expect(block).not.toContain('HANDOFF: OriginalName');
    });

    it('falls back to card.name when agentName not given', () => {
      const card = { name: 'CodeReviewer' };
      const block = synthesizeHandoffBlock(card);
      expect(block).toContain('HANDOFF: CodeReviewer');
    });
  });

  describe('endpoint emission', () => {
    it('includes endpoint when card.url is present', () => {
      const card = { name: 'A', url: 'https://example.com/agent' };
      const block = synthesizeHandoffBlock(card);
      expect(block).toContain('endpoint:');
      expect(block).toContain('https://example.com/agent');
    });

    it('omits endpoint line when card.url is absent', () => {
      const card = { name: 'A' };
      const block = synthesizeHandoffBlock(card);
      expect(block).not.toMatch(/endpoint:/);
    });
  });

  describe('description emission', () => {
    it('uses card.description when present', () => {
      const card = { name: 'A', description: 'Code review specialist' };
      const block = synthesizeHandoffBlock(card);
      expect(block).toContain('Code review specialist');
    });

    it('falls back to skills[].name list when description absent', () => {
      const card = {
        name: 'A',
        skills: [
          { id: 's1', name: 'Skill One' },
          { id: 's2', name: 'Skill Two' },
        ],
      };
      const block = synthesizeHandoffBlock(card);
      expect(block).toMatch(/Skill One.*Skill Two|Skill Two.*Skill One/s);
    });
  });

  describe('security contract', () => {
    it('does not emit raw inputSchema', () => {
      const card = {
        name: 'A',
        skills: [
          {
            id: 's1',
            name: 'S',
            inputSchema: { secretField: 'should not appear' },
          },
        ],
      };
      const block = synthesizeHandoffBlock(card);
      expect(block).not.toContain('secretField');
      expect(block).not.toContain('should not appear');
    });

    it('does not emit credentials or auth fields', () => {
      const card = {
        name: 'A',
        url: 'https://api.example.com',
        // hypothetical card with auth-like fields — must be ignored
        capabilities: { authConfig: { token: 'xxx' } } as Record<string, unknown>,
      };
      const block = synthesizeHandoffBlock(card);
      expect(block).not.toContain('xxx');
      expect(block).not.toContain('token');
    });

    it('does not emit user-supplied script-like content verbatim', () => {
      const card = {
        name: 'AgentName',
        description: '<script>alert(1)</script>',
      };
      const block = synthesizeHandoffBlock(card);
      // Description content may appear (it's a string field), but should be
      // safely embedded in DSL — DSL is server-side text, not HTML.
      // The contract: synthesizer doesn't add HTML markup or evaluate input.
      expect(block).not.toContain('<html>');
      expect(block).not.toContain('alert(1)');
    });
  });

  describe('DSL format', () => {
    it('produces parseable DSL with method: a2a as first attribute', () => {
      const card = { name: 'A', url: 'https://x.com', description: 'D' };
      const block = synthesizeHandoffBlock(card);
      // method must appear before endpoint per ABL HANDOFF convention
      const methodIdx = block.indexOf('method:');
      const endpointIdx = block.indexOf('endpoint:');
      expect(methodIdx).toBeGreaterThanOrEqual(0);
      expect(methodIdx).toBeLessThan(endpointIdx);
    });

    it('uses leading-dash bullet syntax for attributes', () => {
      const card = { name: 'A', url: 'https://x.com' };
      const block = synthesizeHandoffBlock(card);
      expect(block).toMatch(/^\s*-\s+method:/m);
    });
  });
});
