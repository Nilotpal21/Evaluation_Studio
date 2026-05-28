import { describe, expect, it } from 'vitest';
import { computeToolRuntimeMetadataHash } from '@agent-platform/shared/tools';
import { sanitizeProjectTool } from '@/lib/tool-response';

describe('sanitizeProjectTool', () => {
  it('emits a runtime metadata hash for variable namespace linked tools', () => {
    const result = sanitizeProjectTool({
      _id: 'tool-1',
      tenantId: 'tenant-1',
      name: 'lookup_ticket',
      variableNamespaceIds: ['ns-b', 'ns-a', 'ns-a'],
    });

    expect(result.id).toBe('tool-1');
    expect(result.tenantId).toBeUndefined();
    expect(result.runtimeMetadataHash).toBe(
      computeToolRuntimeMetadataHash({ variableNamespaceIds: ['ns-a', 'ns-b'] }),
    );
  });
});
