import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

describe('GET /api/openapi/spec.json', () => {
  it('does not advertise client-mutable project agent paths', async () => {
    const { GET } = await import('@/app/api/openapi/spec.json/route');

    const response = await GET(
      new NextRequest('http://localhost:3000/api/openapi/spec.json', {
        headers: { host: 'localhost:3000' },
      }),
    );

    expect(response.status).toBe(200);
    const spec = (await response.json()) as {
      paths: Record<
        string,
        Record<string, { requestBody?: { content?: Record<string, { schema?: unknown }> } }>
      >;
    };

    const createAgentSchema =
      spec.paths['/api/projects/{id}/agents'].post.requestBody?.content?.['application/json']
        ?.schema;
    const updateAgentSchema =
      spec.paths['/api/projects/{id}/agents/{agentId}'].patch.requestBody?.content?.[
        'application/json'
      ]?.schema;

    expect(JSON.stringify(createAgentSchema)).not.toContain('agentPath');
    expect(JSON.stringify(updateAgentSchema)).not.toContain('agentPath');
  });

  it('publishes canonical agent name constraints for generated clients', async () => {
    const { GET } = await import('@/app/api/openapi/spec.json/route');

    const response = await GET(
      new NextRequest('http://localhost:3000/api/openapi/spec.json', {
        headers: { host: 'localhost:3000' },
      }),
    );

    expect(response.status).toBe(200);
    const spec = (await response.json()) as {
      paths: Record<
        string,
        Record<
          string,
          { requestBody?: { content?: Record<string, { schema?: { properties?: unknown } }> } }
        >
      >;
    };

    const createAgentSchema = spec.paths['/api/projects/{id}/agents'].post.requestBody?.content?.[
      'application/json'
    ]?.schema as { properties?: { name?: Record<string, unknown> } };
    const updateAgentSchema = spec.paths['/api/projects/{id}/agents/{agentId}'].patch.requestBody
      ?.content?.['application/json']?.schema as {
      properties?: { name?: Record<string, unknown> };
    };

    expect(createAgentSchema.properties?.name).toMatchObject({
      maxLength: 100,
      pattern: '^[a-zA-Z][a-zA-Z0-9_]*$',
    });
    expect(updateAgentSchema.properties?.name).toMatchObject({
      maxLength: 100,
      pattern: '^[a-zA-Z][a-zA-Z0-9_]*$',
    });
  });
});
