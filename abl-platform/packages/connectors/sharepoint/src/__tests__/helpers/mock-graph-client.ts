/**
 * Mock GraphClient Factory
 *
 * Provides clean, isolated mock instances for integration tests.
 * Each test can create its own mock with custom implementations.
 * Avoids test pollution from shared module-level mocks.
 */

import { vi } from 'vitest';
import type {
  Site,
  SiteCollection,
  Drive,
  DriveCollection,
  DriveItem,
  DriveItemCollection,
  Permission,
  PermissionCollection,
  GroupMember,
  GroupMemberCollection,
} from '../../client/graph-types.js';

// ─── Mock Response Types ─────────────────────────────────────────────────

export interface MockGraphClientMethods {
  getSites: ReturnType<typeof vi.fn<() => Promise<Site[]>>>;
  getDrives: ReturnType<typeof vi.fn<(siteId: string) => Promise<Drive[]>>>;
  getDriveItems: ReturnType<
    typeof vi.fn<(driveId: string, nextLink?: string) => Promise<DriveItemCollection>>
  >;
  getDriveItemsRecursive: ReturnType<typeof vi.fn<(driveId: string) => Promise<DriveItem[]>>>;
  getDriveItemsStream: (driveId: string, batchSize?: number) => AsyncGenerator<DriveItem[]>;
  getDeltaItems: ReturnType<
    typeof vi.fn<(driveId: string, deltaToken?: string) => Promise<DriveItemCollection>>
  >;
  getItemPermissions: ReturnType<
    typeof vi.fn<(driveId: string, itemId: string) => Promise<PermissionCollection>>
  >;
  getGroupMembers: ReturnType<typeof vi.fn<(groupId: string) => Promise<GroupMemberCollection>>>;
  subscribeToDriveChanges: ReturnType<
    typeof vi.fn<(driveId: string, notificationUrl: string, clientState?: string) => Promise<any>>
  >;
  renewSubscription: ReturnType<typeof vi.fn<(subscriptionId: string) => Promise<any>>>;
  deleteSubscription: ReturnType<typeof vi.fn<(subscriptionId: string) => Promise<void>>>;
}

// ─── Mock GraphClient Class ──────────────────────────────────────────────

export class MockGraphClient implements MockGraphClientMethods {
  getSites: ReturnType<typeof vi.fn<() => Promise<Site[]>>>;
  getDrives: ReturnType<typeof vi.fn<(siteId: string) => Promise<Drive[]>>>;
  getDriveItems: ReturnType<
    typeof vi.fn<(driveId: string, nextLink?: string) => Promise<DriveItemCollection>>
  >;
  getDriveItemsRecursive: ReturnType<typeof vi.fn<(driveId: string) => Promise<DriveItem[]>>>;
  private mockItems: DriveItem[] = [];
  private itemsQueue: DriveItem[][] = []; // Queue for mockResolvedValueOnce
  getDeltaItems: ReturnType<
    typeof vi.fn<(driveId: string, deltaToken?: string) => Promise<DriveItemCollection>>
  >;
  getItemPermissions: ReturnType<
    typeof vi.fn<(driveId: string, itemId: string) => Promise<PermissionCollection>>
  >;
  getGroupMembers: ReturnType<typeof vi.fn<(groupId: string) => Promise<GroupMemberCollection>>>;
  subscribeToDriveChanges: ReturnType<
    typeof vi.fn<(driveId: string, notificationUrl: string, clientState?: string) => Promise<any>>
  >;
  renewSubscription: ReturnType<typeof vi.fn<(subscriptionId: string) => Promise<any>>>;
  deleteSubscription: ReturnType<typeof vi.fn<(subscriptionId: string) => Promise<void>>>;

  constructor(customImplementations?: Partial<MockGraphClientMethods>) {
    // Create fresh mocks for each instance
    this.getSites = vi.fn();
    this.getDrives = vi.fn();
    this.getDriveItems = vi.fn();

    // Wrap getDriveItemsRecursive to auto-sync with getDriveItemsStream
    const recursiveMock = vi.fn();
    const originalMockResolvedValue = recursiveMock.mockResolvedValue.bind(recursiveMock);
    const originalMockResolvedValueOnce = recursiveMock.mockResolvedValueOnce.bind(recursiveMock);

    recursiveMock.mockResolvedValue = (items: DriveItem[]) => {
      this.setMockItems(items);
      return originalMockResolvedValue(items);
    };

    recursiveMock.mockResolvedValueOnce = (items: DriveItem[]) => {
      // For mockResolvedValueOnce, enqueue items for next stream call
      this.itemsQueue.push(items);
      return originalMockResolvedValueOnce(items);
    };

    this.getDriveItemsRecursive = recursiveMock;

    // Default getDeltaItems implementation returns empty response with delta link
    // This supports FullSyncCoordinator's delta token establishment
    this.getDeltaItems = vi.fn().mockResolvedValue({
      value: [],
      '@odata.deltaLink':
        'https://graph.microsoft.com/v1.0/drives/mock-drive/root/delta?token=mock-token',
      '@odata.nextLink': undefined,
    });
    this.getItemPermissions = vi.fn();
    this.getGroupMembers = vi.fn();
    this.subscribeToDriveChanges = vi.fn();
    this.renewSubscription = vi.fn();
    this.deleteSubscription = vi.fn();

    // Apply custom implementations if provided
    if (customImplementations) {
      Object.assign(this, customImplementations);
    }
  }

