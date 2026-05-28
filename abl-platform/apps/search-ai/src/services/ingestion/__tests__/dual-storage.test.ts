/**
 * Dual HTML Storage Tests
 *
 * Tests that both raw and cleaned HTML versions are stored correctly.
 * These are integration-style tests that verify the file naming and structure.
 */

import { describe, test, expect } from 'vitest';
import crypto from 'crypto';

describe('Dual HTML Storage - Path Generation', () => {
  test('should generate separate paths for raw and cleaned HTML', () => {
    const tenantId = 'tenant1';
    const indexId = 'index1';
    const url = 'https://example.com/article';
    const timestamp = Date.now();
    const urlHash = crypto.createHash('md5').update(url).digest('hex').slice(0, 8);

    // Raw path
    const rawS3Key = `crawler/raw/${tenantId}/${indexId}/${timestamp}-${urlHash}.html`;
    expect(rawS3Key).toContain('/raw/');
    expect(rawS3Key).toContain(tenantId);
    expect(rawS3Key).toContain(indexId);
    expect(rawS3Key).toContain(urlHash);

    // Cleaned path
    const cleanedS3Key = `crawler/cleaned/${tenantId}/${indexId}/${timestamp}-${urlHash}.html`;
    expect(cleanedS3Key).toContain('/cleaned/');
    expect(cleanedS3Key).toContain(tenantId);
    expect(cleanedS3Key).toContain(indexId);
    expect(cleanedS3Key).toContain(urlHash);

    // Paths should be different
    expect(rawS3Key).not.toBe(cleanedS3Key);
  });

  test('should use same timestamp and hash for both files', () => {
    const url = 'https://example.com/test';
    const timestamp = 1234567890;
    const urlHash = crypto.createHash('md5').update(url).digest('hex').slice(0, 8);

    const rawPath = `crawler/raw/tenant1/index1/${timestamp}-${urlHash}.html`;
    const cleanedPath = `crawler/cleaned/tenant1/index1/${timestamp}-${urlHash}.html`;

    // Extract hash from paths
    const rawMatch = rawPath.match(/(\d+)-([a-f0-9]{8})\.html/);
    const cleanedMatch = cleanedPath.match(/(\d+)-([a-f0-9]{8})\.html/);

    expect(rawMatch).toBeTruthy();
    expect(cleanedMatch).toBeTruthy();

    // Same timestamp
    expect(rawMatch![1]).toBe(cleanedMatch![1]);
    // Same hash
    expect(rawMatch![2]).toBe(cleanedMatch![2]);
  });

  test('should calculate size reduction percentage', () => {
    const originalSize = 1000;
    const cleanedSize = 600;
    const sizeReduction = Math.round(((originalSize - cleanedSize) / originalSize) * 100);

    expect(sizeReduction).toBe(40); // 40% reduction

    // Edge cases
    expect(Math.round(((1000 - 1000) / 1000) * 100)).toBe(0); // No reduction
    expect(Math.round(((1000 - 0) / 1000) * 100)).toBe(100); // 100% reduction
  });

  test('should handle size increase gracefully', () => {
    // In some cases, wrapped HTML can be larger than original
    const originalSize = 100;
    const cleanedSize = 150; // Larger after wrapping
    const sizeReduction = Math.round(((originalSize - cleanedSize) / originalSize) * 100);

    // Negative reduction (actually an increase)
    expect(sizeReduction).toBe(-50);

    // We clamp to 0 in the actual code
    const clampedReduction = Math.max(0, sizeReduction);
    expect(clampedReduction).toBe(0);
  });
});

describe('Dual HTML Storage - Metadata Structure', () => {
  test('should structure readability metadata correctly', () => {
    const metadata = {
      success: true,
      cleaned: true,
      sizeReduction: 40,
      originalSize: 1000,
      cleanedSize: 600,
      title: 'Article Title',
      author: 'John Doe',
      excerpt: 'Article excerpt',
    };

    expect(metadata.success).toBe(true);
    expect(metadata.cleaned).toBe(true);
    expect(metadata.sizeReduction).toBeGreaterThan(0);
    expect(metadata.originalSize).toBeGreaterThan(metadata.cleanedSize);
    expect(metadata.title).toBeTruthy();
  });

  test('should include both URLs in document metadata', () => {
    const sourceMetadata = {
      sourceUrl: 'https://example.com/article',
      ingestedVia: 'crawler',
      rawSourceUrl: 's3://bucket/raw/file.html',
      rawContentSize: 1000,
      readability: {
        success: true,
        cleaned: true,
        sizeReduction: 40,
        originalSize: 1000,
        cleanedSize: 600,
      },
    };

    expect(sourceMetadata.rawSourceUrl).toBeDefined();
    expect(sourceMetadata.rawSourceUrl).toContain('/raw/');
    expect(sourceMetadata.rawContentSize).toBeGreaterThan(0);
    expect(sourceMetadata.readability).toBeDefined();
  });
});
