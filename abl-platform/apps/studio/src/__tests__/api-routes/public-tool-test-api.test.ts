import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockEnsureDb,
  mockCheckRateLimit,
  mockGetClientIp,
  mockToolTestEndpointFindOne,
  mockToolTestEndpointFindOneAndUpdate,
  mockToolTestEndpointCreate,
  mockProjectToolFindOne,
  mockCreateLogger,
} = vi.hoisted(() => ({
  mockEnsureDb: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockGetClientIp: vi.fn(),
  mockToolTestEndpointFindOne: vi.fn(),
  mockToolTestEndpointFindOneAndUpdate: vi.fn(),
  mockToolTestEndpointCreate: vi.fn(),
  mockProjectToolFindOne: vi.fn(),
  mockCreateLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: (...args: unknown[]) => mockEnsureDb(...args),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock('@/lib/get-client-ip', () => ({
  getClientIp: (...args: unknown[]) => mockGetClientIp(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: (...args: unknown[]) => mockCreateLogger(...args),
}));

vi.mock('@agent-platform/database/models', () => ({
  ToolTestEndpoint: {
    findOne: (...args: unknown[]) => mockToolTestEndpointFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockToolTestEndpointFindOneAndUpdate(...args),
    create: (...args: unknown[]) => mockToolTestEndpointCreate(...args),
  },
  ProjectTool: {
    findOne: (...args: unknown[]) => mockProjectToolFindOne(...args),
  },
}));

import { POST as invokeToolTest } from '@/app/api/public/tool-test/[capability]/route';
import { GET as getToolTestSpec } from '@/app/api/public/tool-test/specs/[capability]/openapi.json/route';
import {
  buildToolTestEndpointUrls,
  getToolTestEndpointFixture,
  hashCapability,
  resolveToolTestPublicOrigin,
  updateToolTestEndpointFixture,
} from '@/lib/tool-test-endpoint-service';

interface TestEndpointRecord {
  _id: string;
  tenantId: string;
  projectId: string;
  projectToolId: string;
  toolName: string;
  invokeCapability: string;
  invokeCapabilityHash: string;
  specCapability: string;
  specCapabilityHash: string;
  status: string;
  responseMode: string;
  staticResponse: Record<string, unknown> | null;
  sampleInput: Record<string, unknown> | null;
  createdBy: string;
  lastEditedBy: string | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

interface TestProjectToolRecord {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description: string;
  dslContent: string;
}

function makeQueryResult<T>(value: T) {
  return {
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(value),
  };
}

function makeEndpoint(overrides: Partial<TestEndpointRecord> = {}): TestEndpointRecord {
  const invokeCapability = 'tti_valid-capability';
  const specCapability = 'tts_valid-capability';

  return {
    _id: 'endpoint-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    projectToolId: 'tool-1',
    toolName: 'get_customer',
    invokeCapability,
    invokeCapabilityHash: hashCapability(invokeCapability),
    specCapability,
    specCapabilityHash: hashCapability(specCapability),
    status: 'active',
    responseMode: 'static_json',
    staticResponse: {
      id: 'cust_123',
      name: 'Jane Doe',
      status: 'active',
    },
    sampleInput: {
      customer_id: 'cust_123',
    },
    createdBy: 'user-1',
    lastEditedBy: null,
    _v: 1,
    createdAt: new Date('2026-04-21T00:00:00.000Z'),
    updatedAt: new Date('2026-04-21T00:00:00.000Z'),
    ...overrides,
  };
}

function makeTool(overrides: Partial<TestProjectToolRecord> = {}): TestProjectToolRecord {
  return {
    _id: 'tool-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    name: 'get_customer',
    description: 'Lookup a customer by ID',
    dslContent: [
      'get_customer(customer_id: string) -> object',
      '  description: "Lookup a customer by ID"',
      '  type: http',
      '  endpoint: "https://studio.example.com/api/public/tool-test/tti_valid-capability"',
      '  method: POST',
      '  params:',
      '    customer_id:',
      '      description: "The customer identifier"',
    ].join('\n'),
    ...overrides,
  };
}

function makePostRequest(capability: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000/api/public/tool-test/${capability}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:3000',
    },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(capability: string): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/public/tool-test/specs/${capability}/openapi.json`,
    {
      method: 'GET',
    },
  );
}

describe('public tool test API routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXTAUTH_URL;

    mockEnsureDb.mockResolvedValue(undefined);
    mockCheckRateLimit.mockResolvedValue({ allowed: true });
    mockGetClientIp.mockReturnValue('127.0.0.1');
    mockToolTestEndpointFindOne.mockReturnValue(makeQueryResult(null));
    mockToolTestEndpointFindOneAndUpdate.mockReturnValue(makeQueryResult(null));
    mockToolTestEndpointCreate.mockResolvedValue({ toObject: () => makeEndpoint() });
    mockProjectToolFindOne.mockReturnValue(makeQueryResult(null));
  });

  it('hashes capabilities deterministically and builds public URLs from NEXT_PUBLIC_APP_URL', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://studio.example.com/app';
    process.env.NEXTAUTH_URL = 'https://fallback.example.com';

    expect(hashCapability('tti_valid-capability')).toBe(hashCapability('tti_valid-capability'));
    expect(resolveToolTestPublicOrigin()).toBe('https://studio.example.com');
    expect(
      buildToolTestEndpointUrls({
        invokeCapability: 'tti_valid-capability',
        specCapability: 'tts_valid-capability',
      }),
    ).toEqual({
      invokeUrl: 'https://studio.example.com/api/public/tool-test/tti_valid-capability',
      specUrl:
        'https://studio.example.com/api/public/tool-test/specs/tts_valid-capability/openapi.json',
    });
  });

  it('returns deterministic JSON for a valid invoke capability', async () => {
    const endpoint = makeEndpoint();
    const tool = makeTool();

    mockToolTestEndpointFindOne.mockReturnValueOnce(makeQueryResult(endpoint));
    mockProjectToolFindOne.mockReturnValueOnce(makeQueryResult(tool));

    const response = await invokeToolTest(
      makePostRequest(endpoint.invokeCapability, { customer_id: 'cust_123' }),
      {
        params: Promise.resolve({ capability: endpoint.invokeCapability }),
      },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual(endpoint.staticResponse);
    expect(mockToolTestEndpointFindOne).toHaveBeenCalledWith({
      invokeCapabilityHash: hashCapability(endpoint.invokeCapability),
      status: 'active',
    });
    expect(mockProjectToolFindOne).toHaveBeenCalledWith({
      _id: endpoint.projectToolId,
      tenantId: endpoint.tenantId,
      projectId: endpoint.projectId,
    });
  });

  it('loads a project-scoped editable fixture by tool id', async () => {
    const endpoint = makeEndpoint();
    mockToolTestEndpointFindOne.mockReturnValueOnce(makeQueryResult(endpoint));

    const fixture = await getToolTestEndpointFixture({
      tenantId: endpoint.tenantId,
      projectId: endpoint.projectId,
      projectToolId: endpoint.projectToolId,
    });

    expect(fixture).toMatchObject({
      endpointId: endpoint._id,
      projectToolId: endpoint.projectToolId,
      toolName: endpoint.toolName,
      staticResponse: endpoint.staticResponse,
      sampleInput: endpoint.sampleInput,
      version: endpoint._v,
    });
    expect(fixture?.urls).toEqual(
      buildToolTestEndpointUrls({
        invokeCapability: endpoint.invokeCapability,
        specCapability: endpoint.specCapability,
      }),
    );
    expect(mockToolTestEndpointFindOne).toHaveBeenCalledWith({
      tenantId: endpoint.tenantId,
      projectId: endpoint.projectId,
      projectToolId: endpoint.projectToolId,
    });
  });

  it('updates static response without rotating public capabilities', async () => {
    const endpoint = makeEndpoint();
    const tool = makeTool();
    const staticResponse = {
      status: 'delayed',
      promised_delivery_date: '2026-05-20',
    };
    const updatedEndpoint = makeEndpoint({
      staticResponse,
      lastEditedBy: 'user-2',
      _v: 2,
    });

    mockProjectToolFindOne.mockReturnValueOnce(makeQueryResult(tool));
    mockToolTestEndpointFindOne
      .mockReturnValueOnce(makeQueryResult(endpoint))
      .mockReturnValueOnce(makeQueryResult(endpoint));
    mockToolTestEndpointFindOneAndUpdate.mockReturnValueOnce(makeQueryResult(updatedEndpoint));

    const fixture = await updateToolTestEndpointFixture({
      tenantId: endpoint.tenantId,
      projectId: endpoint.projectId,
      projectToolId: endpoint.projectToolId,
      staticResponse,
      actorId: 'user-2',
    });

    expect(fixture?.staticResponse).toEqual(staticResponse);
    expect(fixture?.version).toBe(2);
    expect(mockProjectToolFindOne).toHaveBeenCalledWith({
      _id: endpoint.projectToolId,
      tenantId: endpoint.tenantId,
      projectId: endpoint.projectId,
    });
    expect(mockToolTestEndpointFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: endpoint._id,
        tenantId: endpoint.tenantId,
        projectId: endpoint.projectId,
      },
      {
        $set: expect.objectContaining({
          invokeCapability: endpoint.invokeCapability,
          specCapability: endpoint.specCapability,
          staticResponse,
          sampleInput: endpoint.sampleInput,
          lastEditedBy: 'user-2',
        }),
      },
      { new: true },
    );
  });

  it('serves the edited static response through the existing public invoke capability', async () => {
    const endpoint = makeEndpoint();
    const tool = makeTool();
    const staticResponse = {
      status: 'delayed',
      promised_delivery_date: '2026-05-20',
      customer_message: 'Your replacement is queued.',
    };
    const updatedEndpoint = makeEndpoint({
      staticResponse,
      lastEditedBy: 'user-2',
      _v: 2,
    });

    mockProjectToolFindOne
      .mockReturnValueOnce(makeQueryResult(tool))
      .mockReturnValueOnce(makeQueryResult(tool));
    mockToolTestEndpointFindOne
      .mockReturnValueOnce(makeQueryResult(endpoint))
      .mockReturnValueOnce(makeQueryResult(endpoint))
      .mockReturnValueOnce(makeQueryResult(updatedEndpoint));
    mockToolTestEndpointFindOneAndUpdate.mockReturnValueOnce(makeQueryResult(updatedEndpoint));

    const fixture = await updateToolTestEndpointFixture({
      tenantId: endpoint.tenantId,
      projectId: endpoint.projectId,
      projectToolId: endpoint.projectToolId,
      staticResponse,
      actorId: 'user-2',
    });
    const response = await invokeToolTest(
      makePostRequest(endpoint.invokeCapability, { customer_id: 'cust_123' }),
      {
        params: Promise.resolve({ capability: endpoint.invokeCapability }),
      },
    );
    const payload = await response.json();

    expect(fixture?.urls.invokeUrl).toContain(`/api/public/tool-test/${endpoint.invokeCapability}`);
    expect(response.status).toBe(200);
    expect(payload).toEqual(staticResponse);
    expect(mockToolTestEndpointFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: endpoint._id,
        tenantId: endpoint.tenantId,
        projectId: endpoint.projectId,
      },
      {
        $set: expect.objectContaining({
          invokeCapability: endpoint.invokeCapability,
          specCapability: endpoint.specCapability,
          staticResponse,
        }),
      },
      { new: true },
    );
  });

  it('creates a missing editable fixture with a null sample input', async () => {
    const tool = makeTool();
    const staticResponse = {
      status: 'queued',
    };
    const createdEndpoint = makeEndpoint({
      staticResponse,
      sampleInput: null,
      createdBy: 'user-2',
      lastEditedBy: 'user-2',
      _v: 1,
    });

    mockProjectToolFindOne.mockReturnValueOnce(makeQueryResult(tool));
    mockToolTestEndpointCreate.mockResolvedValueOnce({ toObject: () => createdEndpoint });

    const fixture = await updateToolTestEndpointFixture({
      tenantId: tool.tenantId,
      projectId: tool.projectId,
      projectToolId: tool._id,
      staticResponse,
      sampleInput: null,
      actorId: 'user-2',
    });

    expect(fixture).toMatchObject({
      endpointId: createdEndpoint._id,
      staticResponse,
      sampleInput: null,
      version: 1,
    });
    expect(mockToolTestEndpointCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: tool.tenantId,
        projectId: tool.projectId,
        projectToolId: tool._id,
        toolName: tool.name,
        status: 'active',
        responseMode: 'static_json',
        staticResponse,
        sampleInput: null,
        createdBy: 'user-2',
        lastEditedBy: 'user-2',
        _v: 1,
      }),
    );
    expect(mockToolTestEndpointCreate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        invokeCapability: expect.stringMatching(/^tti_/),
        specCapability: expect.stringMatching(/^tts_/),
        invokeCapabilityHash: expect.any(String),
        specCapabilityHash: expect.any(String),
      }),
    );
    expect(mockToolTestEndpointFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('clears an existing sample input to null without rotating public capabilities', async () => {
    const endpoint = makeEndpoint();
    const tool = makeTool();
    const updatedEndpoint = makeEndpoint({
      sampleInput: null,
      lastEditedBy: 'user-2',
      _v: 2,
    });

    mockProjectToolFindOne.mockReturnValueOnce(makeQueryResult(tool));
    mockToolTestEndpointFindOne
      .mockReturnValueOnce(makeQueryResult(endpoint))
      .mockReturnValueOnce(makeQueryResult(endpoint));
    mockToolTestEndpointFindOneAndUpdate.mockReturnValueOnce(makeQueryResult(updatedEndpoint));

    const fixture = await updateToolTestEndpointFixture({
      tenantId: endpoint.tenantId,
      projectId: endpoint.projectId,
      projectToolId: endpoint.projectToolId,
      sampleInput: null,
      actorId: 'user-2',
    });

    expect(fixture?.sampleInput).toBeNull();
    expect(mockToolTestEndpointFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: endpoint._id,
        tenantId: endpoint.tenantId,
        projectId: endpoint.projectId,
      },
      {
        $set: expect.objectContaining({
          invokeCapability: endpoint.invokeCapability,
          specCapability: endpoint.specCapability,
          staticResponse: endpoint.staticResponse,
          sampleInput: null,
          lastEditedBy: 'user-2',
        }),
      },
      { new: true },
    );
  });

  it('updates an existing static response to null without falling back to the prior value', async () => {
    const endpoint = makeEndpoint();
    const tool = makeTool();
    const updatedEndpoint = makeEndpoint({
      staticResponse: null,
      lastEditedBy: 'user-2',
      _v: 2,
    });

    mockProjectToolFindOne.mockReturnValueOnce(makeQueryResult(tool));
    mockToolTestEndpointFindOne
      .mockReturnValueOnce(makeQueryResult(endpoint))
      .mockReturnValueOnce(makeQueryResult(endpoint));
    mockToolTestEndpointFindOneAndUpdate.mockReturnValueOnce(makeQueryResult(updatedEndpoint));

    const fixture = await updateToolTestEndpointFixture({
      tenantId: endpoint.tenantId,
      projectId: endpoint.projectId,
      projectToolId: endpoint.projectToolId,
      staticResponse: null,
      actorId: 'user-2',
    });

    expect(fixture?.staticResponse).toBeNull();
    expect(mockToolTestEndpointFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: endpoint._id,
        tenantId: endpoint.tenantId,
        projectId: endpoint.projectId,
      },
      {
        $set: expect.objectContaining({
          invokeCapability: endpoint.invokeCapability,
          specCapability: endpoint.specCapability,
          staticResponse: null,
          sampleInput: endpoint.sampleInput,
          lastEditedBy: 'user-2',
        }),
      },
      { new: true },
    );
  });

  it('serves an explicit null static response through public invoke', async () => {
    const endpoint = makeEndpoint({ staticResponse: null });
    const tool = makeTool();

    mockToolTestEndpointFindOne.mockReturnValueOnce(makeQueryResult(endpoint));
    mockProjectToolFindOne.mockReturnValueOnce(makeQueryResult(tool));

    const response = await invokeToolTest(
      makePostRequest(endpoint.invokeCapability, { customer_id: 'cust_123' }),
      {
        params: Promise.resolve({ capability: endpoint.invokeCapability }),
      },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toBeNull();
  });

  it('returns a tool-scoped OpenAPI document for a valid spec capability', async () => {
    const endpoint = makeEndpoint();
    const tool = makeTool();

    mockToolTestEndpointFindOne.mockReturnValueOnce(makeQueryResult(endpoint));
    mockProjectToolFindOne.mockReturnValueOnce(makeQueryResult(tool));

    const response = await getToolTestSpec(makeGetRequest(endpoint.specCapability), {
      params: Promise.resolve({ capability: endpoint.specCapability }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.openapi).toBe('3.1.0');
    expect(payload.info.title).toBe('get_customer Test API');
    expect(payload.paths['/api/public/tool-test/tti_valid-capability'].post.operationId).toBe(
      'get_customer',
    );
    expect(
      payload.paths['/api/public/tool-test/tti_valid-capability'].post.requestBody.content[
        'application/json'
      ].example,
    ).toEqual(endpoint.sampleInput);
  });

  it('returns identical sanitized 404 envelopes for invalid, disabled, and random capabilities', async () => {
    const invalidResponse = await invokeToolTest(
      makePostRequest('tti_invalid-capability', { customer_id: 'cust_123' }),
      {
        params: Promise.resolve({ capability: 'tti_invalid-capability' }),
      },
    );
    const disabledResponse = await invokeToolTest(
      makePostRequest('tti_disabled-capability', { customer_id: 'cust_123' }),
      {
        params: Promise.resolve({ capability: 'tti_disabled-capability' }),
      },
    );
    const randomResponse = await getToolTestSpec(makeGetRequest('tts_random-capability'), {
      params: Promise.resolve({ capability: 'tts_random-capability' }),
    });

    const invalidPayload = await invalidResponse.json();
    const disabledPayload = await disabledResponse.json();
    const randomPayload = await randomResponse.json();

    expect(invalidResponse.status).toBe(404);
    expect(disabledResponse.status).toBe(404);
    expect(randomResponse.status).toBe(404);
    expect(invalidPayload).toEqual(disabledPayload);
    expect(disabledPayload).toEqual(randomPayload);
  });

  it('returns 400 when the request body does not satisfy the tool contract', async () => {
    const endpoint = makeEndpoint();
    const tool = makeTool();

    mockToolTestEndpointFindOne.mockReturnValueOnce(makeQueryResult(endpoint));
    mockProjectToolFindOne.mockReturnValueOnce(makeQueryResult(tool));

    const response = await invokeToolTest(makePostRequest(endpoint.invokeCapability, {}), {
      params: Promise.resolve({ capability: endpoint.invokeCapability }),
    });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      success: false,
      errors: [
        {
          msg: 'customer_id is required',
          code: 'VALIDATION_ERROR',
        },
      ],
    });
  });

  it('returns 429 and retry-after when public routes are rate limited', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 17 });

    const response = await getToolTestSpec(makeGetRequest('tts_valid-capability'), {
      params: Promise.resolve({ capability: 'tts_valid-capability' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('17');
    expect(payload).toEqual({
      success: false,
      errors: [
        {
          msg: 'Too many requests. Please try again later.',
          code: 'RATE_LIMITED',
        },
      ],
    });
  });
});
