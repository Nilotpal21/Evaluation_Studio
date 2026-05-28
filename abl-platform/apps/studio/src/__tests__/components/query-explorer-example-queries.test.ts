/**
 * QueryExplorerTab — SQL example-query contract tests
 *
 * Every SQL in EXAMPLE_QUERIES_BY_TABLE is sent directly to the runtime
 * POST /sql-query validator, which rejects queries that lack:
 *   tenant_id = {tenantId:String}
 *   project_id = {projectId:String}
 *
 * This test catches any example query that would be immediately rejected
 * before a user even edits it — a confusing UX failure.
 */

import { describe, expect, it } from 'vitest';
import { EXAMPLE_QUERIES_BY_TABLE } from '../../components/analytics/QueryExplorerTab';

const TENANT_FILTER = /\btenant_id\s*=\s*\{tenantId:String\}/i;
const PROJECT_FILTER = /\bproject_id\s*=\s*\{projectId:String\}/i;

describe('EXAMPLE_QUERIES_BY_TABLE — SQL security-filter invariants', () => {
  it('defines at least one example query for every registered table', () => {
    const tables = Object.keys(EXAMPLE_QUERIES_BY_TABLE);
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect(
        EXAMPLE_QUERIES_BY_TABLE[table]?.length,
        `${table} has no example queries`,
      ).toBeGreaterThan(0);
    }
  });

  it('includes messages and custom_pipeline_results in the fallback table list', () => {
    const tables = Object.keys(EXAMPLE_QUERIES_BY_TABLE);
    expect(tables).toContain('abl_platform.messages');
    expect(tables).toContain('abl_platform.custom_pipeline_results');
  });

  it.each(
    Object.entries(EXAMPLE_QUERIES_BY_TABLE).flatMap(([table, queries]) =>
      queries.map((q, i) => ({ table, label: q.label, index: i, sql: q.sql })),
    ),
  )('$table › "$label" contains tenant_id and project_id filters', ({ table, label, sql }) => {
    expect(
      TENANT_FILTER.test(sql),
      `${table} › "${label}": missing tenant_id = {tenantId:String}`,
    ).toBe(true);

    expect(
      PROJECT_FILTER.test(sql),
      `${table} › "${label}": missing project_id = {projectId:String}`,
    ).toBe(true);
  });

  it('messages example queries reference the messages table in the FROM clause', () => {
    const queries = EXAMPLE_QUERIES_BY_TABLE['abl_platform.messages'] ?? [];
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(
        q.sql,
        `messages › "${q.label}": FROM clause does not target abl_platform.messages`,
      ).toMatch(/FROM\s+abl_platform\.messages/i);
    }
  });

  it('custom_pipeline_results example queries reference the correct table', () => {
    const queries = EXAMPLE_QUERIES_BY_TABLE['abl_platform.custom_pipeline_results'] ?? [];
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(
        q.sql,
        `custom_pipeline_results › "${q.label}": FROM clause does not target abl_platform.custom_pipeline_results`,
      ).toMatch(/FROM\s+abl_platform\.custom_pipeline_results/i);
    }
  });
});
