import { describe, it, expect, vi } from 'vitest';
import {
  compressToolResult,
  summarizeToolResult,
  DEFAULT_SUMMARIZE_PROMPT,
} from '../../services/execution/tool-result-compressor.js';
import { DEFAULT_COMPACTION_POLICY } from '../../services/execution/compaction-policy.js';
import type { CompactionPolicy } from '@abl/compiler/platform/ir/schema.js';

/** Legacy essential fields — replicate the old hardcoded product/offer field lists via policy */
const LEGACY_PRODUCT_POLICY: CompactionPolicy = {
  ...DEFAULT_COMPACTION_POLICY,
  tool_results: {
    ...DEFAULT_COMPACTION_POLICY.tool_results,
    essential_fields: {
      product_search: [
        'id',
        'title',
        'brand',
        'price',
        'salePrice',
        'color',
        'size',
        'description',
        'product_image',
        'gender',
        'category',
        'productType',
        'discount',
        'isPreOwned',
        'model',
        'year',
        'mileage',
        'fuelType',
        'transmission',
      ],
      offer_search: ['id', 'title', 'brand', 'description', 'discount', 'validUntil', 'category'],
    },
  },
};

describe('compressToolResult', () => {
  it('returns small results unchanged', () => {
    const small = JSON.stringify({ success: true, data: 'hello' });
    expect(compressToolResult(small)).toBe(small);
  });

  it('compresses product search results by stripping noise fields', () => {
    const products = Array.from({ length: 10 }, (_, i) => ({
      id: `prod-${i}`,
      title: `Product ${i}`,
      brand: 'TestBrand',
      price: `${100 + i * 50}`,
      salePrice: `${80 + i * 40}`,
      color: ['red'],
      size: ['M', 'L'],
      description: 'A '.repeat(500),
      product_image: `https://cdn.example.com/img-${i}.jpg`,
      complementaryanalogous: Array.from({ length: 40 }, (_, j) => `sku-${j}`),
      keyFeatures: Array.from({ length: 20 }, (_, j) => String.fromCharCode(65 + j)),
      arabicProductTitle: 'عنوان المنتج العربي',
      sku: `SKU-${i}`,
      storeId: 'store-uae',
      updatedAt: '2026-01-30T02:17:39.082Z',
      activities: ['Walking', 'Running'],
      agegroup: ['Adults'],
      bodytype: ['Slim'],
      caretype: ['Spot clean only'],
      category: ['Footwear'],
      chaintype: ['undefined'],
      normalizedColor: 'red',
      gender: ['men'],
      discount: '0%',
      score: 0.535,
      productId: `prod-${i}`,
      productType: 'Shoes',
    }));

    const rawResult = JSON.stringify({ products, offers: [], automobiles: [] });
    expect(rawResult.length).toBeGreaterThan(
      DEFAULT_COMPACTION_POLICY.tool_results.structured_threshold,
    );

    const compressed = compressToolResult(rawResult, 'product_search', LEGACY_PRODUCT_POLICY);
    const parsed = JSON.parse(compressed);

    // Essential fields preserved
    expect(parsed.products[0].title).toBe('Product 0');
    expect(parsed.products[0].brand).toBe('TestBrand');
    expect(parsed.products[0].price).toBe('100');
    expect(parsed.products[0].color).toEqual(['red']);
    expect(parsed.products[0].product_image).toBeDefined();

    // Noise fields stripped
    expect(parsed.products[0].complementaryanalogous).toBeUndefined();
    expect(parsed.products[0].keyFeatures).toBeUndefined();
    expect(parsed.products[0].sku).toBeUndefined();
    expect(parsed.products[0].storeId).toBeUndefined();
    expect(parsed.products[0].updatedAt).toBeUndefined();
    expect(parsed.products[0].activities).toBeUndefined();
    expect(parsed.products[0].agegroup).toBeUndefined();
    expect(parsed.products[0].bodytype).toBeUndefined();
    expect(parsed.products[0].chaintype).toBeUndefined();

    // Description truncated
    expect(parsed.products[0].description.length).toBeLessThanOrEqual(203);

    // Overall size reduction
    expect(compressed.length).toBeLessThan(rawResult.length * 0.3);
  });

  it('handles non-product tool results gracefully', () => {
    const policyResult = JSON.stringify({
      success: true,
      answer: 'Return policy allows 14 days...',
    });
    expect(compressToolResult(policyResult)).toBe(policyResult);
  });

  it('progressively trims items when compression is insufficient', () => {
    const hugeProducts = Array.from({ length: 100 }, (_, i) => ({
      title: `Product ${i} - ${'Detail '.repeat(50)}`,
      brand: 'TestBrand',
      price: `${i * 100}`,
      description: 'Long description '.repeat(100),
    }));
    const raw = JSON.stringify({ products: hugeProducts });

    const compressed = compressToolResult(raw);
    // Result must be valid JSON (no broken sliced strings)
    const parsed = JSON.parse(compressed);
    if (parsed.products) {
      // Items trimmed to fit within limit
      expect(parsed.products.length).toBeLessThan(100);
    } else {
      // Falls back to summary object if trimming still exceeds limit
      expect(parsed._truncated).toBe(true);
    }
  });

  it('compresses offer arrays with essential offer fields', () => {
    const offers = Array.from({ length: 20 }, (_, i) => ({
      id: `offer-${i}`,
      title: `Offer ${i}`,
      brand: 'Brand',
      description: 'Great offer',
      discount: '20%',
      validUntil: '2026-12-31',
      category: 'Fashion',
      // Noise
      internalId: `int-${i}`,
      metadata: { source: 'api' },
      rawHtml: '<div>long html</div>'.repeat(100),
    }));

    const raw = JSON.stringify({ productOffers: offers });
    expect(raw.length).toBeGreaterThan(DEFAULT_COMPACTION_POLICY.tool_results.structured_threshold);

    const compressed = compressToolResult(raw, 'offer_search', LEGACY_PRODUCT_POLICY);
    const parsed = JSON.parse(compressed);
    expect(parsed.productOffers[0].title).toBe('Offer 0');
    expect(parsed.productOffers[0].internalId).toBeUndefined();
    expect(parsed.productOffers[0].rawHtml).toBeUndefined();
  });
});

