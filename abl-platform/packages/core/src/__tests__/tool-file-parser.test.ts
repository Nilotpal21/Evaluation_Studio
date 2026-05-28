import { describe, it, expect } from 'vitest';
import { parseToolFile } from '../parser/tool-file-parser.js';

describe('parseToolFile', () => {
  it('should parse a basic tool file with defaults', () => {
    const content = `TOOLS:
  base_url: "https://api.example.com/v1"
  auth: bearer
  timeout: 5000
  retry: 3

  search(query: string) -> Result[]
    type: http
    endpoint: "/search"
    method: POST
    description: "Search items"
`;

    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    expect(result.document).not.toBeNull();
    expect(result.document!.defaults.baseUrl).toBe('https://api.example.com/v1');
    expect(result.document!.defaults.auth).toBe('bearer');
    expect(result.document!.defaults.timeout).toBe(5000);
    expect(result.document!.defaults.retry).toBe(3);
    expect(result.document!.tools).toHaveLength(1);

    const tool = result.document!.tools[0];
    expect(tool.name).toBe('search');
    expect(tool.type).toBe('http');
    expect(tool.description).toBe('Search items');
    expect(tool.httpBinding).toBeDefined();
    expect(tool.httpBinding!.endpoint).toBe('/search');
    expect(tool.httpBinding!.method).toBe('POST');
    expect(tool.parameters).toHaveLength(1);
    expect(tool.parameters[0].name).toBe('query');
    expect(tool.parameters[0].type).toBe('string');
    expect(tool.returns.type).toBe('array');
  });

  it('should parse multiple tools', () => {
    const content = `TOOLS:
  base_url: "https://api.hotels.com/v1"
  auth: bearer

  search_hotels(destination: string, checkin: date) -> Hotel[]
    type: http
    endpoint: "/search"
    method: POST

  get_hotel(hotel_id: string) -> Hotel
    type: http
    endpoint: "/hotels/{hotel_id}"
    method: GET
`;

    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.tools).toHaveLength(2);
    expect(result.document!.tools[0].name).toBe('search_hotels');
    expect(result.document!.tools[1].name).toBe('get_hotel');
    expect(result.document!.tools[1].httpBinding!.endpoint).toBe('/hotels/{hotel_id}');
    expect(result.document!.tools[1].httpBinding!.method).toBe('GET');
  });

  it('should parse MCP tool binding', () => {
    const content = `TOOLS:
  get_weather(location: string) -> {temp: number, conditions: string}
    type: mcp
    server: "weather-service"
    tool: "get_current_weather"
    description: "Get current weather"
`;

    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    const tool = result.document!.tools[0];
    expect(tool.type).toBe('mcp');
    expect(tool.mcpBinding).toBeDefined();
    expect(tool.mcpBinding!.server).toBe('weather-service');
    expect(tool.mcpBinding!.tool).toBe('get_current_weather');
  });

  it('should parse lambda tool binding', () => {
    const content = `TOOLS:
  process_doc(url: string) -> {summary: string}
    type: lambda
    function: "doc-processor"
    runtime: "nodejs20"
    timeout: 30000
    description: "Process document"
`;

    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    const tool = result.document!.tools[0];
    expect(tool.type).toBe('lambda');
    expect(tool.lambdaBinding).toBeDefined();
    expect(tool.lambdaBinding!.function).toBe('doc-processor');
    expect(tool.lambdaBinding!.runtime).toBe('nodejs20');
    expect(tool.lambdaBinding!.timeout).toBe(30000);
  });

  it('should parse sandbox tool binding', () => {
    const content = `TOOLS:
  calculate_risk(data: object) -> {score: number}
    type: sandbox
    runtime: "javascript"
    code: "calculateRisk"
    timeout: 5000
    memory_mb: 128
`;

    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    const tool = result.document!.tools[0];
    expect(tool.type).toBe('sandbox');
    expect(tool.sandboxBinding).toBeDefined();
    expect(tool.sandboxBinding!.runtime).toBe('javascript');
    expect(tool.sandboxBinding!.code).toBe('calculateRisk');
    expect(tool.sandboxBinding!.timeout).toBe(5000);
    expect(tool.sandboxBinding!.memoryMb).toBe(128);
  });

  it('should parse contract-only tool (no type)', () => {
    const content = `TOOLS:
  format_results(hotels: Hotel[]) -> string
    description: "Format hotel results for display"
`;

    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    const tool = result.document!.tools[0];
    expect(tool.type).toBeUndefined();
    expect(tool.httpBinding).toBeUndefined();
    expect(tool.mcpBinding).toBeUndefined();
    expect(tool.description).toBe('Format hotel results for display');
  });

  it('should parse HTTP tool with auth and retry', () => {
    const content = `TOOLS:
  verify_email(email: string) -> {valid: boolean}
    type: http
    endpoint: "https://api.verify.com/check"
    method: POST
    auth: api_key
    timeout: 3000
    retry: 2
`;

    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    const tool = result.document!.tools[0];
    expect(tool.httpBinding!.auth).toBe('api_key');
    expect(tool.httpBinding!.timeout).toBe(3000);
    expect(tool.httpBinding!.retry).toBe(2);
  });

  it('should return empty defaults for file without defaults', () => {
    const content = `TOOLS:
  hello(name: string) -> string
    description: "Say hello"
`;

    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    expect(result.document!.defaults).toEqual({});
  });

  it('should error on missing TOOLS section', () => {
    const content = `AGENT: Foo
GOAL: "Test agent"`;

    const result = parseToolFile(content);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should parse tool hints alongside binding properties', () => {
    const content = `TOOLS:
  cached_search(q: string) -> Result[]
    type: http
    endpoint: "/search"
    method: GET
    cacheable: true
    latency: fast
`;

    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    const tool = result.document!.tools[0];
    expect(tool.type).toBe('http');
    expect(tool.hints).toBeDefined();
    expect(tool.hints!.cacheable).toBe(true);
    expect(tool.hints!.latency).toBe('fast');
  });

  it('parses query_params nested block into httpBinding', () => {
    const content = `TOOLS:
  search_api(q: string) -> object
    type: http
    endpoint: "https://api.example.com/search"
    method: GET
    auth: api_key
    query_params:
      api_key: "{{secrets.API_KEY}}"
      format: json`;

    const { document } = parseToolFile(content);
    expect(document?.tools).toHaveLength(1);
    expect(document?.tools[0].httpBinding?.queryParams).toEqual({
      api_key: '{{secrets.API_KEY}}',
      format: 'json',
    });
  });

  it('parses parameters: block with nested items for object[] type', () => {
    const content = `TOOLS:
  product_search(queries: object[]) -> {results: object[]}
    type: sandbox
    runtime: javascript
    description: "Search for products"
    parameters:
      queries:
        type: object[]
        description: "Array of search queries"
        required: true
        items:
          query:
            type: string
            description: "Search text"
            required: true
          namespace:
            type: string
            description: "Target namespace"
            required: true
          filter:
            type: object
            description: "Optional filters"
            required: false

    code: |
      return {};
`;
    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    const tool = result.document!.tools[0];

    const queriesParam = tool.parameters.find((p) => p.name === 'queries');
    expect(queriesParam).toBeDefined();
    expect(queriesParam!.type).toBe('object[]');
    expect(queriesParam!.description).toBe('Array of search queries');
    expect(queriesParam!.items).toBeDefined();
    expect(queriesParam!.items!.properties).toHaveLength(3);

    const queryField = queriesParam!.items!.properties!.find((p) => p.name === 'query');
    expect(queryField).toEqual({
      name: 'query',
      type: 'string',
      description: 'Search text',
      required: true,
    });

    const filterField = queriesParam!.items!.properties!.find((p) => p.name === 'filter');
    expect(filterField!.required).toBe(false);
  });

  it('parses parameters: block with flat object properties', () => {
    const content = `TOOLS:
  get_user(filters: object) -> {user: object}
    type: http
    endpoint: "https://api.example.com/users"
    method: GET
    parameters:
      filters:
        type: object
        description: "Filter criteria"
        required: true
        properties:
          name:
            type: string
            description: "User name"
            required: false
          age:
            type: integer
            description: "User age"
            required: false

    code: |
      return {};
`;
    const result = parseToolFile(content);
    expect(result.errors).toHaveLength(0);
    const tool = result.document!.tools[0];

    const filtersParam = tool.parameters.find((p) => p.name === 'filters');
    expect(filtersParam).toBeDefined();
    expect(filtersParam!.properties).toHaveLength(2);
    expect(filtersParam!.properties![0]).toEqual({
      name: 'name',
      type: 'string',
      description: 'User name',
      required: false,
    });
  });

  it('parses body pipe block into httpBinding', () => {
    const content = `TOOLS:
  create_user(name: string) -> object
    type: http
    endpoint: "https://api.example.com/users"
    method: POST
    auth: bearer
    body: |
      {
        "name": "{{input.name}}",
        "source": "platform"
      }`;

    const { document } = parseToolFile(content);
    expect(document?.tools).toHaveLength(1);
    expect(document?.tools[0].httpBinding?.bodyTemplate).toContain('{{input.name}}');
    expect(document?.tools[0].httpBinding?.bodyTemplate).toContain('"source": "platform"');
  });

  it('preserves urlencoded body type on HTTP tools', () => {
    const content = `TOOLS:
  exchange_token(code: string) -> object
    type: http
    endpoint: "https://login.microsoftonline.com/oauth2/v2.0/token"
    method: POST
    body_type: form
    body: |
      grant_type=authorization_code&code={{input.code}}`;

    const { document } = parseToolFile(content);
    expect(document?.tools).toHaveLength(1);
    expect(document?.tools[0].httpBinding?.bodyType).toBe('form');
  });
});
