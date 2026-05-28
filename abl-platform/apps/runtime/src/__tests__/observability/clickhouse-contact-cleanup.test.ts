/**
 * ClickHouse Contact Cleanup Tests
 *
 * Tests for ClickHouseMessageStore.scrubByContact and standalone clickhouseContactCleanup.
 * Verifies correct SQL with parameterized tenantId/contactId.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

// =============================================================================
// MOCK DEPENDENCIES
// =============================================================================

const mockWriterInsert = vi.fn();
const mockWriterClose = vi.fn().mockResolvedValue(undefined);

vi.mock('@agent-platform/database/clickhouse', () => {
  return {
    BufferedClickHouseWriter: class MockBufferedWriter {
      insert = mockWriterInsert;
      insertMany = vi.fn();
      flush = vi.fn().mockResolvedValue(undefined);
      close = mockWriterClose;
      pending = 0;
      constructor(_client: any, _opts: any) {}
    },
  };
});

import {
  ClickHouseMessageStore,
  clickhouseContactCleanup,
} from '../../services/stores/clickhouse-message-store';
import { EncryptionService } from '@agent-platform/shared/encryption';

const TEST_MASTER_KEY = crypto.randomBytes(32).toString('hex');
const TEST_TENANT_ID = 'tenant-cleanup-123';
const TEST_CONTACT_ID = 'contact-abc-456';

function createMockClickHouseClient() {
  return {
    insert: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(),
    command: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

// =============================================================================
// scrubByContact (instance method)
// =============================================================================

describe('ClickHouseMessageStore.scrubByContact', () => {
  let store: ClickHouseMessageStore;
  let mockClient: ReturnType<typeof createMockClickHouseClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClickHouseClient();
    const encryption = new EncryptionService({
      masterKeyHex: TEST_MASTER_KEY,
    });
    store = new ClickHouseMessageStore(
      { type: 'clickhouse' as const },
      {
        client: mockClient as any,
        encryptionService: encryption,
        tenantId: TEST_TENANT_ID,
      },
    );
  });

  test('should issue ALTER TABLE UPDATE with scrubbed=1 and empty content', async () => {
    await store.scrubByContact(TEST_CONTACT_ID);

    expect(mockClient.command).toHaveBeenCalledTimes(1);
    const cmd = mockClient.command.mock.calls[0][0];
    expect(cmd.query).toContain('ALTER TABLE abl_platform.messages');
    expect(cmd.query).toContain('UPDATE scrubbed = 1');
    expect(cmd.query).toContain("content = '[REDACTED]'");
    expect(cmd.query).toContain("metadata = '{}'");
    expect(cmd.query).toContain('SETTINGS mutations_sync = 1');
  });

  test('should use parameterized tenantId from store', async () => {
    await store.scrubByContact(TEST_CONTACT_ID);

    const cmd = mockClient.command.mock.calls[0][0];
    expect(cmd.query).toContain('tenant_id = {tenantId:String}');
    expect(cmd.query_params.tenantId).toBe(TEST_TENANT_ID);
  });

  test('should use parameterized contactId', async () => {
    await store.scrubByContact(TEST_CONTACT_ID);

    const cmd = mockClient.command.mock.calls[0][0];
    expect(cmd.query).toContain('contact_id = {contactId:String}');
    expect(cmd.query_params.contactId).toBe(TEST_CONTACT_ID);
  });

  test('should propagate ClickHouse errors', async () => {
    mockClient.command.mockRejectedValueOnce(new Error('ClickHouse unavailable'));

    await expect(store.scrubByContact(TEST_CONTACT_ID)).rejects.toThrow('ClickHouse unavailable');
  });
});

// =============================================================================
// clickhouseContactCleanup (standalone function)
// =============================================================================

describe('clickhouseContactCleanup', () => {
  let mockClient: ReturnType<typeof createMockClickHouseClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClickHouseClient();
  });

  test('should issue ALTER TABLE UPDATE with scrubbed=1 and empty content', async () => {
    await clickhouseContactCleanup(mockClient as any, TEST_TENANT_ID, TEST_CONTACT_ID);

    expect(mockClient.command).toHaveBeenCalledTimes(1);
    const cmd = mockClient.command.mock.calls[0][0];
    expect(cmd.query).toContain('ALTER TABLE abl_platform.messages');
    expect(cmd.query).toContain('UPDATE scrubbed = 1');
    expect(cmd.query).toContain("content = '[REDACTED]'");
    expect(cmd.query).toContain("metadata = '{}'");
    expect(cmd.query).toContain('SETTINGS mutations_sync = 1');
  });

  test('should use parameterized tenantId', async () => {
    await clickhouseContactCleanup(mockClient as any, TEST_TENANT_ID, TEST_CONTACT_ID);

    const cmd = mockClient.command.mock.calls[0][0];
    expect(cmd.query).toContain('tenant_id = {tenantId:String}');
    expect(cmd.query_params.tenantId).toBe(TEST_TENANT_ID);
  });

  test('should use parameterized contactId', async () => {
    await clickhouseContactCleanup(mockClient as any, TEST_TENANT_ID, TEST_CONTACT_ID);

    const cmd = mockClient.command.mock.calls[0][0];
    expect(cmd.query).toContain('contact_id = {contactId:String}');
    expect(cmd.query_params.contactId).toBe(TEST_CONTACT_ID);
  });

  test('should work with different tenant and contact IDs', async () => {
    const otherTenant = 'tenant-other-789';
    const otherContact = 'contact-xyz-000';

    await clickhouseContactCleanup(mockClient as any, otherTenant, otherContact);

    const cmd = mockClient.command.mock.calls[0][0];
    expect(cmd.query_params.tenantId).toBe(otherTenant);
    expect(cmd.query_params.contactId).toBe(otherContact);
  });

  test('should propagate ClickHouse errors', async () => {
    mockClient.command.mockRejectedValueOnce(new Error('Connection refused'));

    await expect(
      clickhouseContactCleanup(mockClient as any, TEST_TENANT_ID, TEST_CONTACT_ID),
    ).rejects.toThrow('Connection refused');
  });
});
