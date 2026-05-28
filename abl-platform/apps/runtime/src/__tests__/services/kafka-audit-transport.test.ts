import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AuditFileSystemWAL } from '../../services/audit/audit-filesystem-wal.js';

const { mockProducer, mockConsumer, mockKafkaCtor, captureRunConfig } = vi.hoisted(() => {
  const producer = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    sendBatch: vi.fn(async () => {}),
  };
  let runConfig: Record<string, unknown> | null = null;
  const consumer = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    subscribe: vi.fn(async () => {}),
    run: vi.fn(async (config: Record<string, unknown>) => {
      runConfig = config;
    }),
  };

  return {
    mockProducer: producer,
    mockConsumer: consumer,
    mockKafkaCtor: vi.fn(),
    captureRunConfig: () => runConfig,
  };
});

vi.mock('kafkajs', () => ({
  Kafka: class MockKafka {
    constructor(config: unknown) {
      mockKafkaCtor(config);
    }

    producer(): typeof mockProducer {
      return mockProducer;
    }

    consumer(): typeof mockConsumer {
      return mockConsumer;
    }
  },
  logLevel: {
    WARN: 4,
  },
}));

import {
  getKafkaAuditTransportConfigFromEnv,
  KafkaAuditTransport,
} from '../../services/audit/kafka-audit-transport.js';
import { RuntimeAuditPolicyResolver } from '../../services/audit/runtime-audit-policy-resolver.js';

function createResolver(): RuntimeAuditPolicyResolver {
  return new RuntimeAuditPolicyResolver({
    shared: 'abl.audit.shared.v1',
    kms: 'abl.audit.kms.v1',
    pii: 'abl.audit.pii.v1',
    connector: 'abl.audit.connector.v1',
    crawl: 'abl.audit.crawl.v1',
    arch: 'abl.audit.arch.v1',
    omnichannel: 'abl.audit.omnichannel.v1',
  });
}

