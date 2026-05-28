import { beforeEach, describe, expect, test, vi } from 'vitest';

const { writerState } = vi.hoisted(() => ({
  writerState: new Map<string, { rows: unknown[]; flushes: number; closes: number }>(),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  BufferedClickHouseWriter: class MockBufferedClickHouseWriter<T extends object> {
    private readonly table: string;

    constructor(_client: unknown, options: { table: string }) {
      this.table = options.table;
      writerState.set(options.table, { rows: [], flushes: 0, closes: 0 });
    }

    insert(row: T): void {
      writerState.get(this.table)?.rows.push(row);
    }

    async flush(): Promise<void> {
      const state = writerState.get(this.table);
      if (state) {
        state.flushes += 1;
      }
    }

    async close(): Promise<void> {
      const state = writerState.get(this.table);
      if (state) {
        state.closes += 1;
      }
    }
  },
  toClickHouseDateTime: (input: Date | string) => {
    const date = typeof input === 'string' ? new Date(input) : input;
    return date.toISOString().replace('T', ' ').replace('Z', '');
  },
  toClickHouseDateTimeSec: (input: Date | string) => {
    const date = typeof input === 'string' ? new Date(input) : input;
    return date
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');
  },
}));

import { RuntimeAuditPolicyResolver } from '../../services/audit/runtime-audit-policy-resolver.js';
import { RuntimeClickHouseAuditSink } from '../../services/audit/runtime-clickhouse-audit-sink.js';