describe('compressToolResult with policy', () => {
  it('uses tool-specific essential_fields from policy', () => {
    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      tool_results: {
        ...DEFAULT_COMPACTION_POLICY.tool_results,
        essential_fields: {
          custom_search: ['name', 'value'],
        },
      },
    };

    const items = Array.from({ length: 20 }, (_, i) => ({
      name: `Item ${i}`,
      value: i * 100,
      internalId: `int-${i}`,
      metadata: { source: 'api' },
      rawData: 'x'.repeat(500),
    }));

    const raw = JSON.stringify({ custom_search: items });
    expect(raw.length).toBeGreaterThan(policy.tool_results.structured_threshold);

    const compressed = compressToolResult(raw, 'custom_search', policy);
    const parsed = JSON.parse(compressed);
    expect(parsed.custom_search[0].name).toBe('Item 0');
    expect(parsed.custom_search[0].value).toBe(0);
    expect(parsed.custom_search[0].internalId).toBeUndefined();
    expect(parsed.custom_search[0].rawData).toBeUndefined();
  });

  it('preserves top-level readback metadata while compressing structured result arrays', () => {
    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      tool_results: {
        ...DEFAULT_COMPACTION_POLICY.tool_results,
        structured_threshold: 500,
        essential_fields: {
          kb_search: ['id', 'title', 'score', 'description'],
        },
      },
    };
    const raw = JSON.stringify({
      resultMetadata: {
        toolName: 'kb_search',
        toolCallId: 'call-123',
        compressionPolicyVersion: 'tool-results-v1',
        resultSchemaVersion: 1,
      },
      documents: Array.from({ length: 12 }, (_, index) => ({
        id: `doc-${index}`,
        title: `Document ${index}`,
        score: 1 - index / 100,
        description: 'Useful context '.repeat(40),
        rawHtml: '<p>noise</p>'.repeat(100),
      })),
    });

    const compressed = compressToolResult(raw, 'kb_search', policy);
    const parsed = JSON.parse(compressed);

    expect(parsed.resultMetadata).toEqual({
      toolName: 'kb_search',
      toolCallId: 'call-123',
      compressionPolicyVersion: 'tool-results-v1',
      resultSchemaVersion: 1,
    });
    expect(parsed.documents[0]).toMatchObject({
      id: 'doc-0',
      title: 'Document 0',
      score: 1,
    });
    expect(parsed.documents[0].rawHtml).toBeUndefined();
    expect(compressed.length).toBeLessThan(raw.length);
  });

  it('respects policy max_description_length', () => {
    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      tool_results: {
        ...DEFAULT_COMPACTION_POLICY.tool_results,
        max_description_length: 50,
        essential_fields: {
          my_tool: ['title', 'description'],
        },
      },
    };

    const items = Array.from({ length: 20 }, (_, i) => ({
      title: `Item ${i}`,
      description:
        'A very long description that exceeds the fifty character limit we set in policy',
      noise: 'x'.repeat(500),
    }));

    const raw = JSON.stringify({ my_tool: items });
    expect(raw.length).toBeGreaterThan(policy.tool_results.structured_threshold);

    const compressed = compressToolResult(raw, 'my_tool', policy);
    const parsed = JSON.parse(compressed);
    expect(parsed.my_tool[0].description.length).toBeLessThanOrEqual(53); // 50 + '...'
    expect(parsed.my_tool[0].noise).toBeUndefined();
  });

  it('falls back to char truncation when strategy is truncate', () => {
    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      tool_results: {
        ...DEFAULT_COMPACTION_POLICY.tool_results,
        strategy: 'truncate',
        structured_threshold: 100,
      },
    };

    const raw = JSON.stringify({ data: 'x'.repeat(200) });
    const compressed = compressToolResult(raw, 'some_tool', policy);
    // Should be a truncation summary, not structured compression
    expect(compressed).toContain('_truncated');
  });

  it('passes through when strategy is none', () => {
    const policy: CompactionPolicy = {
      ...DEFAULT_COMPACTION_POLICY,
      tool_results: {
        ...DEFAULT_COMPACTION_POLICY.tool_results,
        strategy: 'none',
      },
    };

    const raw = JSON.stringify({ data: 'x'.repeat(50_000) });
    const compressed = compressToolResult(raw, 'some_tool', policy);
    expect(compressed).toBe(raw);
  });
});