  /**
   * Async generator that yields batches of drive items.
   * Used by full-sync-coordinator for streaming support.
   */
  async *getDriveItemsStream(
    driveId: string,
    batchSize: number = 100,
  ): AsyncGenerator<DriveItem[]> {
    // If itemsQueue has items (from mockResolvedValueOnce), dequeue and yield those
    if (this.itemsQueue.length > 0) {
      const items = this.itemsQueue.shift()!;
      for (let i = 0; i < items.length; i += batchSize) {
        yield items.slice(i, i + batchSize);
      }
    } else {
      // Otherwise, use mockItems (from mockResolvedValue)
      for (let i = 0; i < this.mockItems.length; i += batchSize) {
        yield this.mockItems.slice(i, i + batchSize);
      }
    }
  }

  /**
   * Set mock items for streaming tests
   */
  setMockItems(items: DriveItem[]): void {
    this.mockItems = items;
  }

  /**
   * Reset all mocks to clean state
   */
  reset(): void {
    this.getSites.mockReset();
    this.getDrives.mockReset();
    this.getDriveItems.mockReset();
    this.getDriveItemsRecursive.mockReset();
    this.getDeltaItems.mockReset();
    this.getItemPermissions.mockReset();
    this.getGroupMembers.mockReset();
    this.subscribeToDriveChanges.mockReset();
    this.renewSubscription.mockReset();
    this.deleteSubscription.mockReset();
    this.mockItems = [];
    this.itemsQueue = [];
  }
}

// ─── Pre-configured Mock Scenarios ───────────────────────────────────────

/**
 * Create a mock client with standard successful responses
 */
export function createSuccessfulMockClient(data: {
  sites?: Site[];
  drives?: Drive[];
  items?: DriveItem[];
  deltaItems?: DriveItem[];
}): MockGraphClient {
  const mock = new MockGraphClient();

  if (data.sites) {
    mock.getSites.mockResolvedValue(data.sites);
  }

  if (data.drives) {
    mock.getDrives.mockResolvedValue(data.drives);
  }

  if (data.items) {
    mock.getDriveItems.mockResolvedValue({
      value: data.items,
      '@odata.nextLink': undefined,
    });
    // Set up streaming support
    mock.setMockItems(data.items);
  }

  if (data.deltaItems) {
    mock.getDeltaItems.mockResolvedValue({
      value: data.deltaItems,
      '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/drives/drive-1/root/delta?token=latest',
      '@odata.nextLink': undefined,
    });
  }

  return mock;
}

/**
 * Create a mock client with paginated responses
 */
export function createPaginatedMockClient(data: {
  sitesPages?: Site[][];
  drivesPages?: Drive[][];
  itemsPages?: DriveItem[][];
}): MockGraphClient {
  const mock = new MockGraphClient();

  if (data.sitesPages && data.sitesPages.length > 0) {
    // Flatten all pages into single array - GraphClient.getSites() handles pagination internally
    const allSites = data.sitesPages.flat();
    mock.getSites.mockResolvedValue(allSites);
  }

  if (data.drivesPages && data.drivesPages.length > 0) {
    // Flatten all pages into single array - GraphClient.getDrives() handles pagination internally
    const allDrives = data.drivesPages.flat();
    mock.getDrives.mockResolvedValue(allDrives);
  }

  if (data.itemsPages && data.itemsPages.length > 0) {
    const responses = data.itemsPages.map((page, index) => ({
      value: page,
      '@odata.nextLink':
        index < data.itemsPages!.length - 1
          ? `https://graph.microsoft.com/v1.0/drives/drive-1/root/children?$skiptoken=page${index + 1}`
          : undefined,
    }));

    mock.getDriveItems.mockImplementation(async () => {
      const currentCall = mock.getDriveItems.mock.calls.length - 1;
      return responses[currentCall] || responses[responses.length - 1];
    });

    // Set up streaming support with all items
    const allItems = data.itemsPages.flat();
    mock.setMockItems(allItems);
  }

  return mock;
}

