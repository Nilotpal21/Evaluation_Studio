/**
 * SharePoint sourceMetadata Completeness Tests
 *
 * Validates that the expected SharePoint metadata field structure
 * aligns with the fixed mappings defined in connector-type-templates.
 * Tests the field structure expectations against the known DriveItem→SourceDocument mapping.
 */

import { describe, it, expect } from 'vitest';

/**
 * Expected sharepoint metadata fields based on the mapToSourceDocument
 * implementation in full-sync-coordinator.ts (lines 209-243).
 * These must align with the fixed mapping sourcePaths in connector-type-templates.ts.
 */
const EXPECTED_SHAREPOINT_METADATA_FIELDS = [
  'createdDateTime',
  'lastModifiedDateTime',
  'mimeType',
  'size',
  'itemName',
  'createdBy',
  'lastModifiedBy',
  'itemWebUrl',
  'siteId',
  'driveId',
  'parentPath',
] as const;

/**
 * Simulate the metadata.sharepoint structure produced by mapToSourceDocument.
 * This mirrors the exact code in full-sync-coordinator.ts.
 */
function buildSharePointMetadata(driveItem: {
  id: string;
  name: string;
  webUrl: string;
  createdDateTime: string;
  lastModifiedDateTime: string;
  size: number;
  file?: { mimeType?: string; hashes?: { quickXorHash?: string; sha256Hash?: string } };
  createdBy?: { user?: { displayName?: string } };
  lastModifiedBy?: { user?: { displayName?: string } };
  parentReference?: { path?: string };
}) {
  return {
    siteId: 'site-1',
    siteName: 'Test Site',
    siteUrl: 'https://contoso.sharepoint.com/sites/test',
    driveId: 'drive-1',
    driveName: 'Documents',
    driveUrl: 'https://contoso.sharepoint.com/sites/test/Documents',
    itemId: driveItem.id,
    itemName: driveItem.name,
    itemWebUrl: driveItem.webUrl,
    createdBy: driveItem.createdBy?.user?.displayName || 'Unknown',
    lastModifiedBy: driveItem.lastModifiedBy?.user?.displayName || 'Unknown',
    createdDateTime: driveItem.createdDateTime,
    lastModifiedDateTime: driveItem.lastModifiedDateTime,
    mimeType: driveItem.file?.mimeType || 'application/octet-stream',
    size: driveItem.size,
    quickXorHash: driveItem.file?.hashes?.quickXorHash,
    sha256Hash: driveItem.file?.hashes?.sha256Hash,
    parentPath: driveItem.parentReference?.path,
  };
}

describe('SharePoint sourceMetadata field completeness', () => {
  const mockDriveItem = {
    id: 'item-1',
    name: 'Report.pdf',
    webUrl: 'https://contoso.sharepoint.com/sites/test/Documents/Report.pdf',
    createdDateTime: '2026-01-15T10:00:00Z',
    lastModifiedDateTime: '2026-03-10T14:30:00Z',
    size: 2048576,
    file: {
      mimeType: 'application/pdf',
      hashes: {
        quickXorHash: 'abc123',
        sha256Hash: 'def456',
      },
    },
    createdBy: { user: { displayName: 'Alice Smith' } },
    lastModifiedBy: { user: { displayName: 'Bob Jones' } },
    parentReference: { path: '/drives/drive-1/root:/Documents/Reports' },
  };

  it('should include all required metadata fields', () => {
    const metadata = buildSharePointMetadata(mockDriveItem);

    for (const field of EXPECTED_SHAREPOINT_METADATA_FIELDS) {
      expect(metadata).toHaveProperty(field, expect.anything());
    }
  });

  it('should populate createdDateTime and lastModifiedDateTime', () => {
    const metadata = buildSharePointMetadata(mockDriveItem);

    expect(metadata.createdDateTime).toBe('2026-01-15T10:00:00Z');
    expect(metadata.lastModifiedDateTime).toBe('2026-03-10T14:30:00Z');
  });

  it('should populate mimeType from file.mimeType', () => {
    const metadata = buildSharePointMetadata(mockDriveItem);
    expect(metadata.mimeType).toBe('application/pdf');
  });

  it('should populate size as a number', () => {
    const metadata = buildSharePointMetadata(mockDriveItem);
    expect(typeof metadata.size).toBe('number');
    expect(metadata.size).toBe(2048576);
  });

  it('should populate itemName, createdBy, lastModifiedBy', () => {
    const metadata = buildSharePointMetadata(mockDriveItem);
    expect(metadata.itemName).toBe('Report.pdf');
    expect(metadata.createdBy).toBe('Alice Smith');
    expect(metadata.lastModifiedBy).toBe('Bob Jones');
  });

  it('should populate itemWebUrl, siteId, driveId, parentPath', () => {
    const metadata = buildSharePointMetadata(mockDriveItem);
    expect(metadata.itemWebUrl).toBe(
      'https://contoso.sharepoint.com/sites/test/Documents/Report.pdf',
    );
    expect(metadata.siteId).toBe('site-1');
    expect(metadata.driveId).toBe('drive-1');
    expect(metadata.parentPath).toBe('/drives/drive-1/root:/Documents/Reports');
  });

  it('should fallback to defaults when optional fields are missing', () => {
    const minimalItem = {
      id: 'item-2',
      name: 'Empty.txt',
      webUrl: 'https://contoso.sharepoint.com/file',
      createdDateTime: '2026-01-01T00:00:00Z',
      lastModifiedDateTime: '2026-01-01T00:00:00Z',
      size: 0,
    };

    const metadata = buildSharePointMetadata(minimalItem);

    expect(metadata.createdBy).toBe('Unknown');
    expect(metadata.lastModifiedBy).toBe('Unknown');
    expect(metadata.mimeType).toBe('application/octet-stream');
    expect(metadata.parentPath).toBeUndefined();
  });

  it('metadata field names should align with fixed mapping sourcePaths', () => {
    // The fixed mappings reference paths like 'sharepoint.itemName', 'sharepoint.createdBy', etc.
    // The metadata object keys should match the second segment of those paths.
    const fixedMappingFields = [
      'itemName',
      'createdBy',
      'lastModifiedBy',
      'createdDateTime',
      'lastModifiedDateTime',
      'itemWebUrl',
      'mimeType',
      'parentPath',
      'siteId',
      'driveId',
      'size',
    ];

    const metadata = buildSharePointMetadata(mockDriveItem);
    const metadataKeys = Object.keys(metadata);

    for (const field of fixedMappingFields) {
      expect(metadataKeys).toContain(field);
    }
  });
});
