/**
 * SharePointFilterEngine Tests
 *
 * Tests SharePoint-specific filtering (sites, libraries, content types).
 */

import { describe, it, expect } from 'vitest';
import { SharePointFilterEngine } from '../filters/sharepoint-filter-engine.js';
import type { SourceDocument } from '@agent-platform/connectors-base';
import { createFilterConfig } from './helpers/filter-config-factory.js';

describe('SharePointFilterEngine', () => {
  const createDocument = (overrides: Partial<SourceDocument> = {}): SourceDocument => ({
    id: 'item-123',
    name: 'document.pdf',
    url: 'https://contoso.sharepoint.com/sites/engineering/Shared%20Documents/document.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    modifiedAt: new Date('2024-01-15'),
    createdAt: new Date('2024-01-01'),
    content: null,
    metadata: {
      sharepoint: {
        siteId: 'site-123',
        siteName: 'Engineering',
        siteUrl: 'https://contoso.sharepoint.com/sites/engineering',
        driveId: 'drive-123',
        driveName: 'Shared Documents',
        driveUrl: 'https://contoso.sharepoint.com/sites/engineering/Shared%20Documents',
        itemId: 'item-123',
        itemName: 'document.pdf',
        itemWebUrl:
          'https://contoso.sharepoint.com/sites/engineering/Shared%20Documents/document.pdf',
        createdBy: 'John Doe',
        lastModifiedBy: 'Jane Smith',
      },
    },
    ...overrides,
  });

  describe('Site URL Filtering', () => {
    it('should include document from allowed site (include mode)', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          scope: {
            siteMode: 'selected',
            sitePatterns: ['**/sites/engineering'],
          },
        }),
      );

      const doc = createDocument();
      const result = engine.evaluate(doc);

      expect(result.include).toBe(true);
    });

    it('should exclude document from non-allowed site (include mode)', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          scope: {
            siteMode: 'selected',
            sitePatterns: ['**/sites/marketing'],
          },
        }),
      );

      const doc = createDocument();
      const result = engine.evaluate(doc);

      expect(result.include).toBe(false);
      expect(result.reason).toContain('Site not in selected list');
    });

    it('should exclude document from blocked site (exclude mode)', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          scope: {
            siteMode: 'excluded',
            sitePatterns: ['**/sites/engineering'],
          },
        }),
      );

      const doc = createDocument();
      const result = engine.evaluate(doc);

      expect(result.include).toBe(false);
      expect(result.reason).toContain('Site in excluded list');
    });

    it('should include document from non-blocked site (exclude mode)', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          scope: {
            siteMode: 'excluded',
            sitePatterns: ['**/sites/marketing'],
          },
        }),
      );

      const doc = createDocument();
      const result = engine.evaluate(doc);

      expect(result.include).toBe(true);
    });

    it('should handle partial site URL matches via glob patterns', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          scope: {
            siteMode: 'selected',
            sitePatterns: ['**/engineering'],
          },
        }),
      );

      const doc = createDocument();
      const result = engine.evaluate(doc);

      expect(result.include).toBe(true);
    });

    it('should handle multiple site IDs', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          scope: {
            siteMode: 'selected',
            siteIds: ['site-123', 'site-hr'],
          },
        }),
      );

      expect(engine.evaluate(createDocument()).include).toBe(true);

      const hrDoc = createDocument({
        metadata: {
          sharepoint: {
            ...createDocument().metadata.sharepoint,
            siteId: 'site-hr',
            siteUrl: 'https://contoso.sharepoint.com/sites/hr',
          },
        },
      });
      expect(engine.evaluate(hrDoc).include).toBe(true);

      const marketingDoc = createDocument({
        metadata: {
          sharepoint: {
            ...createDocument().metadata.sharepoint,
            siteId: 'site-marketing',
            siteUrl: 'https://contoso.sharepoint.com/sites/marketing',
          },
        },
      });
      expect(engine.evaluate(marketingDoc).include).toBe(false);
    });
  });

  describe('Library Name Filtering', () => {
    it('should include document from allowed library (include mode)', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          scope: {
            libraryMode: 'selected',
            libraryNames: ['Shared Documents', 'Documents'],
          },
        }),
      );

      const doc = createDocument();
      const result = engine.evaluate(doc);

      expect(result.include).toBe(true);
    });

    it('should exclude document from non-allowed library (include mode)', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          scope: {
            libraryMode: 'selected',
            libraryNames: ['Private Documents'],
          },
        }),
      );

      const doc = createDocument();
      const result = engine.evaluate(doc);

      expect(result.include).toBe(false);
      expect(result.reason).toContain('Library not in selected list');
    });

    it('should handle case-insensitive library name matching', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          scope: {
            libraryMode: 'selected',
            libraryNames: ['shared documents'], // lowercase
          },
        }),
      );

      const doc = createDocument(); // Has "Shared Documents"
      const result = engine.evaluate(doc);

      expect(result.include).toBe(true);
    });

    it('should handle library pattern matching', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          scope: {
            libraryMode: 'selected',
            libraryPatterns: ['Shared*'],
          },
        }),
      );

      const doc = createDocument(); // Has "Shared Documents"
      const result = engine.evaluate(doc);

      expect(result.include).toBe(true);
    });
  });

  describe('SharePoint Content Type Filtering', () => {
    it('should filter by files content category', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          standard: { contentCategories: ['files'] },
        }),
      );

      expect(engine.evaluate(createDocument({ contentType: 'application/pdf' })).include).toBe(
        true,
      );
      expect(
        engine.evaluate(createDocument({ contentType: 'application/vnd.ms-excel' })).include,
      ).toBe(true);
      expect(engine.evaluate(createDocument({ contentType: 'text/html' })).include).toBe(false); // Page
    });

    it('should filter by pages content category', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          standard: { contentCategories: ['pages'] },
        }),
      );

      expect(engine.evaluate(createDocument({ contentType: 'text/html' })).include).toBe(true);
      expect(engine.evaluate(createDocument({ contentType: 'application/pdf' })).include).toBe(
        false,
      );
    });

    it('should allow all content when no categories configured', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          standard: { contentCategories: [] },
        }),
      );

      expect(engine.evaluate(createDocument({ contentType: 'application/pdf' })).include).toBe(
        true,
      );
      expect(engine.evaluate(createDocument({ contentType: 'text/html' })).include).toBe(true);
      expect(engine.evaluate(createDocument({ contentType: 'image/jpeg' })).include).toBe(true);
    });

    it('should support multiple content categories', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          standard: { contentCategories: ['files', 'pages'] },
        }),
      );

      // Files
      expect(engine.evaluate(createDocument({ contentType: 'application/pdf' })).include).toBe(
        true,
      );
      expect(engine.evaluate(createDocument({ contentType: 'application/msword' })).include).toBe(
        true,
      );

      // Pages
      expect(engine.evaluate(createDocument({ contentType: 'text/html' })).include).toBe(true);
    });
  });

  describe('Combined SharePoint Filters', () => {
    it('should apply site and library filters together', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          scope: {
            siteMode: 'selected',
            siteIds: ['site-123'],
            libraryMode: 'selected',
            libraryNames: ['Shared Documents'],
          },
        }),
      );

      // Both match
      const validDoc = createDocument();
      expect(engine.evaluate(validDoc).include).toBe(true);

      // Wrong site
      const wrongSite = createDocument({
        metadata: {
          sharepoint: {
            ...createDocument().metadata.sharepoint,
            siteId: 'site-marketing',
            siteUrl: 'https://contoso.sharepoint.com/sites/marketing',
          },
        },
      });
      expect(engine.evaluate(wrongSite).include).toBe(false);

      // Wrong library
      const wrongLibrary = createDocument({
        metadata: {
          sharepoint: {
            ...createDocument().metadata.sharepoint,
            driveName: 'Private Documents',
          },
        },
      });
      expect(engine.evaluate(wrongLibrary).include).toBe(false);
    });

    it('should apply all filters including base filters', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          standard: {
            contentCategories: ['files'],
            minFileSizeBytes: 1024,
            modifiedAfter: new Date('2024-01-10'),
          },
          scope: {
            siteMode: 'selected',
            siteIds: ['site-123'],
          },
        }),
      );

      // All filters pass
      const validDoc = createDocument({
        contentType: 'application/pdf',
        sizeBytes: 2048,
        modifiedAt: new Date('2024-01-15'),
      });
      expect(engine.evaluate(validDoc).include).toBe(true);

      // Wrong content type (page, not file)
      const wrongType = createDocument({
        contentType: 'text/html',
        sizeBytes: 2048,
        modifiedAt: new Date('2024-01-15'),
      });
      expect(engine.evaluate(wrongType).include).toBe(false);

      // Too small
      const tooSmall = createDocument({
        contentType: 'application/pdf',
        sizeBytes: 512,
        modifiedAt: new Date('2024-01-15'),
      });
      expect(engine.evaluate(tooSmall).include).toBe(false);
    });
  });

  describe('Missing Metadata', () => {
    it('should allow documents without SharePoint metadata (scope not applied)', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          scope: {
            siteMode: 'selected',
            siteIds: ['site-123'],
          },
        }),
      );

      const docWithoutMetadata = createDocument({ metadata: {} });
      const result = engine.evaluate(docWithoutMetadata);

      // Scope evaluation returns passed=true, applied=false when no SP metadata
      expect(result.include).toBe(true);
    });

    it('should allow documents with null metadata (scope not applied)', () => {
      const engine = new SharePointFilterEngine(createFilterConfig());

      const docWithNullMetadata = createDocument({ metadata: { sharepoint: null } as any });
      const result = engine.evaluate(docWithNullMetadata);

      expect(result.include).toBe(true);
    });
  });

  describe('Validation', () => {
    it('should require site IDs when siteMode is selected', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          scope: {
            siteMode: 'selected',
            siteIds: [],
            sitePatterns: [],
          },
        }),
      );

      const result = engine.validate();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'scope.siteIds')).toBe(true);
    });

    it('should require library names when libraryMode is selected', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          scope: {
            libraryMode: 'selected',
            libraryNames: [],
            libraryPatterns: [],
          },
        }),
      );

      const result = engine.validate();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'scope.libraryNames')).toBe(true);
    });

    it('should reject empty site patterns', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          scope: {
            siteMode: 'selected',
            sitePatterns: ['valid-pattern', '', '  '],
          },
        }),
      );

      const result = engine.validate();
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'scope.sitePatterns')).toBe(true);
    });

    it('should pass validation with valid config', () => {
      const engine = new SharePointFilterEngine(
        createFilterConfig({
          standard: { contentCategories: ['files', 'pages'] },
          scope: {
            siteMode: 'selected',
            siteIds: ['site-123'],
            libraryMode: 'selected',
            libraryNames: ['Shared Documents', 'Documents'],
          },
        }),
      );

      const result = engine.validate();
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
