import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, test } from 'vitest';
import { AuditFileSystemWAL } from '../../services/audit/audit-filesystem-wal.js';

describe('AuditFileSystemWAL', () => {
  const walDirectories: string[] = [];

  afterEach(() => {
    for (const directory of walDirectories.splice(0, walDirectories.length)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('replays persisted audit events with timestamp deserialization', async () => {
    const walDir = mkdtempSync(join(tmpdir(), 'audit-wal-'));
    walDirectories.push(walDir);

    const wal = new AuditFileSystemWAL({ directory: walDir });
    wal.append({
      auditId: 'audit-1',
      stream: 'shared',
      schemaVersion: 2,
      timestamp: new Date('2026-04-22T10:00:00.000Z'),
      source: 'runtime-store',
      eventType: 'workflow.updated',
      action: 'workflow.updated',
      actorId: 'user-1',
      actorType: 'user',
      tenantId: 'tenant-a',
      environment: 'production',
      metadata: { changedField: 'name' },
      metadataEncoding: 'object',
      retentionClass: 'crud',
    });
    await wal.flushBuffer();

    const replayed = await wal.replay();

    expect(replayed.files).toHaveLength(1);
    expect(replayed.events).toHaveLength(1);
    expect(replayed.events[0]).toMatchObject({
      auditId: 'audit-1',
      stream: 'shared',
      tenantId: 'tenant-a',
      eventType: 'workflow.updated',
    });
    expect(replayed.events[0].timestamp).toBeInstanceOf(Date);

    await wal.close();
  });

  test('replays specialized audit streams without rejecting migrated payloads', async () => {
    const walDir = mkdtempSync(join(tmpdir(), 'audit-wal-'));
    walDirectories.push(walDir);

    const wal = new AuditFileSystemWAL({ directory: walDir });
    wal.append({
      auditId: 'audit-connector-1',
      stream: 'connector',
      schemaVersion: 2,
      timestamp: new Date('2026-04-22T10:05:00.000Z'),
      source: 'search-ai',
      eventType: 'connector.config.updated',
      action: 'connector.config.updated',
      actorId: 'user-2',
      actorType: 'user',
      tenantId: 'tenant-b',
      resourceType: 'connector',
      resourceId: 'connector-1',
      environment: 'staging',
      metadata: { changedField: 'syncInterval' },
      metadataEncoding: 'object',
      retentionClass: 'crud',
    });
    wal.append({
      auditId: 'audit-omni-1',
      stream: 'omnichannel',
      schemaVersion: 2,
      timestamp: new Date('2026-04-22T10:06:00.000Z'),
      source: 'runtime-store',
      eventType: 'omnichannel.recall.opened',
      action: 'omnichannel.recall.opened',
      actorId: 'user-3',
      actorType: 'user',
      tenantId: 'tenant-b',
      resourceType: 'omnichannel_session',
      resourceId: 'session-1',
      environment: 'production',
      metadata: { channel: 'whatsapp' },
      metadataEncoding: 'object',
      retentionClass: 'default',
    });
    await wal.flushBuffer();

    const replayed = await wal.replay();

    expect(replayed.events.map((event) => event.stream)).toEqual(['connector', 'omnichannel']);

    await wal.close();
  });
});