describe('KafkaAuditTransport', () => {
  const walDirectories: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const directory of walDirectories.splice(0, walDirectories.length)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('loads omnichannel into the subscribed audit topics from env', () => {
    const config = getKafkaAuditTransportConfigFromEnv({
      AUDIT_KAFKA_BROKERS: 'localhost:19092',
      AUDIT_KAFKA_SHARED_TOPIC: 'abl.audit.shared.v1',
      AUDIT_KAFKA_KMS_TOPIC: 'abl.audit.kms.v1',
      AUDIT_KAFKA_PII_TOPIC: 'abl.audit.pii.v1',
      AUDIT_KAFKA_CONNECTOR_TOPIC: 'abl.audit.connector.v1',
      AUDIT_KAFKA_CRAWL_TOPIC: 'abl.audit.crawl.v1',
      AUDIT_KAFKA_ARCH_TOPIC: 'abl.audit.arch.v1',
      AUDIT_KAFKA_OMNICHANNEL_TOPIC: 'abl.audit.omnichannel.v1',
    });

    expect(config.topics).toEqual([
      'abl.audit.shared.v1',
      'abl.audit.kms.v1',
      'abl.audit.pii.v1',
      'abl.audit.connector.v1',
      'abl.audit.crawl.v1',
      'abl.audit.arch.v1',
      'abl.audit.omnichannel.v1',
    ]);
  });

  test('publishes shared audit events in Kafka batches keyed by tenant', async () => {
    const resolver = createResolver();
    const transport = new KafkaAuditTransport(
      {
        brokers: ['localhost:19092'],
        clientId: 'runtime-audit-test',
        groupId: 'runtime-audit-materializer-test',
        topics: ['abl.audit.shared.v1'],
        batchSize: 10,
        lingerMs: 1_000,
        maxRetries: 1,
        retryInitialMs: 1,
        consumerConcurrency: 1,
      },
      resolver,
    );

    await transport.start({
      handle: vi.fn(async () => {}),
      handleBatch: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    });

    transport.publish({
      auditId: 'audit-1',
      stream: 'shared',
      schemaVersion: 2,
      timestamp: new Date('2026-04-21T10:00:00.000Z'),
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
      metadata: { changedField: 'name' },
      metadataEncoding: 'object',
      retentionClass: 'crud',
      traceId: 'trace-1',
    });

    await transport.flush();

    expect(transport.getStatus()).toMatchObject({
      healthy: true,
      started: true,
      bufferedMessages: 0,
      publishedMessages: 1,
      failedProducerDrains: 0,
    });
    expect(transport.getStatus().lastProducedAt).toBeInstanceOf(Date);
    expect(mockProducer.connect).toHaveBeenCalledTimes(1);
    expect(mockProducer.sendBatch).toHaveBeenCalledTimes(1);
    expect(mockProducer.sendBatch).toHaveBeenCalledWith({
      topicMessages: [
        {
          topic: 'abl.audit.shared.v1',
          messages: [
            {
              key: 'tenant-a',
              value: expect.any(String),
            },
          ],
        },
      ],
    });

    await transport.close();
  });

  test('caps the in-memory producer buffer and spools overflowed events to WAL', async () => {
    const walDir = mkdtempSync(join(tmpdir(), 'audit-transport-wal-'));
    walDirectories.push(walDir);
    const resolver = createResolver();
    const transport = new KafkaAuditTransport(
      {
        brokers: ['localhost:19092'],
        clientId: 'runtime-audit-test',
        groupId: 'runtime-audit-materializer-test',
        topics: ['abl.audit.shared.v1'],
        batchSize: 10,
        lingerMs: 1_000,
        maxRetries: 1,
        retryInitialMs: 1,
        consumerConcurrency: 1,
        maxBufferedMessages: 2,
        resilience: {
          enabled: true,
          wal: {
            directory: walDir,
          },
          recoveryIntervalMs: 60_000,
        },
      },
      resolver,
    );

    await transport.start({
      handle: vi.fn(async () => {}),
      handleBatch: vi.fn(async () => {}),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    });

    transport.publish({
      auditId: 'audit-buffer-1',
      stream: 'shared',
      schemaVersion: 2,
      timestamp: new Date('2026-04-21T10:00:00.000Z'),
      source: 'runtime-store',
      eventType: 'workflow.updated',
      action: 'workflow.updated',
      actorId: 'user-1',
      actorType: 'user',
      tenantId: 'tenant-a',
      environment: 'production',
      metadata: {},
      metadataEncoding: 'object',
      retentionClass: 'crud',
    });
    transport.publish({
      auditId: 'audit-buffer-2',
      stream: 'shared',
      schemaVersion: 2,
      timestamp: new Date('2026-04-21T10:01:00.000Z'),
      source: 'runtime-store',
      eventType: 'workflow.updated',
      action: 'workflow.updated',
      actorId: 'user-2',
      actorType: 'user',
      tenantId: 'tenant-a',
      environment: 'production',
      metadata: {},
      metadataEncoding: 'object',
      retentionClass: 'crud',
    });
    transport.publish({
      auditId: 'audit-buffer-3',
      stream: 'shared',
      schemaVersion: 2,
      timestamp: new Date('2026-04-21T10:02:00.000Z'),
      source: 'runtime-store',
      eventType: 'workflow.updated',
      action: 'workflow.updated',
      actorId: 'user-3',
      actorType: 'user',
      tenantId: 'tenant-a',
      environment: 'production',
      metadata: {},
      metadataEncoding: 'object',
      retentionClass: 'crud',
    });

    await vi.waitFor(() => {
      expect(readdirSync(walDir).length).toBeGreaterThan(0);
    });
    expect(transport.getStatus().bufferedMessages).toBe(2);

    await transport.close();
  });

  test('materializes consumed Kafka batches through the shared audit materializer', async () => {
    const resolver = createResolver();
    const handleBatch = vi.fn(async () => {});
    const transport = new KafkaAuditTransport(
      {
        brokers: ['localhost:19092'],
        clientId: 'runtime-audit-test',
        groupId: 'runtime-audit-materializer-test',
        topics: ['abl.audit.shared.v1'],
        batchSize: 10,
        lingerMs: 1_000,
        maxRetries: 1,
        retryInitialMs: 1,
        consumerConcurrency: 1,
      },
      resolver,
    );

    await transport.start({
      handle: vi.fn(async () => {}),
      handleBatch,
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    });

    const runConfig = captureRunConfig();
    expect(runConfig).toBeTruthy();
    const eachBatch = runConfig?.eachBatch;
    expect(typeof eachBatch).toBe('function');

    await (eachBatch as (payload: Record<string, unknown>) => Promise<void>)({
      batch: {
        topic: 'abl.audit.shared.v1',
        partition: 0,
        messages: [
          {
            offset: '1',
            value: Buffer.from(
              JSON.stringify({
                auditId: 'audit-2',
                stream: 'shared',
                schemaVersion: 2,
                timestamp: '2026-04-21T11:00:00.000Z',
                source: 'runtime-store',
                eventType: 'workflow.updated',
                action: 'workflow.updated',
                actorId: 'user-2',
                actorType: 'user',
                tenantId: 'tenant-a',
                environment: 'production',
                metadata: { changedField: 'description' },
                metadataEncoding: 'object',
                retentionClass: 'crud',
              }),
            ),
          },
        ],
      },
      resolveOffset: vi.fn(),
      commitOffsetsIfNecessary: vi.fn(async () => {}),
      heartbeat: vi.fn(async () => {}),
    });

    expect(handleBatch).toHaveBeenCalledTimes(1);
    const [events] = handleBatch.mock.calls[0];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      auditId: 'audit-2',
      stream: 'shared',
      tenantId: 'tenant-a',
      eventType: 'workflow.updated',
      actorId: 'user-2',
    });
    expect(events[0].timestamp).toBeInstanceOf(Date);
    expect(transport.getStatus()).toMatchObject({
      healthy: true,
      materializedMessages: 1,
      failedMaterializations: 0,
    });
    expect(transport.getStatus().lastMaterializedAt).toBeInstanceOf(Date);

    await transport.close();
  });

  test('accepts omnichannel payloads during Kafka materialization', async () => {
    const resolver = createResolver();
    const handleBatch = vi.fn(async () => {});
    const transport = new KafkaAuditTransport(
      {
        brokers: ['localhost:19092'],
        clientId: 'runtime-audit-test',
        groupId: 'runtime-audit-materializer-test',
        topics: ['abl.audit.omnichannel.v1'],
        batchSize: 10,
        lingerMs: 1_000,
        maxRetries: 1,
        retryInitialMs: 1,
        consumerConcurrency: 1,
      },
      resolver,
    );

    await transport.start({
      handle: vi.fn(async () => {}),
      handleBatch,
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    });

    const eachBatch = captureRunConfig()?.eachBatch as (
      payload: Record<string, unknown>,
    ) => Promise<void>;
    await eachBatch({
      batch: {
        topic: 'abl.audit.omnichannel.v1',
        partition: 0,
        messages: [
          {
            offset: '1',
            value: Buffer.from(
              JSON.stringify({
                auditId: 'audit-omni-1',
                stream: 'omnichannel',
                schemaVersion: 2,
                timestamp: '2026-04-27T10:00:00.000Z',
                source: 'runtime-store',
                eventType: 'omnichannel.recall.opened',
                action: 'omnichannel.recall.opened',
                actorId: 'user-omni',
                actorType: 'user',
                tenantId: 'tenant-omni',
                projectId: 'project-omni',
                resourceType: 'omnichannel_session',
                resourceId: 'session-1',
                environment: 'production',
                metadata: { channel: 'whatsapp' },
                metadataEncoding: 'object',
                retentionClass: 'default',
              }),
            ),
          },
        ],
      },
      resolveOffset: vi.fn(),
      commitOffsetsIfNecessary: vi.fn(async () => {}),
      heartbeat: vi.fn(async () => {}),
    });

    expect(handleBatch).toHaveBeenCalledTimes(1);
    const [events] = handleBatch.mock.calls[0];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      auditId: 'audit-omni-1',
      stream: 'omnichannel',
      tenantId: 'tenant-omni',
      projectId: 'project-omni',
      resourceType: 'omnichannel_session',
      resourceId: 'session-1',
    });
    expect(events[0].timestamp).toBeInstanceOf(Date);

    await transport.close();
  });

  test('records materialization failures in the transport status snapshot', async () => {
    const resolver = createResolver();
    const transport = new KafkaAuditTransport(
      {
        brokers: ['localhost:19092'],
        clientId: 'runtime-audit-test',
        groupId: 'runtime-audit-materializer-test',
        topics: ['abl.audit.shared.v1'],
        batchSize: 10,
        lingerMs: 1_000,
        maxRetries: 1,
        retryInitialMs: 1,
        consumerConcurrency: 1,
      },
      resolver,
    );

    await transport.start({
      handle: vi.fn(async () => {}),
      handleBatch: vi.fn(async () => {
        throw new Error('sink unavailable');
      }),
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    });

    const eachBatch = captureRunConfig()?.eachBatch as (
      payload: Record<string, unknown>,
    ) => Promise<void>;
    await expect(
      eachBatch({
        batch: {
          topic: 'abl.audit.shared.v1',
          partition: 0,
          messages: [
            {
              offset: '1',
              value: Buffer.from(
                JSON.stringify({
                  auditId: 'audit-3',
                  stream: 'shared',
                  schemaVersion: 2,
                  timestamp: '2026-04-21T11:30:00.000Z',
                  source: 'runtime-store',
                  eventType: 'workflow.updated',
                  action: 'workflow.updated',
                  actorId: 'user-3',
                  actorType: 'user',
                  tenantId: 'tenant-a',
                  environment: 'production',
                  metadata: { changedField: 'description' },
                  metadataEncoding: 'object',
                  retentionClass: 'crud',
                }),
              ),
            },
          ],
        },
        resolveOffset: vi.fn(),
        commitOffsetsIfNecessary: vi.fn(async () => {}),
        heartbeat: vi.fn(async () => {}),
      }),
    ).rejects.toThrow('sink unavailable');

    expect(transport.getStatus()).toMatchObject({
      healthy: false,
      failedMaterializations: 1,
      lastError: 'sink unavailable',
    });
    expect(transport.getStatus().lastErrorAt).toBeInstanceOf(Date);

    await transport.close();
  });

  test('spools producer failures to WAL and immediately recovers them through the materializer', async () => {
    const walDir = mkdtempSync(join(tmpdir(), 'audit-transport-wal-'));
    walDirectories.push(walDir);
    mockProducer.sendBatch.mockRejectedValue(new Error('broker unavailable'));

    const resolver = createResolver();
    const handleBatch = vi.fn(async () => {});
    const transport = new KafkaAuditTransport(
      {
        brokers: ['localhost:19092'],
        clientId: 'runtime-audit-test',
        groupId: 'runtime-audit-materializer-test',
        topics: ['abl.audit.shared.v1'],
        batchSize: 10,
        lingerMs: 1_000,
        maxRetries: 0,
        retryInitialMs: 1,
        consumerConcurrency: 1,
        resilience: {
          enabled: true,
          wal: {
            directory: walDir,
          },
          recoveryIntervalMs: 60_000,
        },
      },
      resolver,
    );

    await transport.start({
      handle: vi.fn(async () => {}),
      handleBatch,
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    });

    transport.publish({
      auditId: 'audit-wal-1',
      stream: 'shared',
      schemaVersion: 2,
      timestamp: new Date('2026-04-21T12:00:00.000Z'),
      source: 'runtime-store',
      eventType: 'workflow.updated',
      action: 'workflow.updated',
      actorId: 'user-1',
      actorType: 'user',
      tenantId: 'tenant-a',
      environment: 'production',
      metadata: { changedField: 'description' },
      metadataEncoding: 'object',
      retentionClass: 'crud',
    });

    await transport.flush();

    expect(mockProducer.sendBatch).toHaveBeenCalledTimes(1);
    expect(handleBatch).toHaveBeenCalledTimes(1);
    expect(handleBatch.mock.calls[0][0][0]).toMatchObject({
      auditId: 'audit-wal-1',
      tenantId: 'tenant-a',
    });
    expect(transport.getStatus()).toMatchObject({
      healthy: false,
      failedProducerDrains: 1,
      lastError: 'broker unavailable',
      resilience: {
        walEnabled: true,
        walBufferedEvents: 0,
        spooledMessages: 1,
        failedWalWrites: 0,
        recoveryRuns: 1,
        recoveredMessages: 1,
        failedRecoveryMessages: 0,
      },
    });
    expect(readdirSync(walDir)).toEqual([]);

    await transport.close();
  });

  test('replays persisted WAL batches on startup', async () => {
    const walDir = mkdtempSync(join(tmpdir(), 'audit-transport-wal-replay-'));
    walDirectories.push(walDir);

    const wal = new AuditFileSystemWAL({ directory: walDir });
    wal.append({
      auditId: 'audit-replay-1',
      stream: 'shared',
      schemaVersion: 2,
      timestamp: new Date('2026-04-21T13:00:00.000Z'),
      source: 'runtime-store',
      eventType: 'workflow.updated',
      action: 'workflow.updated',
      actorId: 'user-9',
      actorType: 'user',
      tenantId: 'tenant-z',
      environment: 'production',
      metadata: { changedField: 'owner' },
      metadataEncoding: 'object',
      retentionClass: 'crud',
    });
    await wal.flushBuffer();
    await wal.close();

    const resolver = createResolver();
    const handleBatch = vi.fn(async () => {});
    const transport = new KafkaAuditTransport(
      {
        brokers: ['localhost:19092'],
        clientId: 'runtime-audit-test',
        groupId: 'runtime-audit-materializer-test',
        topics: ['abl.audit.shared.v1'],
        batchSize: 10,
        lingerMs: 1_000,
        maxRetries: 1,
        retryInitialMs: 1,
        consumerConcurrency: 1,
        resilience: {
          enabled: true,
          wal: {
            directory: walDir,
          },
          recoveryIntervalMs: 60_000,
        },
      },
      resolver,
    );

    await transport.start({
      handle: vi.fn(async () => {}),
      handleBatch,
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    });

    expect(handleBatch).toHaveBeenCalledTimes(1);
    expect(handleBatch.mock.calls[0][0][0]).toMatchObject({
      auditId: 'audit-replay-1',
      tenantId: 'tenant-z',
    });
    expect(transport.getStatus()).toMatchObject({
      resilience: {
        walEnabled: true,
        walBufferedEvents: 0,
        spooledMessages: 0,
        failedWalWrites: 0,
        recoveryRuns: 1,
        recoveredMessages: 1,
        failedRecoveryMessages: 0,
      },
    });
    expect(readdirSync(walDir)).toEqual([]);

    await transport.close();
  });

  test('skips messages with unsupported stream instead of crashing the batch', async () => {
    const handleBatch = vi.fn(async () => {});
    const resolver = createResolver();
    const transport = new KafkaAuditTransport(
      {
        brokers: ['localhost:19092'],
        clientId: 'runtime-audit-test',
        groupId: 'runtime-audit-materializer-test',
        topics: ['abl.audit.arch.v1'],
        batchSize: 10,
        lingerMs: 1_000,
        maxRetries: 1,
        retryInitialMs: 1,
        consumerConcurrency: 1,
      },
      resolver,
    );

    await transport.start({
      handle: vi.fn(async () => {}),
      handleBatch,
      flush: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    });

    const runConfig = captureRunConfig();
    const eachBatch = runConfig?.eachBatch as (payload: Record<string, unknown>) => Promise<void>;

    const resolveOffset = vi.fn();

    await eachBatch({
      batch: {
        topic: 'abl.audit.arch.v1',
        partition: 1,
        messages: [
          {
            offset: '0',
            value: Buffer.from(
              JSON.stringify({
                auditId: 'good-1',
                stream: 'arch',
                schemaVersion: 2,
                timestamp: '2026-05-11T10:00:00.000Z',
                source: 'studio',
                eventType: 'arch.system_event',
                action: 'system_event',
                actorId: 'user-1',
                actorType: 'user',
                tenantId: 'tenant-a',
                environment: 'production',
                metadata: {},
                metadataEncoding: 'object',
                retentionClass: 'default',
              }),
            ),
          },
          {
            offset: '1',
            value: Buffer.from(
              JSON.stringify({
                auditId: 'poison-1',
                stream: 'arch_payload',
                schemaVersion: 1,
                timestamp: '2026-05-11T10:00:01.000Z',
                source: 'studio',
                eventType: 'arch.payload.prompt',
                action: 'payload_capture',
                actorId: '',
                actorType: 'system',
                tenantId: 'tenant-a',
                environment: 'production',
                metadata: {},
                metadataEncoding: 'object',
                retentionClass: 'default',
              }),
            ),
          },
          {
            offset: '2',
            value: Buffer.from(
              JSON.stringify({
                auditId: 'good-2',
                stream: 'arch',
                schemaVersion: 2,
                timestamp: '2026-05-11T10:00:02.000Z',
                source: 'studio',
                eventType: 'arch.user_action',
                action: 'user_action',
                actorId: 'user-1',
                actorType: 'user',
                tenantId: 'tenant-a',
                environment: 'production',
                metadata: {},
                metadataEncoding: 'object',
                retentionClass: 'default',
              }),
            ),
          },
        ],
      },
      resolveOffset,
      commitOffsetsIfNecessary: vi.fn(async () => {}),
      heartbeat: vi.fn(async () => {}),
    });

    expect(handleBatch).toHaveBeenCalledTimes(1);
    const [events] = handleBatch.mock.calls[0];
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ auditId: 'good-1', stream: 'arch' });
    expect(events[1]).toMatchObject({ auditId: 'good-2', stream: 'arch' });

    expect(resolveOffset).toHaveBeenCalled();

    expect(transport.getStatus()).toMatchObject({
      healthy: true,
      materializedMessages: 2,
      failedMaterializations: 1,
    });

    await transport.close();
  });
});
