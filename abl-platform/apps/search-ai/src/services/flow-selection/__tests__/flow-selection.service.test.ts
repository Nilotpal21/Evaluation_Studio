import { describe, it, expect, beforeEach } from 'vitest';
import { FlowSelectionService } from '../flow-selection.service.js';
import type { FlowContext } from '../types.js';
import type { ISearchPipelineFlow } from '@agent-platform/database';

// ─── Mock Flows ──────────────────────────────────────────────────────────

const createMockFlow = (overrides: Partial<ISearchPipelineFlow> = {}): ISearchPipelineFlow => ({
  id: 'flow-1',
  name: 'Default Flow',
  enabled: true,
  priority: 10,
  isDefault: false,
  stages: [
    {
      id: 'stage-1',
      name: 'Extraction',
      type: 'extraction',
      provider: 'docling',
      providerConfig: {},
      onError: 'fail',
    },
  ],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const createContext = (overrides: Partial<FlowContext> = {}): FlowContext => ({
  document: {
    extension: 'pdf',
    mimeType: 'application/pdf',
    size: 1048576,
    name: 'document.pdf',
  },
  source: {
    connector: 'google-drive',
    path: '/documents',
  },
  ...overrides,
});

// ─── Tests ───────────────────────────────────────────────────────────────

describe('FlowSelectionService', () => {
  let service: FlowSelectionService;

  beforeEach(() => {
    service = new FlowSelectionService();
  });

  describe('selectFlow', () => {
    it('should return error if no enabled flows', async () => {
      const flows = [createMockFlow({ enabled: false })];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No enabled flows found');
      expect(result.details.flowsEvaluated).toBe(0);
    });

    it('should select flow with no rules (default flow)', async () => {
      const flows = [createMockFlow({ selectionRules: undefined })];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
      expect(result.flow).toBeDefined();
      expect(result.flow!.id).toBe('flow-1');
    });

    it('should select flow with empty rules array', async () => {
      const flows = [createMockFlow({ selectionRules: [] })];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
      expect(result.flow!.id).toBe('flow-1');
    });

    it('should select highest priority flow when multiple flows have no rules', async () => {
      const flows = [
        createMockFlow({ id: 'flow-1', name: 'Low Priority', priority: 5 }),
        createMockFlow({ id: 'flow-2', name: 'High Priority', priority: 20 }),
        createMockFlow({ id: 'flow-3', name: 'Medium Priority', priority: 10 }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
      expect(result.flow!.id).toBe('flow-2');
      expect(result.flow!.name).toBe('High Priority');
    });

    it('should return error if no flow matches', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'simple',
              field: 'document.extension',
              operator: 'eq',
              value: 'docx', // Will not match
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No flow matched the selection criteria');
      expect(result.details.flowsEvaluated).toBe(1);
      expect(result.details.skippedFlows).toHaveLength(1);
    });
  });

  describe('simple rules', () => {
    it('should match simple eq rule', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'simple',
              field: 'document.extension',
              operator: 'eq',
              value: 'pdf',
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
      expect(result.flow!.id).toBe('flow-1');
    });

    it('should not match simple eq rule with wrong value', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'simple',
              field: 'document.extension',
              operator: 'eq',
              value: 'docx',
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(false);
    });

    it('should match simple ne rule', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'simple',
              field: 'document.extension',
              operator: 'ne',
              value: 'docx',
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
    });

    it('should match simple gt rule', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'simple',
              field: 'document.size',
              operator: 'gt',
              value: 500000,
            },
          ],
        }),
      ];
      const context = createContext(); // size is 1048576

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
    });

    it('should not match simple gt rule when value is smaller', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'simple',
              field: 'document.size',
              operator: 'gt',
              value: 2000000,
            },
          ],
        }),
      ];
      const context = createContext(); // size is 1048576

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(false);
    });

    it('should match simple lt rule', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'simple',
              field: 'document.size',
              operator: 'lt',
              value: 2000000,
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
    });

    it('should match simple contains rule for strings', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'simple',
              field: 'document.mimeType',
              operator: 'contains',
              value: 'pdf',
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
    });

    it('should match simple in rule', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'simple',
              field: 'document.extension',
              operator: 'in',
              value: ['pdf', 'docx', 'txt'],
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
    });

    it('should not match simple in rule with wrong array', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'simple',
              field: 'document.extension',
              operator: 'in',
              value: ['docx', 'txt'],
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(false);
    });

    it('should match simple matches rule with regex', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'simple',
              field: 'document.name',
              operator: 'matches',
              value: '^document.*\\.pdf$',
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
    });

    it('should support nested field paths', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'simple',
              field: 'source.connector',
              operator: 'eq',
              value: 'google-drive',
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
    });
  });

  describe('compound rules', () => {
    it('should match compound AND rule when all conditions match', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'compound',
              logic: 'AND',
              conditions: [
                {
                  type: 'simple',
                  field: 'document.extension',
                  operator: 'eq',
                  value: 'pdf',
                },
                {
                  type: 'simple',
                  field: 'document.size',
                  operator: 'lt',
                  value: 2000000,
                },
              ],
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
    });

    it('should not match compound AND rule when one condition fails', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'compound',
              logic: 'AND',
              conditions: [
                {
                  type: 'simple',
                  field: 'document.extension',
                  operator: 'eq',
                  value: 'pdf',
                },
                {
                  type: 'simple',
                  field: 'document.size',
                  operator: 'gt',
                  value: 5000000, // Will not match
                },
              ],
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(false);
    });

    it('should match compound OR rule when one condition matches', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'compound',
              logic: 'OR',
              conditions: [
                {
                  type: 'simple',
                  field: 'document.extension',
                  operator: 'eq',
                  value: 'docx', // Will not match
                },
                {
                  type: 'simple',
                  field: 'document.extension',
                  operator: 'eq',
                  value: 'pdf', // Will match
                },
              ],
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
    });

    it('should not match compound OR rule when no conditions match', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'compound',
              logic: 'OR',
              conditions: [
                {
                  type: 'simple',
                  field: 'document.extension',
                  operator: 'eq',
                  value: 'docx',
                },
                {
                  type: 'simple',
                  field: 'document.extension',
                  operator: 'eq',
                  value: 'txt',
                },
              ],
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(false);
    });

    it('should handle nested compound rules', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'compound',
              logic: 'AND',
              conditions: [
                {
                  type: 'simple',
                  field: 'document.extension',
                  operator: 'eq',
                  value: 'pdf',
                },
                {
                  type: 'compound',
                  logic: 'OR',
                  conditions: [
                    {
                      type: 'simple',
                      field: 'source.connector',
                      operator: 'eq',
                      value: 'google-drive',
                    },
                    {
                      type: 'simple',
                      field: 'source.connector',
                      operator: 'eq',
                      value: 's3',
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
    });
  });

  describe('CEL rules', () => {
    it('should match CEL expression with simple comparison', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'cel',
              celExpression: 'document.extension == "pdf"',
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
    });

    it('should match CEL expression with compound logic', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'cel',
              celExpression: 'document.extension == "pdf" && document.size < 2000000',
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
    });

    it('should not match CEL expression when condition is false', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'cel',
              celExpression: 'document.extension == "docx"',
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(false);
    });

    it('should match CEL expression with in operator', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'cel',
              celExpression: 'document.extension in ["pdf", "docx", "txt"]',
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
    });

    it('should match CEL expression with size operators', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'cel',
              celExpression: 'document.size > 500000 && document.size < 2000000',
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
    });

    it('should handle CEL evaluation errors gracefully', async () => {
      const flows = [
        createMockFlow({
          id: 'flow-1',
          selectionRules: [
            {
              type: 'cel',
              celExpression: 'invalid syntax [[[',
            },
          ],
        }),
        createMockFlow({
          id: 'flow-2',
          priority: 5,
          selectionRules: [], // Fallback flow
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      // Should skip erroring flow and select fallback
      expect(result.success).toBe(true);
      expect(result.flow!.id).toBe('flow-2');
      expect(result.details.skippedFlows).toHaveLength(1);
    });
  });

  describe('multiple rules', () => {
    it('should match when all rules in array match (AND logic)', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'simple',
              field: 'document.extension',
              operator: 'eq',
              value: 'pdf',
            },
            {
              type: 'simple',
              field: 'source.connector',
              operator: 'eq',
              value: 'google-drive',
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
    });

    it('should not match when one rule fails (AND logic)', async () => {
      const flows = [
        createMockFlow({
          selectionRules: [
            {
              type: 'simple',
              field: 'document.extension',
              operator: 'eq',
              value: 'pdf',
            },
            {
              type: 'simple',
              field: 'source.connector',
              operator: 'eq',
              value: 's3', // Will not match
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(false);
    });
  });

  describe('priority ordering', () => {
    it('should evaluate flows in priority order (highest first)', async () => {
      const flows = [
        createMockFlow({
          id: 'flow-low',
          priority: 1,
          selectionRules: [
            {
              type: 'simple',
              field: 'document.extension',
              operator: 'eq',
              value: 'pdf',
            },
          ],
        }),
        createMockFlow({
          id: 'flow-high',
          priority: 100,
          selectionRules: [
            {
              type: 'simple',
              field: 'document.extension',
              operator: 'eq',
              value: 'pdf',
            },
          ],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
      expect(result.flow!.id).toBe('flow-high');
    });
  });

  describe('error handling', () => {
    it('should skip flow with malformed rules and try next flow', async () => {
      const flows = [
        createMockFlow({
          id: 'flow-broken',
          priority: 100,
          selectionRules: [
            {
              type: 'simple',
              // Missing required fields
            } as any,
          ],
        }),
        createMockFlow({
          id: 'flow-working',
          priority: 50,
          selectionRules: [],
        }),
      ];
      const context = createContext();

      const result = await service.selectFlow(flows, context);

      expect(result.success).toBe(true);
      expect(result.flow!.id).toBe('flow-working');
      expect(result.details.skippedFlows).toHaveLength(1);
    });
  });
});