/**
 * Create a mock client that simulates API errors
 */
export function createErrorMockClient(errorScenario: {
  getSitesError?: Error;
  getDrivesError?: Error;
  getDriveItemsError?: Error;
}): MockGraphClient {
  const mock = new MockGraphClient();

  if (errorScenario.getSitesError) {
    mock.getSites.mockRejectedValue(errorScenario.getSitesError);
  }

  if (errorScenario.getDrivesError) {
    mock.getDrives.mockRejectedValue(errorScenario.getDrivesError);
  }

  if (errorScenario.getDriveItemsError) {
    mock.getDriveItems.mockRejectedValue(errorScenario.getDriveItemsError);
  }

  return mock;
}

/**
 * Create a mock client with mixed success/error responses for specific items
 */
export function createMixedResponseMockClient(scenario: {
  successfulSites: Site[];
  errorAfterSite?: number; // Throw error after processing this many sites
  successfulDrives: Drive[];
  errorAfterDrive?: number;
}): MockGraphClient {
  const mock = new MockGraphClient();

  // Sites with partial failure
  let siteCallCount = 0;
  mock.getSites.mockImplementation(async () => {
    siteCallCount++;
    if (scenario.errorAfterSite && siteCallCount > scenario.errorAfterSite) {
      throw new Error('Rate limit exceeded');
    }
    return scenario.successfulSites;
  });

  // Drives with partial failure
  let driveCallCount = 0;
  mock.getDrives.mockImplementation(async () => {
    driveCallCount++;
    if (scenario.errorAfterDrive && driveCallCount > scenario.errorAfterDrive) {
      throw new Error('Access denied');
    }
    return scenario.successfulDrives;
  });

  return mock;
}

// ─── Mock DeltaTokenManager ──────────────────────────────────────────────

/**
 * Mock DeltaTokenManager for testing delta sync without database
 */
export class MockDeltaTokenManager {
  private tokens: Map<string, string> = new Map();

  getToken = vi.fn(async (driveId: string): Promise<string | null> => {
    return this.tokens.get(driveId) || null;
  });

  saveToken = vi.fn(async (driveId: string, deltaLink: string): Promise<void> => {
    this.tokens.set(driveId, deltaLink);
  });

  resetToken = vi.fn(async (driveId: string): Promise<void> => {
    this.tokens.delete(driveId);
  });

  getAllTokenRecords = vi.fn(async () => {
    return Array.from(this.tokens.entries()).map(([driveId, deltaLink]) => ({
      driveId,
      deltaLink,
      lastSyncAt: new Date(),
      itemsProcessedSinceToken: 0,
    }));
  });

  /**
   * Set tokens for testing
   */
  setTokens(tokens: Record<string, string>): void {
    Object.entries(tokens).forEach(([driveId, token]) => {
      this.tokens.set(driveId, token);
    });
  }

  reset(): void {
    this.tokens.clear();
    this.getToken.mockClear();
    this.saveToken.mockClear();
    this.resetToken.mockClear();
    this.getAllTokenRecords.mockClear();
  }
}

// ─── Mock Models ─────────────────────────────────────────────────────────

/**
 * Create mock models for testing coordinators
 */
export function createMockModels() {
  return {
    SearchDocument: {
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 }),
      insertMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ acknowledged: true, deletedCount: 0 }),
    } as any,
    SearchSource: {
      findOne: vi.fn().mockResolvedValue({ _id: 'source-1', indexId: 'index-1', status: 'active' }),
      findById: vi.fn().mockResolvedValue({ _id: 'source-1', status: 'active' }),
      findByIdAndUpdate: vi.fn().mockResolvedValue({ _id: 'source-1', status: 'active' }),
      findOneAndUpdate: vi.fn().mockResolvedValue({ _id: 'source-1', status: 'active' }),
    } as any,
    SyncCheckpoint: {
      findOne: vi.fn().mockResolvedValue(null),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
    } as any,
    ConnectorConfig: {
      findById: vi.fn().mockResolvedValue(null),
      findByIdAndUpdate: vi.fn().mockResolvedValue(null),
    } as any,
    DriveDeltaToken: (() => {
      const leanMock = vi.fn().mockResolvedValue(null);
      const findOneMock = vi.fn().mockReturnValue({ lean: leanMock });
      return {
        findOne: findOneMock,
        findOneAndUpdate: vi.fn().mockResolvedValue(null),
        // Expose lean mock for test configuration
        _leanMock: leanMock,
      };
    })() as any,
  };
}
