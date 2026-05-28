/**
 * Recommendation Engine Tests
 *
 * Tests deterministic scoring algorithms, sync strategy selection,
 * permission mode recommendation, and cost estimation.
 */

import { describe, it, expect } from 'vitest';
import { RecommendationEngineService } from '../recommendation-engine.service.js';
import type { DiscoveredResource, ContentProfile } from '@agent-platform/connectors-base';

// ─── Helpers ────────────────────────────────────────────────────────────

function createResource(overrides: Partial<DiscoveredResource> = {}): DiscoveredResource {
  return {
    id: 'drive-1',
    name: 'Documents',
    displayName: 'Test Site / Documents',
    url: 'https://example.com/drive1',
    resourceType: 'drive',
    parentId: 'site-1',
    metadata: {},
    ...overrides,
  };
}

function createProfile(overrides: Partial<ContentProfile> = {}): ContentProfile {
  return {
    resourceId: 'drive-1',
    totalDocuments: 500,
    totalSizeBytes: 50_000_000,
    fileTypeDistribution: { pdf: 200, docx: 150, xlsx: 100, pptx: 50 },
    dateRange: {
      earliest: new Date('2024-01-01'),
      latest: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
    },
    averageDocumentSizeBytes: 100_000,
    updateFrequency: 'daily',
    sensitivityIndicators: [],
    sampleDocumentCount: 100,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('RecommendationEngineService', () => {
  const engine = new RecommendationEngineService();

  describe('scoreResource', () => {
    it('should score a high-activity, rich content resource highly', () => {
      const resource = createResource();
      const profile = createProfile();
      const score = engine.scoreResource(resource, profile);

      expect(score.overallScore).toBeGreaterThan(0.5);
      expect(score.recommended).toBe(true);
      expect(score.factors.activityScore).toBe(1.0);
      expect(score.factors.contentScore).toBe(1.0);
    });

    it('should penalize resources with PII', () => {
      const resource = createResource({ id: 'drive-pii' });
      const profile = createProfile({
        resourceId: 'drive-pii',
        sensitivityIndicators: ['pii'],
      });

      const cleanScore = engine.scoreResource(
        createResource(),
        createProfile({ sensitivityIndicators: [] }),
      );
      const piiScore = engine.scoreResource(resource, profile);

      expect(piiScore.overallScore).toBeLessThan(cleanScore.overallScore);
      expect(piiScore.factors.sensitivityPenalty).toBeGreaterThan(0);
    });

    it('should mark heavily penalized resources as not recommended', () => {
      const resource = createResource({ id: 'drive-sensitive' });
      const profile = createProfile({
        resourceId: 'drive-sensitive',
        sensitivityIndicators: ['pii', 'health', 'financial'],
        totalDocuments: 5, // small
        dateRange: {
          earliest: new Date('2020-01-01'),
          latest: new Date('2020-06-01'), // old
        },
        updateFrequency: 'rarely',
        fileTypeDistribution: { exe: 5 },
      });

      const score = engine.scoreResource(resource, profile);
      expect(score.recommended).toBe(false);
    });

    it('should handle resource with no profile', () => {
      const resource = createResource();
      const score = engine.scoreResource(resource, undefined);

      expect(score.overallScore).toBeLessThan(0.2);
      expect(score.factors.activityScore).toBe(0.1);
    });

    it('should score ideal-sized collections highest', () => {
      const idealProfile = createProfile({ totalDocuments: 5000 });
      const smallProfile = createProfile({ totalDocuments: 5 });

      const idealScore = engine.scoreResource(createResource(), idealProfile);
      const smallScore = engine.scoreResource(createResource(), smallProfile);

      expect(idealScore.factors.sizeScore).toBeGreaterThan(smallScore.factors.sizeScore);
    });

    it('should score media-heavy content lower', () => {
      const richProfile = createProfile({
        fileTypeDistribution: { pdf: 80, docx: 20 },
      });
      const mediaProfile = createProfile({
        fileTypeDistribution: { jpg: 80, mp4: 20 },
      });

      const richScore = engine.scoreResource(createResource(), richProfile);
      const mediaScore = engine.scoreResource(createResource(), mediaProfile);

      expect(richScore.factors.contentScore).toBeGreaterThan(mediaScore.factors.contentScore);
    });
  });

  describe('recommendSyncStrategy', () => {
    it('should recommend hourly delta for daily-updated content', () => {
      const profiles = [createProfile({ updateFrequency: 'daily' })];
      const strategy = engine.recommendSyncStrategy(profiles);

      expect(strategy.syncMode).toBe('full_then_delta');
      expect(strategy.deltaSyncSchedule).toBe('0 * * * *');
      expect(strategy.enableWebhooks).toBe(true);
      expect(strategy.confidence).toBeGreaterThan(0.7);
    });

    it('should recommend 6-hour delta for weekly-updated content', () => {
      const profiles = [createProfile({ updateFrequency: 'weekly' })];
      const strategy = engine.recommendSyncStrategy(profiles);

      expect(strategy.syncMode).toBe('full_then_delta');
      expect(strategy.deltaSyncSchedule).toBe('0 */6 * * *');
      expect(strategy.enableWebhooks).toBe(false);
    });

    it('should recommend full-only for rarely updated content', () => {
      const profiles = [createProfile({ updateFrequency: 'rarely' })];
      const strategy = engine.recommendSyncStrategy(profiles);

      expect(strategy.syncMode).toBe('full_only');
      expect(strategy.deltaSyncSchedule).toBeNull();
    });

    it('should handle empty profiles', () => {
      const strategy = engine.recommendSyncStrategy([]);
      expect(strategy.syncMode).toBe('full_only');
      expect(strategy.confidence).toBe(0.3);
    });
  });

  describe('recommendPermissionMode', () => {
    it('should default to simplified mode', () => {
      const mode = engine.recommendPermissionMode();
      expect(mode.mode).toBe('simplified');
      expect(mode.confidence).toBeGreaterThan(0);
    });
  });

  describe('estimateCosts', () => {
    it('should estimate costs based on recommended resources', () => {
      const resources = [createResource()];
      const profiles = [createProfile({ totalDocuments: 1000, totalSizeBytes: 100_000_000 })];
      const scores = resources.map((r) => engine.scoreResource(r, profiles[0]));
      const strategy = engine.recommendSyncStrategy(profiles);
      const costs = engine.estimateCosts(scores, profiles, strategy);

      expect(costs.estimatedDocuments).toBe(1000);
      expect(costs.estimatedStorageBytes).toBe(100_000_000);
      expect(costs.estimatedSyncDurationSeconds).toBeGreaterThan(0);
      expect(costs.estimatedMonthlyApiCalls).toBeGreaterThan(0);
    });

    it('should handle 0 resources', () => {
      const costs = engine.estimateCosts([], [], engine.recommendSyncStrategy([]));
      expect(costs.estimatedDocuments).toBe(0);
      expect(costs.estimatedSyncDurationSeconds).toBe(0);
    });
  });

  describe('generateRecommendation (end-to-end)', () => {
    it('should generate a complete recommendation', () => {
      const resources = [
        createResource({ id: 'drive-1', displayName: 'Engineering Docs' }),
        createResource({ id: 'drive-2', displayName: 'Marketing Assets' }),
        // Non-drive resources should be ignored
        createResource({ id: 'site-1', resourceType: 'site' }),
      ];

      const profiles = [
        createProfile({ resourceId: 'drive-1', totalDocuments: 500 }),
        createProfile({ resourceId: 'drive-2', totalDocuments: 200 }),
      ];

      const recommendation = engine.generateRecommendation(resources, profiles);

      // Only drives are scored
      expect(recommendation.resourceScores).toHaveLength(2);
      expect(recommendation.syncStrategy).toBeDefined();
      expect(recommendation.permissionMode).toBeDefined();
      expect(recommendation.filterConfig).toBeDefined();
      expect(recommendation.costEstimate).toBeDefined();
      expect(recommendation.overallConfidence).toBeGreaterThan(0);
      expect(recommendation.generatedAt).toBeInstanceOf(Date);
    });

    it('should handle single resource', () => {
      const resources = [createResource()];
      const profiles = [createProfile()];
      const recommendation = engine.generateRecommendation(resources, profiles);

      expect(recommendation.resourceScores).toHaveLength(1);
    });

    it('should handle many resources', () => {
      const resources = Array.from({ length: 100 }, (_, i) =>
        createResource({ id: `drive-${i}`, displayName: `Drive ${i}` }),
      );
      const profiles = resources.map((r) => createProfile({ resourceId: r.id }));

      const recommendation = engine.generateRecommendation(resources, profiles);
      expect(recommendation.resourceScores).toHaveLength(100);
    });
  });
});
