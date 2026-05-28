import { describe, it, expect } from 'vitest';
import { resolveToolImports } from '../parser/tool-import-resolver.js';

const HOTELS_TOOL_FILE = `TOOLS:
  base_url: "https://api.hotels.com/v1"
  auth: bearer
  timeout: 5000
  retry: 3

  search_hotels(destination: string, checkin: date) -> Hotel[]
    type: http
    endpoint: "/search"
    method: POST
    description: "Search available hotels"

  get_hotel(hotel_id: string) -> Hotel
    type: http
    endpoint: "/hotels/{hotel_id}"
    method: GET
    description: "Get hotel details"

  get_reviews(hotel_id: string) -> Review[]
    type: http
    endpoint: "/hotels/{hotel_id}/reviews"
    method: GET
`;

describe('resolveToolImports', () => {
  const fileReader = (path: string): string | null => {
    if (path.endsWith('hotels-api.tools.abl')) {
      return HOTELS_TOOL_FILE;
    }
    return null;
  };

  it('should resolve specific tools from a file', () => {
    const result = resolveToolImports(
      [{ source: './tools/hotels-api.tools.abl', toolNames: ['search_hotels', 'get_hotel'] }],
      '/project/agents',
      fileReader,
    );

    expect(result.errors).toHaveLength(0);
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe('search_hotels');
    expect(result.tools[1].name).toBe('get_hotel');
  });

  it('should merge file defaults into HTTP tool bindings', () => {
    const result = resolveToolImports(
      [{ source: './tools/hotels-api.tools.abl', toolNames: ['search_hotels'] }],
      '/project/agents',
      fileReader,
    );

    expect(result.errors).toHaveLength(0);
    const tool = result.tools[0];
    expect(tool.httpBinding).toBeDefined();
    expect(tool.httpBinding!.endpoint).toBe('https://api.hotels.com/v1/search');
    expect(tool.httpBinding!.auth).toBe('bearer');
    expect(tool.httpBinding!.timeout).toBe(5000);
    expect(tool.httpBinding!.retry).toBe(3);
  });

  it('should set sourceFile on imported tools', () => {
    const result = resolveToolImports(
      [{ source: './tools/hotels-api.tools.abl', toolNames: ['search_hotels'] }],
      '/project/agents',
      fileReader,
    );

    expect(result.tools[0].sourceFile).toBe('./tools/hotels-api.tools.abl');
  });

  it('should error on missing file', () => {
    const result = resolveToolImports(
      [{ source: './tools/nonexistent.tools.abl', toolNames: ['foo'] }],
      '/project/agents',
      fileReader,
    );

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('not found');
    expect(result.tools).toHaveLength(0);
  });

  it('should error on missing tool name', () => {
    const result = resolveToolImports(
      [{ source: './tools/hotels-api.tools.abl', toolNames: ['nonexistent_tool'] }],
      '/project/agents',
      fileReader,
    );

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('not found');
    expect(result.tools).toHaveLength(0);
  });

  it('should handle multiple imports from the same file', () => {
    const result = resolveToolImports(
      [
        { source: './tools/hotels-api.tools.abl', toolNames: ['search_hotels'] },
        { source: './tools/hotels-api.tools.abl', toolNames: ['get_reviews'] },
      ],
      '/project/agents',
      fileReader,
    );

    expect(result.errors).toHaveLength(0);
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe('search_hotels');
    expect(result.tools[1].name).toBe('get_reviews');
  });

  it('should handle empty imports list', () => {
    const result = resolveToolImports([], '/project/agents', fileReader);
    expect(result.errors).toHaveLength(0);
    expect(result.tools).toHaveLength(0);
  });
});
