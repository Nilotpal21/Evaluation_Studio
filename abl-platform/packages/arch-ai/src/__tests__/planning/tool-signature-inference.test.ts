import { describe, expect, it } from 'vitest';

import {
  inferFallbackToolSignature,
  isGenericFallbackToolSignature,
} from '../../planning/tool-signature-inference.js';

describe('tool signature inference', () => {
  it('infers order lookup fields instead of generic input/result contracts', () => {
    const signature = inferFallbackToolSignature('get_order');

    expect(signature).toBe(
      'get_order(order_id: string) -> { status: string, last_scan_at: string, promised_delivery_date: string, eligible_options: string }',
    );
    expect(isGenericFallbackToolSignature(signature)).toBe(false);
  });

  it('prefers source scenario fixture shapes when available', () => {
    const signature = inferFallbackToolSignature('get_order', {
      sourceFiles: ['voltmart-sop.md'],
      declaredAgents: [],
      channels: [],
      requiredMcpServers: [],
      sharedMemoryVariables: [],
      universalRules: [],
      guardrails: [],
      tools: [],
      scenarioFixtures: [
        {
          name: 'late delivery',
          userMessage: 'Where is order VM-1001?',
          toolFixtures: [
            {
              toolName: 'get_order',
              sampleInput: { order_id: 'VM-1001' },
              response: JSON.stringify({
                order_id: 'VM-1001',
                status: 'delayed',
                items: [{ sku: 'BATTERY' }],
                ship_to: { city: 'Austin' },
                carrier: 'UPS',
                tracking_number: '1Z999',
                last_scan: 'Departed facility',
                last_scan_at: '2026-05-17T12:00:00Z',
                promised_delivery_date: '2026-05-18',
                payment_status: 'paid',
              }),
            },
          ],
          provenance: { fileName: 'voltmart-sop.md' },
        },
      ],
      optionalExternalAgents: [],
      confidence: 0.9,
    });

    expect(signature).toBe(
      'get_order(order_id: string) -> { order_id: string, status: string, items: object[], ship_to: object, carrier: string, tracking_number: string, last_scan: string, last_scan_at: string, promised_delivery_date: string, payment_status: string }',
    );
  });

  it('unions source fixture shapes across scenarios for the same tool', () => {
    const signature = inferFallbackToolSignature('get_order', {
      sourceFiles: ['voltmart-sop.md'],
      declaredAgents: [],
      channels: [],
      requiredMcpServers: [],
      sharedMemoryVariables: [],
      universalRules: [],
      guardrails: [],
      tools: [],
      scenarioFixtures: [
        {
          name: 'late delivery',
          userMessage: 'Where is order VM-1001?',
          toolFixtures: [
            {
              toolName: 'get_order',
              sampleInput: { order_id: 'VM-1001' },
              response: JSON.stringify({
                status: 'delayed',
                promised_delivery_date: '2026-05-18',
              }),
            },
          ],
          provenance: { fileName: 'voltmart-sop.md' },
        },
        {
          name: 'customer lookup',
          userMessage: 'Can you check my account orders?',
          toolFixtures: [
            {
              toolName: 'get_order',
              sampleInput: { customer_id: 'CUST-42' },
              response: JSON.stringify({
                carrier: 'UPS',
                tracking_number: '1Z999',
                payment_status: 'paid',
              }),
            },
          ],
          provenance: { fileName: 'voltmart-sop.md' },
        },
      ],
      optionalExternalAgents: [],
      confidence: 0.9,
    });

    expect(signature).toBe(
      'get_order(order_id: string, customer_id: string) -> { status: string, promised_delivery_date: string, carrier: string, tracking_number: string, payment_status: string }',
    );
  });

  it('infers write-action identifiers and outcome fields', () => {
    const signature = inferFallbackToolSignature('create_replacement');

    expect(signature).toBe(
      'create_replacement(order_id: string, reason: string) -> { success: boolean, replacement_id: string, promised_delivery_date: string }',
    );
    expect(isGenericFallbackToolSignature(signature)).toBe(false);
  });

  it('recognizes legacy generic fallbacks', () => {
    expect(isGenericFallbackToolSignature('lookup(input: string) -> { result: string }')).toBe(
      true,
    );
    expect(
      isGenericFallbackToolSignature(
        'lookup(input: string) -> { status: string, summary: string }',
      ),
    ).toBe(true);
  });
});