describe('RuntimeClickHouseAuditSink', () => {
  beforeEach(() => {
    writerState.clear();
  });

  test('routes non-shared audit streams to their dedicated ClickHouse tables', async () => {
    const sharedSink = {
      writeBatch: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
    };
    const sink = new RuntimeClickHouseAuditSink({
      client: { kind: 'clickhouse-client' } as any,
      policyResolver: new RuntimeAuditPolicyResolver({
        shared: 'abl.audit.shared.v1',
        kms: 'abl.audit.kms.v1',
        pii: 'abl.audit.pii.v1',
        connector: 'abl.audit.connector.v1',
        crawl: 'abl.audit.crawl.v1',
        arch: 'abl.audit.arch.v1',
        omnichannel: 'abl.audit.omnichannel.v1',
      }),
      sharedSink: sharedSink as any,
    });

    await sink.writeBatch([
      {
        auditId: 'shared-1',
        stream: 'shared',
        schemaVersion: 2,
        source: 'runtime-store',
        eventType: 'workflow.updated',
        action: 'workflow.updated',
        actorId: 'user-1',
        actorType: 'user',
        tenantId: 'tenant-a',
        projectId: 'project-a',
        resourceType: 'workflow_definition',
        resourceId: 'wf-1',
        environment: 'production',
        traceId: 'trace-1',
        ipAddress: null,
        userAgent: null,
        metadata: { changedField: 'name' },
        metadataEncoding: 'object',
        retentionClass: 'crud',
        expiresAt: null,
        timestamp: new Date('2026-04-23T09:30:00.000Z'),
        oldValue: null,
        newValue: null,
      },
      {
        auditId: 'kms-1',
        stream: 'kms',
        schemaVersion: 2,
        source: 'runtime-store',
        eventType: 'kms.rotate',
        action: 'rotate',
        actorId: 'user-2',
        actorType: 'user',
        tenantId: 'tenant-a',
        projectId: 'project-a',
        resourceType: 'kms_key',
        resourceId: 'key-1',
        environment: 'production',
        traceId: null,
        ipAddress: '10.0.0.2',
        userAgent: null,
        metadata: {
          keyVersion: 5,
          keyPurpose: 'encryption',
          providerType: 'vault',
          environment: 'production',
          dekId: 'dek-9',
          success: false,
          errorMessage: 'timeout',
          latencyMs: 88,
        },
        metadataEncoding: 'object',
        retentionClass: 'indefinite',
        expiresAt: null,
        timestamp: new Date('2026-04-23T09:31:00.000Z'),
        oldValue: null,
        newValue: null,
      },
      {
        auditId: 'pii-1',
        stream: 'pii',
        schemaVersion: 2,
        source: 'runtime-store',
        eventType: 'pii.accessed',
        action: 'render',
        actorId: 'tools',
        actorType: 'system',
        tenantId: 'tenant-a',
        projectId: 'project-a',
        resourceType: 'pii_token',
        resourceId: 'token-1',
        environment: null,
        traceId: null,
        ipAddress: null,
        userAgent: null,
        metadata: {
          sessionId: 'session-1',
          tokenId: 'token-1',
          piiType: 'email',
          consumer: 'tools',
          renderMode: 'masked',
        },
        metadataEncoding: 'object',
        retentionClass: 'default',
        expiresAt: new Date('2026-07-22T09:31:00.000Z'),
        timestamp: new Date('2026-04-23T09:31:00.000Z'),
        oldValue: null,
        newValue: null,
      },
      {
        auditId: 'connector-1',
        stream: 'connector',
        schemaVersion: 2,
        source: 'search-ai',
        eventType: 'config.updated',
        action: 'config.updated',
        actorId: 'alice@example.com',
        actorType: 'user',
        tenantId: 'tenant-a',
        projectId: null,
        resourceType: 'connector',
        resourceId: 'connector-1',
        environment: null,
        traceId: null,
        ipAddress: null,
        userAgent: null,
        metadata: {
          connectorId: 'connector-1',
          category: 'config',
          actor: 'alice@example.com',
        },
        metadataEncoding: 'object',
        retentionClass: 'indefinite',
        expiresAt: null,
        timestamp: new Date('2026-04-23T09:32:00.000Z'),
        oldValue: null,
        newValue: null,
      },
      {
        auditId: 'crawl-1',
        stream: 'crawl',
        schemaVersion: 2,
        source: 'search-ai',
        eventType: 'crawl.failed',
        action: 'crawl.failed',
        actorId: 'user-3',
        actorType: 'user',
        tenantId: 'tenant-a',
        projectId: null,
        resourceType: 'crawl_job',
        resourceId: 'crawl-1',
        environment: null,
        traceId: null,
        ipAddress: null,
        userAgent: null,
        metadata: {
          crawlJobId: 'crawl-1',
          description: 'crawl failed',
          severity: 'error',
          changes: {
            before: { status: 'running' },
            after: { status: 'failed' },
          },
          context: {
            strategy: 'breadth-first',
            urls: 12,
          },
        },
        metadataEncoding: 'object',
        retentionClass: 'indefinite',
        expiresAt: null,
        timestamp: new Date('2026-04-23T09:33:00.000Z'),
        oldValue: null,
        newValue: null,
      },
      {
        auditId: 'arch-1',
        stream: 'arch',
        schemaVersion: 2,
        source: 'studio',
        eventType: 'arch.session.created',
        action: 'session_created',
        actorId: 'user-4',
        actorType: 'user',
        tenantId: 'tenant-a',
        projectId: 'project-arch',
        resourceType: 'arch_session',
        resourceId: 'session-arch-1',
        environment: null,
        traceId: null,
        ipAddress: null,
        userAgent: null,
        metadata: {
          sessionId: 'session-arch-1',
          category: 'system_event',
          severity: 'info',
          summary: 'session created',
          detail: { source: 'ui' },
          specialist: 'planner',
          phase: 'build',
          durationMs: 123,
          tokens: {
            input: 10,
            output: 20,
            total: 30,
            estimatedCost: 0.12,
          },
        },
        metadataEncoding: 'object',
        retentionClass: 'default',
        expiresAt: null,
        timestamp: new Date('2026-04-23T09:34:00.000Z'),
        oldValue: null,
        newValue: null,
      },
      {
        auditId: 'omni-1',
        stream: 'omnichannel',
        schemaVersion: 2,
        source: 'runtime-store',
        eventType: 'live_session_joined',
        action: 'live_session_joined',
        actorId: 'system',
        actorType: 'system',
        tenantId: 'tenant-a',
        projectId: 'project-omni',
        resourceType: 'omnichannel_session',
        resourceId: 'session-omni-1',
        environment: 'production',
        traceId: null,
        ipAddress: null,
        userAgent: null,
        metadata: {
          sessionId: 'session-omni-1',
          description: 'Participant joined live session',
          data: { participantId: 'participant-1', surface: 'web' },
        },
        metadataEncoding: 'object',
        retentionClass: 'default',
        expiresAt: null,
        timestamp: new Date('2026-04-23T09:35:00.000Z'),
        oldValue: null,
        newValue: null,
      },
    ]);

    expect(sharedSink.writeBatch).toHaveBeenCalledTimes(1);
    expect(sharedSink.writeBatch).toHaveBeenCalledWith([
      expect.objectContaining({ stream: 'shared', auditId: 'shared-1' }),
    ]);

    expect(writerState.get('abl_platform.kms_audit_log')?.rows[0]).toMatchObject({
      tenant_id: 'tenant-a',
      operation: 'rotate',
      key_id: 'key-1',
      key_version: 5,
      key_purpose: 'encryption',
      provider_type: 'vault',
      environment: 'production',
      epoch: 'dek-9',
      success: 0,
      error_message: 'timeout',
      latency_ms: 88,
    });

    expect(writerState.get('abl_platform.pii_audit_log')?.rows[0]).toMatchObject({
      tenant_id: 'tenant-a',
      project_id: 'project-a',
      session_id: 'session-1',
      token_id: 'token-1',
      pii_type: 'email',
      consumer: 'tools',
      render_mode: 'masked',
      action: 'render',
    });

    expect(writerState.get('abl_platform.connector_audit_log')?.rows[0]).toMatchObject({
      tenant_id: 'tenant-a',
      connector_id: 'connector-1',
      actor: 'alice@example.com',
      actor_type: 'user',
      event: 'config.updated',
      category: 'config',
    });

    expect(writerState.get('abl_platform.crawl_audit_events')?.rows[0]).toMatchObject({
      tenant_id: 'tenant-a',
      crawl_job_id: 'crawl-1',
      user_id: 'user-3',
      event_type: 'crawl.failed',
      description: 'crawl failed',
      severity: 'error',
    });

    expect(writerState.get('abl_platform.arch_audit_log')?.rows[0]).toMatchObject({
      tenant_id: 'tenant-a',
      user_id: 'user-4',
      session_id: 'session-arch-1',
      project_id: 'project-arch',
      category: 'system_event',
      severity: 'info',
      summary: 'session created',
      specialist: 'planner',
      phase: 'build',
      duration_ms: 123,
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      estimated_cost: 0.12,
    });

    expect(writerState.get('abl_platform.omnichannel_audit_log')?.rows[0]).toMatchObject({
      tenant_id: 'tenant-a',
      project_id: 'project-omni',
      session_id: 'session-omni-1',
      event_type: 'live_session_joined',
      description: 'Participant joined live session',
      data: JSON.stringify({ participantId: 'participant-1', surface: 'web' }),
    });

    await sink.close();

    expect(writerState.get('abl_platform.kms_audit_log')?.closes).toBe(1);
    expect(writerState.get('abl_platform.pii_audit_log')?.closes).toBe(1);
    expect(writerState.get('abl_platform.connector_audit_log')?.closes).toBe(1);
    expect(writerState.get('abl_platform.crawl_audit_events')?.closes).toBe(1);
    expect(writerState.get('abl_platform.arch_audit_log')?.closes).toBe(1);
    expect(writerState.get('abl_platform.omnichannel_audit_log')?.closes).toBe(1);
  });
});
