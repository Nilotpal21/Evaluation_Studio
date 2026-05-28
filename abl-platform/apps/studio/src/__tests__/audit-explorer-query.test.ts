import { describe, expect, it } from 'vitest';
import {
  buildStudioAuditExplorerSql,
  parseStudioAuditExplorerQuery,
} from '../lib/audit/audit-explorer-query';

describe('audit explorer query contract', () => {
  it('parses comprehensive workspace filters from URLSearchParams', () => {
    const query = parseStudioAuditExplorerQuery(
      new URLSearchParams({
        scope: 'workspace',
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-05-08T00:00:00.000Z',
        q: 'project-1',
        categories: 'auth_access,project_agent_configuration',
        action: 'login',
        eventTypes: 'agent.created,auth.user.failure',
        actor: 'user-1',
        actorTypes: 'user,admin',
        projectId: 'project-1',
        resourceTypes: 'session,agent',
        resourceId: 'resource-1',
        traceId: 'trace-1',
        sources: 'studio,runtime-store',
        environments: 'dev,production',
        success: 'failure',
        ipAddress: '10.0.',
        metadataKey: 'requestId',
        metadataValue: 'req-1',
        includeFacets: 'true',
        limit: '500',
        offset: '3',
      }),
    );

    expect(query).toEqual(
      expect.objectContaining({
        scope: 'workspace',
        limit: 200,
        offset: 3,
        query: 'project-1',
        categories: ['auth_access', 'project_agent_configuration'],
        actions: ['login'],
        eventTypes: ['agent.created', 'auth.user.failure'],
        actorTypes: ['user', 'admin'],
        projectId: 'project-1',
        resourceTypes: ['session', 'agent'],
        traceId: 'trace-1',
        sources: ['studio', 'runtime-store'],
        environments: ['dev', 'production'],
        success: 'failure',
        includeFacets: true,
      }),
    );
  });

  it('requires bounded dates for global search and metadata search', () => {
    expect(() => parseStudioAuditExplorerQuery(new URLSearchParams({ q: 'tenant' }))).toThrow(
      /from and to are required/,
    );
    expect(() =>
      parseStudioAuditExplorerQuery(new URLSearchParams({ metadataKey: 'requestId' })),
    ).toThrow(/from and to are required/);
  });

  it('flattens repeated comma-separated params and rejects partial numeric params', () => {
    const params = new URLSearchParams({
      categories: 'auth_access',
      limit: '50',
    });
    params.append('categories', 'project_agent_lifecycle,connectors_crawl');
    params.append('actions', 'login,logout');
    params.append('actions', 'project_created');

    const query = parseStudioAuditExplorerQuery(params);

    expect(query.categories).toEqual([
      'auth_access',
      'project_agent_configuration',
      'connector_configuration',
    ]);
    expect(query.actions).toEqual(['login', 'logout', 'project_created']);

    expect(() => parseStudioAuditExplorerQuery(new URLSearchParams({ limit: '10abc' }))).toThrow(
      /must be an integer/,
    );
    expect(() => parseStudioAuditExplorerQuery(new URLSearchParams({ offset: '1.5' }))).toThrow(
      /must be an integer/,
    );
  });

  it('normalizes legacy category query params and ignores retired operational categories', () => {
    const query = parseStudioAuditExplorerQuery(
      new URLSearchParams({
        categories: 'project_agent_lifecycle,runtime_sessions_traces,connectors_crawl',
      }),
    );

    expect(query.categories).toEqual(['project_agent_configuration', 'connector_configuration']);
  });

  it('rejects invalid dates and unsafe metadata keys', () => {
    expect(() =>
      parseStudioAuditExplorerQuery(
        new URLSearchParams({
          from: 'not-a-date',
          to: '2026-05-08T00:00:00.000Z',
        }),
      ),
    ).toThrow(/from must be a valid date/);
    expect(() =>
      parseStudioAuditExplorerQuery(
        new URLSearchParams({
          from: '2026-05-08T00:00:00.000Z',
          to: '2026-05-01T00:00:00.000Z',
        }),
      ),
    ).toThrow(/from must be before to/);
    expect(() =>
      parseStudioAuditExplorerQuery(
        new URLSearchParams({
          from: '2026-05-01T00:00:00.000Z',
          to: '2026-05-08T00:00:00.000Z',
          metadataKey: 'bad key',
        }),
      ),
    ).toThrow(/metadataKey must be a safe metadata path/);
  });

  it('builds tenant-scoped parameterized SQL with actions distinct from event types', () => {
    const sql = buildStudioAuditExplorerSql({
      scope: 'workspace',
      personalScopeMode: 'tenant-safe',
      tenantId: 'tenant-1',
      userId: 'user-1',
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-05-08T00:00:00.000Z',
      limit: 50,
      offset: 0,
      actions: ['login'],
      eventTypes: ['agent.created'],
      categories: ['auth_access'],
      actor: 'user-2',
      projectId: 'project-1',
      traceId: 'trace-1',
      success: 'failure',
      ipAddress: '10.0.',
    });

    expect(sql.rowsQuery).toContain('tenant_id = {tenantId:String}');
    expect(sql.rowsQuery).toContain('abl_platform.kms_audit_log');
    expect(sql.rowsQuery).toContain('abl_platform.pii_audit_log');
    expect(sql.rowsQuery).toContain('abl_platform.connector_audit_log');
    expect(sql.rowsQuery).toContain('action IN ({actions:Array(String)})');
    expect(sql.rowsQuery).toContain('IN ({eventTypes:Array(String)})');
    expect(sql.rowsQuery).toContain('startsWith');
    expect(sql.rowsQuery).toContain('session_id = {traceId:String}');
    expect(sql.rowsQuery).toContain('startsWith(actor_ip, {ipAddress:String})');
    expect(sql.queryParams).toEqual(
      expect.objectContaining({
        tenantId: 'tenant-1',
        complianceValues: expect.arrayContaining(['login', 'project_updated']),
        actions: ['login'],
        eventTypes: ['agent.created'],
        categoryValues: expect.arrayContaining(['auth.user.failure', 'login']),
        actorId: 'user-2',
        projectId: 'project-1',
        traceId: 'trace-1',
        success: 0,
        ipAddress: '10.0.',
      }),
    );
  });

  it('uses explicit project and agent configuration category filters', () => {
    const sql = buildStudioAuditExplorerSql({
      scope: 'workspace',
      personalScopeMode: 'tenant-safe',
      tenantId: 'tenant-1',
      userId: 'user-1',
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-05-08T00:00:00.000Z',
      limit: 50,
      offset: 0,
      categories: ['project_agent_configuration'],
    });

    expect(sql.queryParams).toEqual(
      expect.objectContaining({
        categoryValues: expect.arrayContaining(['agent_updated', 'agent_dsl_updated']),
      }),
    );
    expect(Object.values(sql.queryParams)).not.toContain('project_agents.');
  });

  it('applies the compliance allowlist even without explicit category filters', () => {
    const sql = buildStudioAuditExplorerSql({
      scope: 'workspace',
      personalScopeMode: 'tenant-safe',
      tenantId: 'tenant-1',
      userId: 'user-1',
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-05-08T00:00:00.000Z',
      limit: 50,
      offset: 0,
    });

    expect(sql.rowsQuery).toContain('complianceValues');
    expect(sql.queryParams.complianceValues).toEqual(
      expect.arrayContaining(['login', 'project_updated', 'audit_export_downloaded']),
    );
    expect(sql.queryParams.complianceValues).not.toContain('token_refresh');
    expect(sql.queryParams.complianceValues).not.toContain('tool.executed');
    expect(sql.queryParams.complianceValues).not.toContain('session.started');
  });
});
