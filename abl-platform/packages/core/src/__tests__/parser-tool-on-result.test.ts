/**
 * Parser Tests for ON_RESULT / ON_ERROR / STORE_RESULT
 *
 * Validates that tool-file-parser correctly parses the new tool event
 * mapping properties from both .tools.abl files and inline agent DSL.
 */

import { describe, it, expect } from 'vitest';
import { parseToolFile } from '../parser/tool-file-parser.js';

describe('parseToolFile — ON_RESULT / ON_ERROR / STORE_RESULT', () => {
  it('parses STORE_RESULT: false', () => {
    const content = `TOOLS:
  search_hotels(destination: string) -> Hotel[]
    type: http
    endpoint: "/search"
    method: POST
    store_result: false
`;
    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    const tool = result.document!.tools[0];
    expect(tool.storeResult).toBe(false);
  });

  it('parses STORE_RESULT: true', () => {
    const content = `TOOLS:
  search_hotels(destination: string) -> Hotel[]
    type: http
    endpoint: "/search"
    store_result: true
`;
    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    const tool = result.document!.tools[0];
    expect(tool.storeResult).toBe(true);
  });

  it('parses ON_RESULT with SET block', () => {
    const content = `TOOLS:
  search_hotels(destination: string) -> Hotel[]
    type: http
    endpoint: "/search"
    method: POST
    store_result: false
    ON_RESULT:
      SET:
        hotel_count = result.count
        cheapest_price = result.hotels.0.price
        search_status = 'completed'
`;
    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    const tool = result.document!.tools[0];
    expect(tool.storeResult).toBe(false);
    expect(tool.onResult).toBeDefined();
    expect(tool.onResult!.set).toEqual({
      hotel_count: 'result.count',
      cheapest_price: 'result.hotels.0.price',
      search_status: "'completed'",
    });
  });

  it('parses ON_ERROR with SET block', () => {
    const content = `TOOLS:
  search_hotels(destination: string) -> Hotel[]
    type: http
    endpoint: "/search"
    method: POST
    ON_ERROR:
      SET:
        search_status = 'failed'
        error_message = result.error
`;
    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    const tool = result.document!.tools[0];
    expect(tool.onError).toBeDefined();
    expect(tool.onError!.set).toEqual({
      search_status: "'failed'",
      error_message: 'result.error',
    });
  });

  it('parses both ON_RESULT and ON_ERROR on same tool', () => {
    const content = `TOOLS:
  transfer_funds(amount: number) -> TransferResult
    type: http
    endpoint: "/transfer"
    method: POST
    store_result: false
    ON_RESULT:
      SET:
        transfer_id = result.id
        transfer_status = 'success'
    ON_ERROR:
      SET:
        transfer_status = 'failed'
`;
    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    const tool = result.document!.tools[0];
    expect(tool.storeResult).toBe(false);
    expect(tool.onResult).toBeDefined();
    expect(tool.onResult!.set).toEqual({
      transfer_id: 'result.id',
      transfer_status: "'success'",
    });
    expect(tool.onError).toBeDefined();
    expect(tool.onError!.set).toEqual({
      transfer_status: "'failed'",
    });
  });

  it('defaults storeResult to undefined when not specified', () => {
    const content = `TOOLS:
  simple_tool(x: string) -> Result
    type: http
    endpoint: "/simple"
`;
    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    const tool = result.document!.tools[0];
    expect(tool.storeResult).toBeUndefined();
    expect(tool.onResult).toBeUndefined();
    expect(tool.onError).toBeUndefined();
  });

  it('parses tool compaction hints', () => {
    const content = `TOOLS:
  search_hotels(destination: string) -> Hotel[]
    type: http
    endpoint: "/search"
    compaction:
      essential_fields: [name, price, availability]
      max_description_length: 120
`;
    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.tools[0].compaction).toEqual({
      essential_fields: ['name', 'price', 'availability'],
      max_description_length: 120,
    });
  });

  it('parses ON_RESULT alongside other properties', () => {
    const content = `TOOLS:
  base_url: "https://api.example.com"
  auth: bearer

  search(query: string) -> Result[]
    type: http
    endpoint: "/search"
    method: POST
    timeout: 5000
    description: "Search items"
    ON_RESULT:
      SET:
        result_count = result.total
`;
    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    const tool = result.document!.tools[0];
    expect(tool.description).toBe('Search items');
    expect(tool.httpBinding?.endpoint).toBe('/search');
    expect(tool.httpBinding?.timeout).toBe(5000);
    expect(tool.onResult).toBeDefined();
    expect(tool.onResult!.set).toEqual({
      result_count: 'result.total',
    });
  });
});
