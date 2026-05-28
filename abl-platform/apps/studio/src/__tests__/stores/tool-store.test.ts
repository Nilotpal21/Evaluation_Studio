/**
 * Tool Store Tests
 *
 * Tests for the Zustand tool store: CRUD operations on tools list,
 * loading/error state transitions, type-count computation, filtering,
 * pagination tracking, and currentTool management.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { useToolStore } from '../../store/tool-store';
import type { ToolWithVersion } from '../../store/tool-store';

// =============================================================================
// HELPERS
// =============================================================================

let idCounter = 0;

function makeTool(overrides: Partial<ToolWithVersion> = {}): ToolWithVersion {
  idCounter++;
  return {
    id: `tool-${idCounter}`,
    name: `Tool ${idCounter}`,
    slug: `tool-${idCounter}`,
    toolType: 'http',
    description: null,
    dslContent: `tool_${idCounter}() -> object\n  type: http`,
    sourceHash: `hash-${idCounter}`,
    variableNamespaceIds: [],
    projectId: 'project-1',
    createdBy: 'Test User',
    lastEditedBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const defaultPagination = { page: 1, limit: 50, total: 0, hasMore: false };

function resetStore() {
  useToolStore.setState({
    tools: [],
    currentTool: null,
    isLoading: false,
    error: null,
    pagination: { ...defaultPagination },
    searchQuery: '',
    filterType: null,
    httpCount: 0,
    sandboxCount: 0,
    mcpCount: 0,
    searchaiCount: 0,
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('Tool Store', () => {
  beforeEach(() => {
    idCounter = 0;
    resetStore();
  });

  // ---------------------------------------------------------------------------
  // 1. Initial state
  // ---------------------------------------------------------------------------
  describe('initial state', () => {
    test('has correct default values', () => {
      const state = useToolStore.getState();
      expect(state.tools).toEqual([]);
      expect(state.currentTool).toBeNull();
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
      expect(state.pagination).toEqual(defaultPagination);
      expect(state.searchQuery).toBe('');
      expect(state.filterType).toBeNull();
      expect(state.httpCount).toBe(0);
      expect(state.sandboxCount).toBe(0);
      expect(state.mcpCount).toBe(0);
      expect(state.searchaiCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. setTools
  // ---------------------------------------------------------------------------
  describe('setTools', () => {
    test('sets tools array and pagination', () => {
      const tools = [makeTool(), makeTool()];
      const pagination = { page: 1, limit: 50, total: 2, hasMore: false };

      useToolStore.getState().setTools(tools, pagination);

      const state = useToolStore.getState();
      expect(state.tools).toHaveLength(2);
      expect(state.pagination).toEqual(pagination);
    });

    test('computes type counts for http tools', () => {
      const tools = [makeTool({ toolType: 'http' }), makeTool({ toolType: 'http' })];
      useToolStore.getState().setTools(tools, defaultPagination);

      const state = useToolStore.getState();
      expect(state.httpCount).toBe(2);
      expect(state.sandboxCount).toBe(0);
      expect(state.mcpCount).toBe(0);
    });

    test('computes type counts for mixed tool types', () => {
      const tools = [
        makeTool({ toolType: 'http' }),
        makeTool({ toolType: 'sandbox' }),
        makeTool({ toolType: 'mcp' }),
        makeTool({ toolType: 'mcp' }),
      ];
      useToolStore.getState().setTools(tools, defaultPagination);

      const state = useToolStore.getState();
      expect(state.httpCount).toBe(1);
      expect(state.sandboxCount).toBe(1);
      expect(state.mcpCount).toBe(2);
      expect(state.searchaiCount).toBe(0);
    });

    test('resets type counts when setting empty tools', () => {
      // Set some tools first
      useToolStore
        .getState()
        .setTools(
          [makeTool({ toolType: 'http' }), makeTool({ toolType: 'sandbox' })],
          defaultPagination,
        );
      expect(useToolStore.getState().httpCount).toBe(1);

      // Clear
      useToolStore.getState().setTools([], defaultPagination);

      const state = useToolStore.getState();
      expect(state.httpCount).toBe(0);
      expect(state.sandboxCount).toBe(0);
      expect(state.mcpCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. setCurrentTool
  // ---------------------------------------------------------------------------
  describe('setCurrentTool', () => {
    test('sets current tool to a tool object', () => {
      const tool = makeTool({ name: 'Selected Tool' });
      useToolStore.getState().setCurrentTool(tool);
      expect(useToolStore.getState().currentTool).toEqual(tool);
    });

    test('clears current tool when set to null', () => {
      const tool = makeTool();
      useToolStore.getState().setCurrentTool(tool);
      useToolStore.getState().setCurrentTool(null);
      expect(useToolStore.getState().currentTool).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. addTool
  // ---------------------------------------------------------------------------
  describe('addTool', () => {
    test('prepends tool to list', () => {
      const existing = makeTool({ name: 'Existing' });
      useToolStore.getState().setTools([existing], { ...defaultPagination, total: 1 });

      const newTool = makeTool({ name: 'New Tool' });
      useToolStore.getState().addTool(newTool);

      const state = useToolStore.getState();
      expect(state.tools).toHaveLength(2);
      expect(state.tools[0].name).toBe('New Tool');
      expect(state.tools[1].name).toBe('Existing');
    });

    test('increments pagination total', () => {
      useToolStore.getState().setTools([], { ...defaultPagination, total: 5 });
      useToolStore.getState().addTool(makeTool());
      expect(useToolStore.getState().pagination.total).toBe(6);
    });

    test('updates type counts', () => {
      useToolStore.getState().setTools([makeTool({ toolType: 'http' })], defaultPagination);
      expect(useToolStore.getState().httpCount).toBe(1);

      useToolStore.getState().addTool(makeTool({ toolType: 'sandbox' }));

      const state = useToolStore.getState();
      expect(state.httpCount).toBe(1);
      expect(state.sandboxCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. updateToolInList
  // ---------------------------------------------------------------------------
  describe('updateToolInList', () => {
    test('updates matching tool in list by id', () => {
      const tool = makeTool({ name: 'Original' });
      useToolStore.getState().setTools([tool], defaultPagination);

      useToolStore.getState().updateToolInList(tool.id, { name: 'Updated' });

      expect(useToolStore.getState().tools[0].name).toBe('Updated');
    });

    test('does not modify non-matching tools', () => {
      const tool1 = makeTool({ name: 'Tool A' });
      const tool2 = makeTool({ name: 'Tool B' });
      useToolStore.getState().setTools([tool1, tool2], defaultPagination);

      useToolStore.getState().updateToolInList(tool1.id, { name: 'Updated A' });

      expect(useToolStore.getState().tools[0].name).toBe('Updated A');
      expect(useToolStore.getState().tools[1].name).toBe('Tool B');
    });

    test('updates currentTool if it matches the id', () => {
      const tool = makeTool({ name: 'Current' });
      useToolStore.getState().setCurrentTool(tool);
      useToolStore.getState().setTools([tool], defaultPagination);

      useToolStore.getState().updateToolInList(tool.id, { name: 'Updated Current' });

      expect(useToolStore.getState().currentTool?.name).toBe('Updated Current');
    });

    test('does not update currentTool if id does not match', () => {
      const current = makeTool({ name: 'Current' });
      const other = makeTool({ name: 'Other' });
      useToolStore.getState().setCurrentTool(current);
      useToolStore.getState().setTools([current, other], defaultPagination);

      useToolStore.getState().updateToolInList(other.id, { name: 'Updated Other' });

      expect(useToolStore.getState().currentTool?.name).toBe('Current');
    });

    test('no-op when tool id not found', () => {
      const tool = makeTool({ name: 'Original' });
      useToolStore.getState().setTools([tool], defaultPagination);

      useToolStore.getState().updateToolInList('nonexistent', { name: 'Ghost' });

      expect(useToolStore.getState().tools[0].name).toBe('Original');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. removeTool
  // ---------------------------------------------------------------------------
  describe('removeTool', () => {
    test('removes tool from list by id', () => {
      const tool1 = makeTool();
      const tool2 = makeTool();
      useToolStore.getState().setTools([tool1, tool2], { ...defaultPagination, total: 2 });

      useToolStore.getState().removeTool(tool1.id);

      const state = useToolStore.getState();
      expect(state.tools).toHaveLength(1);
      expect(state.tools[0].id).toBe(tool2.id);
    });

    test('decrements pagination total', () => {
      const tool = makeTool();
      useToolStore.getState().setTools([tool], { ...defaultPagination, total: 3 });

      useToolStore.getState().removeTool(tool.id);

      expect(useToolStore.getState().pagination.total).toBe(2);
    });

    test('total does not go below zero', () => {
      const tool = makeTool();
      useToolStore.getState().setTools([tool], { ...defaultPagination, total: 0 });

      useToolStore.getState().removeTool(tool.id);

      expect(useToolStore.getState().pagination.total).toBe(0);
    });

    test('clears currentTool if removed tool is current', () => {
      const tool = makeTool();
      useToolStore.getState().setCurrentTool(tool);
      useToolStore.getState().setTools([tool], defaultPagination);

      useToolStore.getState().removeTool(tool.id);

      expect(useToolStore.getState().currentTool).toBeNull();
    });

    test('keeps currentTool if removed tool is not current', () => {
      const current = makeTool({ name: 'Current' });
      const other = makeTool({ name: 'Other' });
      useToolStore.getState().setCurrentTool(current);
      useToolStore.getState().setTools([current, other], defaultPagination);

      useToolStore.getState().removeTool(other.id);

      expect(useToolStore.getState().currentTool?.name).toBe('Current');
    });

    test('updates type counts after removal', () => {
      const httpTool = makeTool({ toolType: 'http' });
      const sandboxTool = makeTool({ toolType: 'sandbox' });
      useToolStore.getState().setTools([httpTool, sandboxTool], defaultPagination);

      expect(useToolStore.getState().httpCount).toBe(1);
      expect(useToolStore.getState().sandboxCount).toBe(1);

      useToolStore.getState().removeTool(httpTool.id);

      expect(useToolStore.getState().httpCount).toBe(0);
      expect(useToolStore.getState().sandboxCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Loading state
  // ---------------------------------------------------------------------------
  describe('setLoading', () => {
    test('sets loading to true', () => {
      useToolStore.getState().setLoading(true);
      expect(useToolStore.getState().isLoading).toBe(true);
    });

    test('sets loading to false', () => {
      useToolStore.getState().setLoading(true);
      useToolStore.getState().setLoading(false);
      expect(useToolStore.getState().isLoading).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Error state
  // ---------------------------------------------------------------------------
  describe('setError', () => {
    test('sets error string', () => {
      useToolStore.getState().setError('Something went wrong');
      expect(useToolStore.getState().error).toBe('Something went wrong');
    });

    test('sets error as string array', () => {
      const errors = ['Error 1', 'Error 2'];
      useToolStore.getState().setError(errors);
      expect(useToolStore.getState().error).toEqual(errors);
    });

    test('clears error with null', () => {
      useToolStore.getState().setError('Some error');
      useToolStore.getState().setError(null);
      expect(useToolStore.getState().error).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Search and filter
  // ---------------------------------------------------------------------------
  describe('search and filter', () => {
    test('setSearchQuery updates search query', () => {
      useToolStore.getState().setSearchQuery('weather');
      expect(useToolStore.getState().searchQuery).toBe('weather');
    });

    test('setSearchQuery can clear query', () => {
      useToolStore.getState().setSearchQuery('something');
      useToolStore.getState().setSearchQuery('');
      expect(useToolStore.getState().searchQuery).toBe('');
    });

    test('setFilterType sets a tool type filter', () => {
      useToolStore.getState().setFilterType('http');
      expect(useToolStore.getState().filterType).toBe('http');
    });

    test('setFilterType clears filter with null', () => {
      useToolStore.getState().setFilterType('sandbox');
      useToolStore.getState().setFilterType(null);
      expect(useToolStore.getState().filterType).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Loading/error state transition patterns
  // ---------------------------------------------------------------------------
  describe('state transition patterns', () => {
    test('simulates a successful fetch cycle', () => {
      const store = useToolStore.getState();

      // Start loading
      store.setLoading(true);
      store.setError(null);
      expect(useToolStore.getState().isLoading).toBe(true);
      expect(useToolStore.getState().error).toBeNull();

      // Receive data
      const tools = [makeTool({ toolType: 'http' }), makeTool({ toolType: 'mcp' })];
      const pagination = { page: 1, limit: 50, total: 2, hasMore: false };
      useToolStore.getState().setTools(tools, pagination);
      useToolStore.getState().setLoading(false);

      const state = useToolStore.getState();
      expect(state.isLoading).toBe(false);
      expect(state.tools).toHaveLength(2);
      expect(state.httpCount).toBe(1);
      expect(state.mcpCount).toBe(1);
    });

    test('simulates a failed fetch cycle', () => {
      const store = useToolStore.getState();

      // Start loading
      store.setLoading(true);
      store.setError(null);

      // Error occurs
      useToolStore.getState().setLoading(false);
      useToolStore.getState().setError('Network error');

      const state = useToolStore.getState();
      expect(state.isLoading).toBe(false);
      expect(state.error).toBe('Network error');
      expect(state.tools).toEqual([]);
    });

    test('simulates create then add cycle', () => {
      // Pre-existing tool
      useToolStore
        .getState()
        .setTools([makeTool({ toolType: 'sandbox' })], { ...defaultPagination, total: 1 });

      // Create succeeds, add to store
      const newTool = makeTool({ toolType: 'http', name: 'New API Tool' });
      useToolStore.getState().addTool(newTool);

      const state = useToolStore.getState();
      expect(state.tools).toHaveLength(2);
      expect(state.tools[0].name).toBe('New API Tool');
      expect(state.pagination.total).toBe(2);
      expect(state.httpCount).toBe(1);
      expect(state.sandboxCount).toBe(1);
    });

    test('simulates update then refresh cycle', () => {
      const tool = makeTool({ name: 'Before Update' });
      useToolStore.getState().setTools([tool], { ...defaultPagination, total: 1 });
      useToolStore.getState().setCurrentTool(tool);

      // Update in-place
      useToolStore.getState().updateToolInList(tool.id, {
        name: 'After Update',
      });

      const state = useToolStore.getState();
      expect(state.tools[0].name).toBe('After Update');
      expect(state.currentTool?.name).toBe('After Update');
    });

    test('simulates delete cycle', () => {
      const tool1 = makeTool({ toolType: 'http' });
      const tool2 = makeTool({ toolType: 'sandbox' });
      useToolStore.getState().setTools([tool1, tool2], { ...defaultPagination, total: 2 });
      useToolStore.getState().setCurrentTool(tool1);

      // Delete current tool
      useToolStore.getState().removeTool(tool1.id);

      const state = useToolStore.getState();
      expect(state.tools).toHaveLength(1);
      expect(state.currentTool).toBeNull();
      expect(state.pagination.total).toBe(1);
      expect(state.httpCount).toBe(0);
      expect(state.sandboxCount).toBe(1);
    });
  });
});
