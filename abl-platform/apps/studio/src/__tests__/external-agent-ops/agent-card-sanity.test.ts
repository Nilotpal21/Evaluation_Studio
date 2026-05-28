import { describe, expect, it } from 'vitest';
import { parseAndValidateAgentCard } from '@/lib/arch-ai/tools/external-agent-ops';

/**
 * Unit test 2 of 4 for `external_agent_ops` (Spec 1).
 *
 * Tests `parseAndValidateAgentCard(json)` — the Zod safety-net pure helper
 * that protects against malformed AgentCard responses (D-11).
 *
 * The schema is a SUBSET of @a2a-js/sdk's `AgentCard` type — we only enforce
 * the fields downstream consumers actually rely on (name, skills[].id,
 * skills[].name). Other fields are permissive (optional, unknown).
 *
 * R6 MED-1: schema doc — `lastDiscoveredCard` is wired to `ExternalAgentCardEvent`'s
 *           strongly-typed payload. The Zod safety net here is the runtime guard.
 */
describe('parseAndValidateAgentCard', () => {
  describe('valid agent cards', () => {
    it('accepts minimal valid card with name only', () => {
      const result = parseAndValidateAgentCard({ name: 'TestAgent' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.card.name).toBe('TestAgent');
      }
    });

    it('accepts well-formed card with skills', () => {
      const card = {
        name: 'CodeReviewAgent',
        description: 'Reviews PRs',
        url: 'https://review.example.com',
        protocolVersion: '0.3.0',
        skills: [
          {
            id: 'review-pr',
            name: 'Review PR',
            description: 'Reviews a single PR',
            inputSchema: { type: 'object', properties: { prUrl: { type: 'string' } } },
          },
          {
            id: 'summarize-diff',
            name: 'Summarize Diff',
          },
        ],
        capabilities: { streaming: true, multiTurn: true },
      };
      const result = parseAndValidateAgentCard(card);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.card.name).toBe('CodeReviewAgent');
        expect(result.card.skills).toHaveLength(2);
        expect(result.card.skills?.[0].id).toBe('review-pr');
      }
    });

    it('strips unknown top-level fields rather than failing', () => {
      const result = parseAndValidateAgentCard({
        name: 'Agent',
        randomFutureField: 'whatever',
      });
      expect(result.ok).toBe(true);
    });

    it('accepts empty skills array', () => {
      const result = parseAndValidateAgentCard({ name: 'Agent', skills: [] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.card.skills).toEqual([]);
      }
    });
  });

  describe('rejected agent cards', () => {
    it('rejects null', () => {
      const result = parseAndValidateAgentCard(null);
      expect(result.ok).toBe(false);
    });

    it('rejects undefined', () => {
      const result = parseAndValidateAgentCard(undefined);
      expect(result.ok).toBe(false);
    });

    it('rejects non-object (string)', () => {
      const result = parseAndValidateAgentCard('not an object');
      expect(result.ok).toBe(false);
    });

    it('rejects non-object (number)', () => {
      const result = parseAndValidateAgentCard(42);
      expect(result.ok).toBe(false);
    });

    it('rejects array', () => {
      const result = parseAndValidateAgentCard([]);
      expect(result.ok).toBe(false);
    });

    it('rejects card missing name', () => {
      const result = parseAndValidateAgentCard({ description: 'no name' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/name/i);
      }
    });

    it('rejects card with name as non-string', () => {
      const result = parseAndValidateAgentCard({ name: 42 });
      expect(result.ok).toBe(false);
    });

    it('rejects card with empty-string name', () => {
      const result = parseAndValidateAgentCard({ name: '' });
      expect(result.ok).toBe(false);
    });

    it('rejects skills not as array', () => {
      const result = parseAndValidateAgentCard({ name: 'A', skills: 'not-array' });
      expect(result.ok).toBe(false);
    });

    it('rejects skills entry missing id', () => {
      const result = parseAndValidateAgentCard({
        name: 'A',
        skills: [{ name: 'no-id-skill' }],
      });
      expect(result.ok).toBe(false);
    });

    it('rejects skills entry missing name', () => {
      const result = parseAndValidateAgentCard({
        name: 'A',
        skills: [{ id: 'skill-1' }],
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('return value contract', () => {
    it('returns canonical {ok: true, card} envelope on success', () => {
      const result = parseAndValidateAgentCard({ name: 'Agent' });
      expect(result).toMatchObject({ ok: true, card: expect.any(Object) });
    });

    it('returns canonical {ok: false, error} envelope on failure', () => {
      const result = parseAndValidateAgentCard({});
      expect(result).toMatchObject({ ok: false, error: expect.any(String) });
    });
  });
});
