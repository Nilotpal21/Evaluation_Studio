// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  buildEvalCaseConversationsQuery,
  buildEvalCaseScoresQuery,
  decodeEvalCasesCursor,
  encodeEvalCasesCursor,
} from '../../lib/eval-cases-query';

const PARAMS = {
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  runId: 'run-1',
  limit: 20,
};

describe('eval cases ClickHouse queries', () => {
  it('deduplicates conversation rows by latest created_at per case', () => {
    const { query } = buildEvalCaseConversationsQuery(PARAMS);

    expect(query).toContain('eval_conversations');
    expect(query).toMatch(/argMax\s*\(\s*conversation\s*,\s*created_at\s*\)/);
    expect(query).toContain('max(created_at) AS latest_created_at');
    expect(query).toContain('latest_created_at AS createdAt');
    expect(query).not.toContain('max(created_at) AS created_at');
    expect(query).toMatch(/GROUP BY\s+persona_id,\s*scenario_id,\s*variant_index/);
  });

  it('deduplicates score rows by latest created_at per case and evaluator', () => {
    const { query } = buildEvalCaseScoresQuery(PARAMS);

    expect(query).toContain('eval_scores');
    expect(query).toMatch(/argMax\s*\(\s*score\s*,\s*created_at\s*\)/);
    expect(query).toContain('max(created_at) AS latest_created_at');
    expect(query).toContain('latest_created_at AS createdAt');
    expect(query).not.toContain('max(created_at) AS created_at');
    expect(query).toMatch(/GROUP BY\s+persona_id,\s*scenario_id,\s*variant_index,\s*evaluator_id/);
  });

  it('scopes both queries by tenant, project, and run query params', () => {
    const conversations = buildEvalCaseConversationsQuery(PARAMS);
    const scores = buildEvalCaseScoresQuery(PARAMS);

    for (const spec of [conversations, scores]) {
      expect(spec.query).toContain('{tenantId: String}');
      expect(spec.query).toContain('{projectId: String}');
      expect(spec.query).toContain('{runId: String}');
      expect(spec.query_params).toMatchObject({
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        runId: 'run-1',
      });
      expect(spec.format).toBe('JSONEachRow');
    }
  });

  it('applies optional case filters as query params, not string interpolation', () => {
    const query = buildEvalCaseConversationsQuery({
      ...PARAMS,
      personaId: 'persona-1',
      scenarioId: 'scenario-1',
      variantIndex: 2,
    });

    expect(query.query).toContain('{personaId: String}');
    expect(query.query).toContain('{scenarioId: String}');
    expect(query.query).toContain('{variantIndex: UInt8}');
    expect(query.query).not.toContain('persona-1');
    expect(query.query_params).toMatchObject({
      personaId: 'persona-1',
      scenarioId: 'scenario-1',
      variantIndex: '2',
    });
  });

  it('applies score filters only to the score query', () => {
    const conversations = buildEvalCaseConversationsQuery({
      ...PARAMS,
      evaluatorId: 'eval-1',
      minScore: 2,
      maxScore: 4,
    });
    const scores = buildEvalCaseScoresQuery({
      ...PARAMS,
      evaluatorId: 'eval-1',
      minScore: 2,
      maxScore: 4,
    });

    expect(conversations.query).not.toContain('{evaluatorId: String}');
    expect(scores.query).toContain('{evaluatorId: String}');
    expect(scores.query).toContain('{minScore: Float32}');
    expect(scores.query).toContain('{maxScore: Float32}');
  });

  it('supports cursor pagination over the case tuple', () => {
    const cursor = encodeEvalCasesCursor({
      personaId: 'persona-1',
      scenarioId: 'scenario-2',
      variantIndex: 3,
    });
    const { query, query_params } = buildEvalCaseConversationsQuery({ ...PARAMS, cursor });

    expect(query).toContain('{cursorPersonaId: String}');
    expect(query).toContain('{cursorScenarioId: String}');
    expect(query).toContain('{cursorVariantIndex: UInt8}');
    expect(query_params).toMatchObject({
      cursorPersonaId: 'persona-1',
      cursorScenarioId: 'scenario-2',
      cursorVariantIndex: '3',
    });
  });

  it('rejects cursors outside the ClickHouse UInt8 variant range', () => {
    const cursor = Buffer.from(
      JSON.stringify({
        personaId: 'persona-1',
        scenarioId: 'scenario-2',
        variantIndex: 256,
      }),
    ).toString('base64url');

    expect(decodeEvalCasesCursor(cursor)).toBeNull();
  });
});
