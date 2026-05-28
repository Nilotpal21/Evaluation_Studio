/**
 * SharePoint Resource Discovery
 *
 * Discovers SharePoint sites and drives, profiles their content by sampling
 * documents. Reuses the existing GraphClient for all API calls.
 */

import {
  BaseResourceDiscovery,
  type DiscoveredResource,
  type ContentProfile,
  type DiscoveryProgressCallback,
} from '@agent-platform/connectors-base';
import type { GraphClient } from '../client/graph-client.js';
import type { DriveItem } from '../client/graph-types.js';

// ─── Constants ──────────────────────────────────────────────────────────

const DEFAULT_SAMPLE_SIZE = 100;

// ─── SharePoint Resource Discovery ──────────────────────────────────────

export class SharePointResourceDiscovery extends BaseResourceDiscovery {
  readonly connectorType = 'sharepoint';

  constructor(private readonly graphClient: GraphClient) {
    super();
  }

  /**
   * Discover all SharePoint sites and their drives (document libraries).
   * Returns a flat resource list with parentId linkage: sites have no parent,
   * drives have their site as parent.
   */
  async discoverResources(
    progressCallback?: DiscoveryProgressCallback,
  ): Promise<DiscoveredResource[]> {
    const resources: DiscoveredResource[] = [];

    // Discover sites
    progressCallback?.({
      phase: 'discovering',
      resourcesFound: 0,
      currentResource: 'Fetching sites...',
      percentComplete: 0,
    });

    const sites = await this.graphClient.getSites();

    for (let i = 0; i < sites.length; i++) {
      const site = sites[i];

      resources.push({
        id: site.id,
        name: site.name,
        displayName: site.displayName,
        url: site.webUrl,
        resourceType: 'site',
        parentId: null,
        metadata: {
          description: site.description || '',
          createdDateTime: site.createdDateTime,
          lastModifiedDateTime: site.lastModifiedDateTime,
        },
      });

      progressCallback?.({
        phase: 'discovering',
        resourcesFound: resources.length,
        currentResource: site.displayName,
        percentComplete: Math.round(((i + 1) / sites.length) * 50),
      });

      // Discover drives for each site
      try {
        const drives = await this.graphClient.getDrives(site.id);

        for (const drive of drives) {
          resources.push({
            id: drive.id,
            name: drive.name,
            displayName: `${site.displayName} / ${drive.name}`,
            url: drive.webUrl,
            resourceType: 'drive',
            parentId: site.id,
            metadata: {
              driveType: drive.driveType,
              description: drive.description || '',
              createdDateTime: drive.createdDateTime,
              lastModifiedDateTime: drive.lastModifiedDateTime,
              siteId: site.id,
              siteName: site.displayName,
              owner: drive.owner?.user?.displayName || null,
            },
          });
        }
      } catch (error: unknown) {
        // Some sites may be forbidden (e.g., Search, ContentTypeHub)
        // Continue discovery with other sites
        const errMsg = error instanceof Error ? error.message : String(error);
        resources.push({
          id: `error-${site.id}`,
          name: site.name,
          displayName: `${site.displayName} (access denied)`,
          url: site.webUrl,
          resourceType: 'site-error',
          parentId: null,
          metadata: { error: errMsg, siteId: site.id },
        });
      }

      progressCallback?.({
        phase: 'discovering',
        resourcesFound: resources.length,
        currentResource: site.displayName,
        percentComplete: Math.round(50 + ((i + 1) / sites.length) * 50),
      });
    }

    return resources;
  }

  /**
   * Profile content for a specific drive.
   * Samples documents using getDriveItemsStream and analyzes file types,
   * sizes, dates, and sensitivity indicators.
   */
  async profileContent(
    resourceId: string,
    sampleSize: number = DEFAULT_SAMPLE_SIZE,
  ): Promise<ContentProfile> {
    const fileTypeDistribution: Record<string, number> = {};
    const dates: Date[] = [];
    const fileNames: string[] = [];
    let totalSizeBytes = 0;
    let documentCount = 0;

    for await (const batch of this.graphClient.getDriveItemsStream(resourceId, sampleSize)) {
      for (const item of batch) {
        if (documentCount >= sampleSize) break;

        // Only profile files, not folders
        if (!item.file) continue;

        documentCount++;
        totalSizeBytes += item.size || 0;
        fileNames.push(item.name);

        // Track file type distribution
        const extension = this.extractExtension(item.name);
        fileTypeDistribution[extension] = (fileTypeDistribution[extension] || 0) + 1;

        // Track modification dates
        if (item.lastModifiedDateTime) {
          dates.push(new Date(item.lastModifiedDateTime));
        }
      }

      if (documentCount >= sampleSize) break;
    }

    // Calculate date range
    const sortedDates = dates.sort((a, b) => a.getTime() - b.getTime());
    const dateRange = {
      earliest: sortedDates.length > 0 ? sortedDates[0] : null,
      latest: sortedDates.length > 0 ? sortedDates[sortedDates.length - 1] : null,
    };

    return {
      resourceId,
      totalDocuments: documentCount,
      totalSizeBytes,
      fileTypeDistribution,
      dateRange,
      averageDocumentSizeBytes: documentCount > 0 ? Math.round(totalSizeBytes / documentCount) : 0,
      updateFrequency: this.calculateUpdateFrequency(dates),
      sensitivityIndicators: this.detectSensitivity(fileNames),
      sampleDocumentCount: documentCount,
    };
  }

  /**
   * Extract file extension from a filename.
   */
  private extractExtension(filename: string): string {
    const dotIndex = filename.lastIndexOf('.');
    if (dotIndex === -1 || dotIndex === filename.length - 1) {
      return 'unknown';
    }
    return filename.slice(dotIndex + 1).toLowerCase();
  }
}
