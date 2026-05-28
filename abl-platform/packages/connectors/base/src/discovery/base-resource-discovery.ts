/**
 * Base Resource Discovery
 *
 * Abstract base class using Template Method pattern (matching BaseSyncCoordinator).
 * Connector-specific discovery implementations extend this class.
 */

import type {
  IResourceDiscovery,
  DiscoveredResource,
  ContentProfile,
  DiscoveryProgressCallback,
} from '../interfaces/resource-discovery.interface.js';

// ─── Sensitivity Detection Patterns ─────────────────────────────────────

const PII_PATTERNS = [
  /\bssn\b/i,
  /\bsocial.?security/i,
  /\bpassport/i,
  /\bdriver.?licen[cs]e/i,
  /\btax.?id/i,
  /\bpersonal.?data/i,
  /\bpii\b/i,
  /\bcredit.?card/i,
  /\bbank.?account/i,
];

const FINANCIAL_PATTERNS = [
  /\bfinancial/i,
  /\bpayroll/i,
  /\bsalary/i,
  /\binvoice/i,
  /\btax.?return/i,
  /\bbudget/i,
  /\brevenue/i,
  /\bprofit.?loss/i,
];

const HEALTH_PATTERNS = [
  /\bhipaa/i,
  /\bmedical/i,
  /\bhealth/i,
  /\bpatient/i,
  /\bphi\b/i,
  /\bdiagnos/i,
];

// ─── Update Frequency Thresholds (in days) ──────────────────────────────

const DAILY_THRESHOLD_DAYS = 7;
const WEEKLY_THRESHOLD_DAYS = 30;
const MONTHLY_THRESHOLD_DAYS = 90;

// ─── Abstract Base Class ────────────────────────────────────────────────

export abstract class BaseResourceDiscovery implements IResourceDiscovery {
  abstract readonly connectorType: string;

  /**
   * Discover all available resources. Implemented by connector subclass.
   */
  abstract discoverResources(
    progressCallback?: DiscoveryProgressCallback,
  ): Promise<DiscoveredResource[]>;

  /**
   * Profile content for a specific resource. Implemented by connector subclass.
   */
  abstract profileContent(resourceId: string, sampleSize?: number): Promise<ContentProfile>;

  // ─── Shared Helpers ─────────────────────────────────────────────────────

  /**
   * Detect sensitivity indicators from file names and metadata.
   * Returns a deduplicated list of sensitivity categories found.
   */
  protected detectSensitivity(fileNames: string[], metadata?: Record<string, unknown>): string[] {
    const indicators = new Set<string>();
    const combined = [...fileNames];

    // Include string metadata values in the scan
    if (metadata) {
      for (const value of Object.values(metadata)) {
        if (typeof value === 'string') {
          combined.push(value);
        }
      }
    }

    const text = combined.join(' ');

    for (const pattern of PII_PATTERNS) {
      if (pattern.test(text)) {
        indicators.add('pii');
        break;
      }
    }

    for (const pattern of FINANCIAL_PATTERNS) {
      if (pattern.test(text)) {
        indicators.add('financial');
        break;
      }
    }

    for (const pattern of HEALTH_PATTERNS) {
      if (pattern.test(text)) {
        indicators.add('health');
        break;
      }
    }

    return Array.from(indicators);
  }

  /**
   * Calculate update frequency based on an array of modification dates.
   * Analyzes the recency and spread of dates to estimate how often content changes.
   */
  protected calculateUpdateFrequency(dates: Date[]): 'daily' | 'weekly' | 'monthly' | 'rarely' {
    if (dates.length === 0) {
      return 'rarely';
    }

    const now = Date.now();
    const sortedDates = dates.map((d) => d.getTime()).sort((a, b) => b - a);
    const mostRecentMs = sortedDates[0];
    const daysSinceMostRecent = (now - mostRecentMs) / (1000 * 60 * 60 * 24);

    if (daysSinceMostRecent <= DAILY_THRESHOLD_DAYS) {
      // Check if there's a pattern of frequent updates
      const recentDates = sortedDates.filter((d) => now - d < 30 * 24 * 60 * 60 * 1000);
      if (recentDates.length >= 5) {
        return 'daily';
      }
      return 'weekly';
    }

    if (daysSinceMostRecent <= WEEKLY_THRESHOLD_DAYS) {
      return 'weekly';
    }

    if (daysSinceMostRecent <= MONTHLY_THRESHOLD_DAYS) {
      return 'monthly';
    }

    return 'rarely';
  }

  /**
   * Build a tree structure from a flat list of resources using parentId linkage.
   * Returns root-level resources with children populated recursively.
   */
  protected buildResourceTree(resources: DiscoveredResource[]): DiscoveredResource[] {
    const resourceMap = new Map<string, DiscoveredResource>();
    const roots: DiscoveredResource[] = [];

    // Index all resources
    for (const resource of resources) {
      resourceMap.set(resource.id, { ...resource, children: [] });
    }

    // Build tree by linking children to parents
    for (const resource of resourceMap.values()) {
      if (resource.parentId && resourceMap.has(resource.parentId)) {
        const parent = resourceMap.get(resource.parentId)!;
        parent.children = parent.children || [];
        parent.children.push(resource);
      } else {
        roots.push(resource);
      }
    }

    return roots;
  }
}