describe('summarizeToolResult', () => {
  it('summarizes large tool results via LLM', async () => {
    const mockLLM = vi.fn().mockResolvedValue('The tool returned 3 products under $100.');

    const serialized = JSON.stringify({
      products: Array.from({ length: 10 }, (_, i) => ({ id: i })),
    });
    const result = await summarizeToolResult(serialized, 'product_search', mockLLM);

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed._summarized).toBe(true);
    expect(parsed._toolName).toBe('product_search');
    expect(parsed._originalSize).toBe(serialized.length);
    expect(parsed.summary).toBe('The tool returned 3 products under $100.');

    // LLM called with default prompt
    expect(mockLLM).toHaveBeenCalledOnce();
    expect(mockLLM.mock.calls[0][0]).toBe(DEFAULT_SUMMARIZE_PROMPT);
    expect(mockLLM.mock.calls[0][1]).toContain('product_search');
  });

  it('uses custom prompt from DSL when provided', async () => {
    const customPrompt = 'Summarize focusing on pricing and availability only.';
    const mockLLM = vi.fn().mockResolvedValue('All items are in stock.');

    await summarizeToolResult('{"data": "test"}', 'inventory_check', mockLLM, customPrompt);

    expect(mockLLM.mock.calls[0][0]).toBe(customPrompt);
  });

  it('returns null when LLM returns empty string', async () => {
    const mockLLM = vi.fn().mockResolvedValue('');

    const result = await summarizeToolResult('{"data": "test"}', 'some_tool', mockLLM);
    expect(result).toBeNull();
  });

  it('returns null when LLM returns whitespace only', async () => {
    const mockLLM = vi.fn().mockResolvedValue('   \n  ');

    const result = await summarizeToolResult('{"data": "test"}', 'some_tool', mockLLM);
    expect(result).toBeNull();
  });

  it('propagates LLM errors (caller handles fallback)', async () => {
    const mockLLM = vi.fn().mockRejectedValue(new Error('LLM unavailable'));

    await expect(summarizeToolResult('{"data": "test"}', 'some_tool', mockLLM)).rejects.toThrow(
      'LLM unavailable',
    );
  });

  it('includes tool name in LLM prompt for context', async () => {
    const mockLLM = vi.fn().mockResolvedValue('Summary.');

    await summarizeToolResult('{"items": [1,2,3]}', 'flight_search', mockLLM);

    expect(mockLLM.mock.calls[0][1]).toContain('Tool "flight_search" returned:');
  });
});

describe('default compaction policy', () => {
  it('uses summarize strategy by default', () => {
    expect(DEFAULT_COMPACTION_POLICY.tool_results.strategy).toBe('summarize');
  });
});
