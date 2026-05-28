/**
 * Tests for Path Extractor Service
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PathExtractor } from '../../services/structured-data/path-extractor.js';

describe('PathExtractor', () => {
  let extractor: PathExtractor;
  const tenantId = 'tenant-123';
  const indexId = 'index-123';
  const objectId = 'obj-123';

  beforeEach(() => {
    extractor = new PathExtractor();
  });

  // ==========================================================================
  // BASIC PATH EXTRACTION
  // ==========================================================================

  describe('Basic Path Extraction', () => {
    it('should extract paths from flat object', () => {
      const obj = {
        name: 'Alice',
        age: 30,
        active: true,
      };

      const result = extractor.extractPathsFromJSON(obj, tenantId, indexId, objectId);

      expect(result.entries).toHaveLength(4); // 3 fields + root
      expect(result.entries.map((e) => e.path)).toContain('name');
      expect(result.entries.map((e) => e.path)).toContain('age');
      expect(result.entries.map((e) => e.path)).toContain('active');

      const nameEntry = result.entries.find((e) => e.path === 'name');
      expect(nameEntry?.valueType).toBe('string');
      expect(nameEntry?.valueString).toBe('Alice');
      expect(nameEntry?.pathNormalized).toBe('name');
      expect(nameEntry?.pathTokens).toEqual(['name']);
      expect(nameEntry?.depth).toBe(1);
      expect(nameEntry?.parentPath).toBeNull();
    });

    it('should extract paths from nested object', () => {
      const obj = {
        user: {
          profile: {
            name: 'Bob',
            email: 'bob@example.com',
          },
          settings: {
            theme: 'dark',
          },
        },
      };

      const result = extractor.extractPathsFromJSON(obj, tenantId, indexId, objectId);

      expect(result.entries.map((e) => e.path)).toContain('user.profile.name');
      expect(result.entries.map((e) => e.path)).toContain('user.profile.email');
      expect(result.entries.map((e) => e.path)).toContain('user.settings.theme');

      const nameEntry = result.entries.find((e) => e.path === 'user.profile.name');
      expect(nameEntry?.depth).toBe(3);
      expect(nameEntry?.parentPath).toBe('user.profile');
      expect(nameEntry?.pathTokens).toEqual(['user', 'profile', 'name']);
      expect(nameEntry?.pathNormalized).toBe('user.profile.name');
    });

    it('should extract paths from arrays', () => {
      const obj = {
        users: [
          { name: 'Alice', age: 30 },
          { name: 'Bob', age: 25 },
        ],
      };

      const result = extractor.extractPathsFromJSON(obj, tenantId, indexId, objectId);

      expect(result.entries.map((e) => e.path)).toContain('users[0].name');
      expect(result.entries.map((e) => e.path)).toContain('users[0].age');
      expect(result.entries.map((e) => e.path)).toContain('users[1].name');
      expect(result.entries.map((e) => e.path)).toContain('users[1].age');

      // Check normalization (array indices removed)
      const nameEntry = result.entries.find((e) => e.path === 'users[0].name');
      expect(nameEntry?.pathNormalized).toBe('users[].name');
      expect(nameEntry?.pathTokens).toEqual(['users', 'name']);
      expect(nameEntry?.parentPath).toBe('users[0]');
    });

    it('should handle all value types', () => {
      const obj = {
        stringVal: 'hello',
        numberVal: 42,
        boolVal: true,
        nullVal: null,
        arrayVal: [1, 2, 3],
        objectVal: { nested: 'value' },
      };

      const result = extractor.extractPathsFromJSON(obj, tenantId, indexId, objectId);

      const stringEntry = result.entries.find((e) => e.path === 'stringVal');
      expect(stringEntry?.valueType).toBe('string');
      expect(stringEntry?.valueString).toBe('hello');

      const numberEntry = result.entries.find((e) => e.path === 'numberVal');
      expect(numberEntry?.valueType).toBe('number');
      expect(numberEntry?.valueNumber).toBe(42);

      const boolEntry = result.entries.find((e) => e.path === 'boolVal');
      expect(boolEntry?.valueType).toBe('boolean');
      expect(boolEntry?.valueBoolean).toBe(true);

      const nullEntry = result.entries.find((e) => e.path === 'nullVal');
      expect(nullEntry?.valueType).toBe('null');

      const arrayEntry = result.entries.find((e) => e.path === 'arrayVal');
      expect(arrayEntry?.valueType).toBe('array');

      const objectEntry = result.entries.find((e) => e.path === 'objectVal');
      expect(objectEntry?.valueType).toBe('object');
    });
  });

  // ==========================================================================
  // DEPTH LIMITING
  // ==========================================================================

  describe('Depth Limiting', () => {
    it('should respect maxDepth config', () => {
      const deepObject = {
        l1: {
          l2: {
            l3: {
              l4: {
                l5: {
                  l6: 'too deep',
                },
              },
            },
          },
        },
      };

      const shallowExtractor = new PathExtractor({ maxDepth: 3 });
      const result = shallowExtractor.extractPathsFromJSON(deepObject, tenantId, indexId, objectId);

      // Should not extract paths deeper than maxDepth
      expect(result.entries.map((e) => e.path)).not.toContain('l1.l2.l3.l4');
      expect(result.entries.map((e) => e.path)).toContain('l1.l2.l3');
      expect(result.statistics.maxDepth).toBe(3);
    });
  });

  // ==========================================================================
  // ARRAY HANDLING
  // ==========================================================================

  describe('Array Handling', () => {
    it('should handle small arrays fully', () => {
      const obj = {
        items: [1, 2, 3, 4, 5],
      };

      const result = extractor.extractPathsFromJSON(obj, tenantId, indexId, objectId);

      expect(result.entries.map((e) => e.path)).toContain('items[0]');
      expect(result.entries.map((e) => e.path)).toContain('items[4]');
      expect(result.statistics.truncatedArrays).toBe(0);
    });

    it('should sample large arrays', () => {
      const largeArray = Array.from({ length: 2000 }, (_, i) => i);
      const obj = {
        items: largeArray,
      };

      const result = extractor.extractPathsFromJSON(obj, tenantId, indexId, objectId);

      // Should sample large arrays (default: first 100, last 100, random 100)
      const itemPaths = result.entries.filter((e) => e.path.startsWith('items['));
      expect(itemPaths.length).toBeLessThan(2000);
      expect(itemPaths.length).toBeGreaterThan(200); // At least first+last
      expect(result.statistics.truncatedArrays).toBe(1);
    });

    it('should handle maxArraySize config', () => {
      const obj = {
        items: Array.from({ length: 200 }, (_, i) => i),
      };

      const smallExtractor = new PathExtractor({ maxArraySize: 50, sampleLargeArrays: false });
      const result = smallExtractor.extractPathsFromJSON(obj, tenantId, indexId, objectId);

      const itemPaths = result.entries.filter((e) => e.path.startsWith('items['));
      expect(itemPaths.length).toBe(50);
      expect(result.statistics.truncatedArrays).toBe(1);
    });
  });

  // ==========================================================================
  // STRING TRUNCATION
  // ==========================================================================

  describe('String Truncation', () => {
    it('should truncate long strings', () => {
      const longString = 'a'.repeat(2000);
      const obj = {
        description: longString,
      };

      const result = extractor.extractPathsFromJSON(obj, tenantId, indexId, objectId);

      const descEntry = result.entries.find((e) => e.path === 'description');
      expect(descEntry?.valueString?.length).toBe(1000); // Default maxStringLength
      expect(result.statistics.truncatedValues).toBeGreaterThan(0);
    });

    it('should respect maxStringLength config', () => {
      const obj = {
        text: 'a'.repeat(500),
      };

      const extractor = new PathExtractor({ maxStringLength: 100 });
      const result = extractor.extractPathsFromJSON(obj, tenantId, indexId, objectId);

      const textEntry = result.entries.find((e) => e.path === 'text');
      expect(textEntry?.valueString?.length).toBe(100);
    });
  });

  // ==========================================================================
  // REAL-WORLD SCENARIOS
  // ==========================================================================

  describe('Real-World Scenarios', () => {
    it('should handle e-commerce product data', () => {
      const product = {
        id: 'prod-123',
        name: 'Laptop Pro',
        price: 1299.99,
        inStock: true,
        categories: ['electronics', 'computers'],
        specifications: {
          cpu: 'Intel i7',
          ram: '16GB',
          storage: '512GB SSD',
        },
        reviews: [
          {
            author: 'Alice',
            rating: 5,
            comment: 'Excellent product!',
          },
          {
            author: 'Bob',
            rating: 4,
            comment: 'Good value',
          },
        ],
      };

      const result = extractor.extractPathsFromJSON(product, tenantId, indexId, objectId);

      expect(result.entries.map((e) => e.path)).toContain('specifications.cpu');
      expect(result.entries.map((e) => e.path)).toContain('reviews[0].author');
      expect(result.entries.map((e) => e.path)).toContain('reviews[1].rating');
      expect(result.entries.map((e) => e.path)).toContain('categories[0]');

      // Verify normalization for pattern matching
      const reviewAuthor = result.entries.find((e) => e.path === 'reviews[0].author');
      expect(reviewAuthor?.pathNormalized).toBe('reviews[].author');
    });

    it('should handle user profile with nested preferences', () => {
      const userProfile = {
        userId: 'user-456',
        profile: {
          name: 'Carol White',
          email: 'carol@example.com',
          preferences: {
            notifications: {
              email: true,
              sms: false,
              push: true,
            },
            privacy: {
              profileVisible: true,
              searchable: false,
            },
          },
        },
        activityLog: [
          { action: 'login', timestamp: '2024-01-15T10:00:00Z' },
          { action: 'purchase', timestamp: '2024-01-16T14:30:00Z' },
        ],
      };

      const result = extractor.extractPathsFromJSON(userProfile, tenantId, indexId, objectId);

      expect(result.entries.map((e) => e.path)).toContain(
        'profile.preferences.notifications.email',
      );
      expect(result.entries.map((e) => e.path)).toContain('profile.preferences.privacy.searchable');
      expect(result.entries.map((e) => e.path)).toContain('activityLog[0].action');

      const notifEmail = result.entries.find(
        (e) => e.path === 'profile.preferences.notifications.email',
      );
      expect(notifEmail?.valueType).toBe('boolean');
      expect(notifEmail?.valueBoolean).toBe(true);
      expect(notifEmail?.depth).toBe(4);
    });

    it('should handle deeply nested API response', () => {
      const apiResponse = {
        data: {
          user: {
            id: 1,
            attributes: {
              profile: {
                personal: {
                  firstName: 'David',
                  lastName: 'Brown',
                  contacts: {
                    emails: ['david@example.com', 'david.brown@work.com'],
                  },
                },
              },
            },
          },
        },
      };

      const result = extractor.extractPathsFromJSON(apiResponse, tenantId, indexId, objectId);

      expect(result.entries.map((e) => e.path)).toContain(
        'data.user.attributes.profile.personal.firstName',
      );
      expect(result.entries.map((e) => e.path)).toContain(
        'data.user.attributes.profile.personal.contacts.emails[0]',
      );

      const email = result.entries.find(
        (e) => e.path === 'data.user.attributes.profile.personal.contacts.emails[0]',
      );
      expect(email?.pathNormalized).toBe('data.user.attributes.profile.personal.contacts.emails[]');
      expect(email?.pathTokens).toEqual([
        'data',
        'user',
        'attributes',
        'profile',
        'personal',
        'contacts',
        'emails',
      ]);
    });
  });

  // ==========================================================================
  // METADATA VALIDATION
  // ==========================================================================

  describe('Metadata Validation', () => {
    it('should include tenant and index isolation fields', () => {
      const obj = { test: 'value' };

      const result = extractor.extractPathsFromJSON(obj, tenantId, indexId, objectId);

      for (const entry of result.entries) {
        expect(entry.tenantId).toBe(tenantId);
        expect(entry.indexId).toBe(indexId);
        expect(entry.objectId).toBe(objectId);
        expect(entry.objectType).toBe('json');
      }
    });

    it('should track statistics correctly', () => {
      const obj = {
        largeArray: Array.from({ length: 2000 }, (_, i) => i),
        longString: 'a'.repeat(2000),
        nested: {
          level2: {
            level3: 'value',
          },
        },
      };

      const result = extractor.extractPathsFromJSON(obj, tenantId, indexId, objectId);

      expect(result.statistics.totalPaths).toBe(result.entries.length);
      expect(result.statistics.maxDepth).toBeGreaterThan(0);
      expect(result.statistics.truncatedArrays).toBeGreaterThan(0);
      expect(result.statistics.truncatedValues).toBeGreaterThan(0);
    });
  });
});
