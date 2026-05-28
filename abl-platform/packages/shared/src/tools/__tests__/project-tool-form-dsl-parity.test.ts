import { describe, expect, it } from 'vitest';
import type { ProjectToolFormData } from '../../types/project-tool-form.js';
import { parseDslToToolForm } from '../parse-dsl-to-tool-form.js';
import { serializeToolFormToDsl } from '../serialize-tool-form-to-dsl.js';

describe('project tool dynamic form DSL parity', () => {
  it('round-trips dynamic form schema, enum/default metadata, and runtime fields through DSL', () => {
    const form: ProjectToolFormData = {
      name: 'submit_order',
      toolType: 'http',
      description: 'Submit an order',
      parameters: [
        {
          name: 'order',
          type: 'object',
          required: true,
          description: 'Order payload',
          objectSchema: JSON.stringify({
            sku: { type: 'string', description: 'SKU' },
            quantity: { type: 'number', description: 'Quantity' },
          }),
        },
        {
          name: 'priority',
          type: 'string',
          required: false,
          description: 'Priority lane',
          enumValues: ['standard', 'expedite'],
          defaultValue: 'standard',
        },
      ],
      returnType: 'object',
      endpoint: 'https://orders.example.com/{{input.order.sku}}',
      method: 'POST',
      auth: 'api_key',
      authConfig: {
        apiKey: '{{secrets.ORDERS_API_KEY}}',
        headerName: 'X-Api-Key',
      },
      headers: [{ key: 'X-Tenant-Region', value: '{{config.REGION}}' }],
      bodyType: 'json',
      useBodySchema: true,
      bodySchema: JSON.stringify({
        type: 'object',
        required: ['sku', 'quantity'],
      }),
      body: '{"sku":"{{input.order.sku}}","quantity":"{{input.order.quantity}}"}',
      timeout: '{{config.HTTP_TIMEOUT_MS}}',
      retry: '{{config.HTTP_RETRY_COUNT}}',
      retryDelay: '{{config.HTTP_RETRY_DELAY_MS}}',
      rateLimit: '{{config.HTTP_RATE_LIMIT}}',
      circuitBreaker: {
        threshold: '{{config.HTTP_CB_THRESHOLD}}',
        resetMs: '{{config.HTTP_CB_RESET_MS}}',
      },
    };

    const dsl = serializeToolFormToDsl(form);
    const parsed = parseDslToToolForm(dsl, 'http');

    expect(parsed).toMatchObject({
      name: 'submit_order',
      toolType: 'http',
      description: 'Submit an order',
      endpoint: 'https://orders.example.com/{{input.order.sku}}',
      method: 'POST',
      auth: 'api_key',
      authConfig: {
        apiKey: '{{secrets.ORDERS_API_KEY}}',
        headerName: 'X-Api-Key',
      },
      headers: [{ key: 'X-Tenant-Region', value: '{{config.REGION}}' }],
      bodyType: 'json',
      useBodySchema: true,
      body: '{"sku":"{{input.order.sku}}","quantity":"{{input.order.quantity}}"}',
      timeout: '{{config.HTTP_TIMEOUT_MS}}',
      retry: '{{config.HTTP_RETRY_COUNT}}',
      retryDelay: '{{config.HTTP_RETRY_DELAY_MS}}',
      rateLimit: '{{config.HTTP_RATE_LIMIT}}',
      circuitBreaker: {
        threshold: '{{config.HTTP_CB_THRESHOLD}}',
        resetMs: '{{config.HTTP_CB_RESET_MS}}',
      },
    });
    expect(parsed?.parameters).toEqual([
      {
        name: 'order',
        type: 'object',
        required: true,
        description: 'Order payload',
        objectSchema: JSON.stringify({
          sku: { type: 'string', description: 'SKU' },
          quantity: { type: 'number', description: 'Quantity' },
        }),
      },
      {
        name: 'priority',
        type: 'string',
        required: false,
        description: 'Priority lane',
        enumValues: ['standard', 'expedite'],
        defaultValue: 'standard',
      },
    ]);
    expect(parsed && 'bodySchema' in parsed ? parsed.bodySchema : undefined).toBe(
      JSON.stringify({
        type: 'object',
        required: ['sku', 'quantity'],
      }),
    );
  });
});
