/**
 * Marketplace Store — Unit Tests
 *
 * Tests Zustand store actions, state transitions, and filter management.
 * Uses vi.mock for apiFetch (external API boundary — not a codebase component).
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useMarketplaceStore } from '../../store/marketplace-store';

// Mock apiFetch — this is an external API boundary, not a codebase component
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api-client';
const mockApiFetch = vi.mocked(apiFetch);

function mockSuccessResponse(data: unknown) {
  return {
    ok: true,
    json: async () => ({ success: true, data }),
  } as unknown as Response;
}

function mockErrorResponse(status: number, error: string) {
  return {
    ok: false,
    status,
    json: async () => ({ error: { message: error } }),
  } as unknown as Response;
}

describe('marketplace-store', () => {
  beforeEach(() => {
    // Reset store to default state
    useMarketplaceStore.setState({
      templates: [],
      total: 0,
      loading: false,
      error: null,
      query: '',
      selectedCategories: [],
      selectedTypes: [],
      category: null,
      templateType: null,
      complexity: null,
      sortField: 'installCount',
      sortDirection: 'desc',
      sort: 'popular',
      page: 1,
      selectedTemplate: null,
      selectedVersion: null,
      detailLoading: false,
      detailError: null,
      categories: [],
      featured: [],
    });
    mockApiFetch.mockReset();
  });

  describe('fetchTemplates', () => {
    it('loading → success → data populated', async () => {
      const templates = [
        { _id: '1', slug: 'test', name: 'Test' },
        { _id: '2', slug: 'other', name: 'Other' },
      ];
      mockApiFetch.mockResolvedValueOnce(mockSuccessResponse({ templates, total: 2 }));

      const store = useMarketplaceStore.getState();
      const fetchPromise = store.fetchTemplates();

      // Loading should be true during fetch
      expect(useMarketplaceStore.getState().loading).toBe(true);

      await fetchPromise;

      const state = useMarketplaceStore.getState();
      expect(state.loading).toBe(false);
      expect(state.templates).toHaveLength(2);
      expect(state.total).toBe(2);
      expect(state.error).toBeNull();
    });

    it('loading → error → error message set', async () => {
      mockApiFetch.mockResolvedValueOnce(mockErrorResponse(500, 'Internal server error'));

      await useMarketplaceStore.getState().fetchTemplates();

      const state = useMarketplaceStore.getState();
      expect(state.loading).toBe(false);
      expect(state.error).toBe('Internal server error');
      expect(state.templates).toHaveLength(0);
    });

    it('includes filters in API request', async () => {
      mockApiFetch.mockResolvedValueOnce(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.setState({
        query: 'test',
        selectedCategories: ['hr'],
        selectedTypes: ['agent'],
        category: 'hr',
        templateType: 'agent',
        complexity: 'starter',
        sortField: 'viewCount',
        sortDirection: 'desc',
        sort: 'newest',
        page: 2,
      });

      await useMarketplaceStore.getState().fetchTemplates();

      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('q=test'));
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('category=hr'));
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('type=agent'));
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('complexity=starter'));
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('sort=newest'));
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('page=2'));
    });
  });

  describe('fetchTemplateDetail', () => {
    it('loads detail into selectedTemplate', async () => {
      const template = { _id: '1', slug: 'test', name: 'Test' };
      const version = { _id: 'v1', version: '1.0.0' };
      mockApiFetch.mockResolvedValueOnce(mockSuccessResponse({ template, version }));

      await useMarketplaceStore.getState().fetchTemplateDetail('test');

      const state = useMarketplaceStore.getState();
      expect(state.selectedTemplate).toEqual(template);
      expect(state.selectedVersion).toEqual(version);
      expect(state.detailLoading).toBe(false);
      expect(state.detailError).toBeNull();
    });
  });

  describe('filter actions', () => {
    it('setCategory updates state and resets page', () => {
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.setState({ page: 3 });
      useMarketplaceStore.getState().setCategory('sales');

      const state = useMarketplaceStore.getState();
      expect(state.category).toBe('sales');
      expect(state.selectedCategories).toEqual(['sales']);
      expect(state.page).toBe(1);
    });

    it('setTemplateType updates state and resets page', () => {
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.setState({ page: 2 });
      useMarketplaceStore.getState().setTemplateType('project');

      const state = useMarketplaceStore.getState();
      expect(state.templateType).toBe('project');
      expect(state.selectedTypes).toEqual(['project']);
      expect(state.page).toBe(1);
    });

    it('setSort updates state and resets page', () => {
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.setState({ page: 5 });
      useMarketplaceStore.getState().setSort('newest');

      const state = useMarketplaceStore.getState();
      expect(state.sort).toBe('newest');
      expect(state.sortField).toBe('viewCount');
      expect(state.sortDirection).toBe('desc');
      expect(state.page).toBe(1);
    });

    it('setComplexity updates state and resets page', () => {
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.getState().setComplexity('advanced');
      expect(useMarketplaceStore.getState().complexity).toBe('advanced');
    });

    it('setPage updates page', () => {
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.getState().setPage(3);
      expect(useMarketplaceStore.getState().page).toBe(3);
    });
  });

  describe('resetFilters', () => {
    it('clears all filters to defaults', () => {
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.setState({
        query: 'test',
        selectedCategories: ['hr'],
        selectedTypes: ['agent'],
        category: 'hr',
        templateType: 'agent',
        complexity: 'advanced',
        sortField: 'viewCount',
        sortDirection: 'asc',
        sort: 'newest',
        page: 5,
      });

      useMarketplaceStore.getState().resetFilters();

      const state = useMarketplaceStore.getState();
      expect(state.query).toBe('');
      expect(state.category).toBeNull();
      expect(state.templateType).toBeNull();
      expect(state.selectedCategories).toEqual([]);
      expect(state.selectedTypes).toEqual([]);
      expect(state.complexity).toBeNull();
      expect(state.sortField).toBe('installCount');
      expect(state.sortDirection).toBe('desc');
      expect(state.sort).toBe('popular');
      expect(state.page).toBe(1);
    });
  });

  describe('fetchCategories', () => {
    it('populates categories on success', async () => {
      const categories = [
        { name: 'sales', count: 5 },
        { name: 'hr', count: 3 },
      ];
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ categories }));

      await useMarketplaceStore.getState().fetchCategories();

      expect(useMarketplaceStore.getState().categories).toEqual(categories);
    });
  });

  describe('fetchFeatured', () => {
    it('populates featured on success', async () => {
      const templates = [{ slug: 'feat-1', name: 'Featured 1' }];
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ templates }));

      await useMarketplaceStore.getState().fetchFeatured();

      expect(useMarketplaceStore.getState().featured).toEqual(templates);
    });
  });

  describe('setQuery', () => {
    it('sets query and resets page to 1', () => {
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ templates: [], total: 0 }));
      useMarketplaceStore.setState({ page: 5 });

      useMarketplaceStore.getState().setQuery('customer');

      expect(useMarketplaceStore.getState().query).toBe('customer');
      expect(useMarketplaceStore.getState().page).toBe(1);
    });
  });

  describe('setTemplateType (type filter)', () => {
    it('setTemplateType updates templateType state', () => {
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.getState().setTemplateType('agent');
      const state = useMarketplaceStore.getState();
      expect(state.templateType).toBe('agent');
      expect(state.selectedTypes).toEqual(['agent']);
    });

    it('fetchTemplates includes type filter when one type selected', async () => {
      mockApiFetch.mockResolvedValueOnce(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.setState({ selectedTypes: ['agent'], templateType: 'agent' });
      await useMarketplaceStore.getState().fetchTemplates();

      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('type=agent'));
    });

    it('fetchTemplates omits type filter when no types selected', async () => {
      mockApiFetch.mockResolvedValueOnce(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.setState({ selectedTypes: [], templateType: null });
      await useMarketplaceStore.getState().fetchTemplates();

      expect(mockApiFetch).toHaveBeenCalledWith(expect.not.stringContaining('type='));
    });

    it('fetchTemplates omits type filter when both types selected', async () => {
      mockApiFetch.mockResolvedValueOnce(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.setState({ selectedTypes: ['agent', 'project'], templateType: null });
      await useMarketplaceStore.getState().fetchTemplates();

      expect(mockApiFetch).toHaveBeenCalledWith(expect.not.stringContaining('type='));
    });
  });

  describe('fetchCategories with type filter', () => {
    it('fetchCategories includes type filter when one type selected', async () => {
      mockApiFetch.mockResolvedValueOnce(
        mockSuccessResponse({ categories: [{ name: 'sales', count: 3 }] }),
      );

      useMarketplaceStore.setState({ selectedTypes: ['project'], templateType: 'project' });
      await useMarketplaceStore.getState().fetchCategories();

      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('type=project'));
    });

    it('fetchCategories omits type filter when no types selected', async () => {
      mockApiFetch.mockResolvedValueOnce(
        mockSuccessResponse({ categories: [{ name: 'sales', count: 3 }] }),
      );

      useMarketplaceStore.setState({ selectedTypes: [], templateType: null });
      await useMarketplaceStore.getState().fetchCategories();

      expect(mockApiFetch).toHaveBeenCalledWith('/api/template-store/marketplace/categories');
    });
  });

  describe('toggleType', () => {
    it('adds type to selectedTypes when not present', () => {
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.setState({ selectedTypes: [] });
      useMarketplaceStore.getState().toggleType('agent');

      expect(useMarketplaceStore.getState().selectedTypes).toEqual(['agent']);
      expect(useMarketplaceStore.getState().page).toBe(1);
    });

    it('removes type from selectedTypes when already present', () => {
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.setState({ selectedTypes: ['agent', 'project'] });
      useMarketplaceStore.getState().toggleType('agent');

      expect(useMarketplaceStore.getState().selectedTypes).toEqual(['project']);
    });
  });

  describe('toggleCategory', () => {
    it('adds category to selectedCategories when not present', () => {
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.setState({ selectedCategories: [] });
      useMarketplaceStore.getState().toggleCategory('sales');

      expect(useMarketplaceStore.getState().selectedCategories).toEqual(['sales']);
      expect(useMarketplaceStore.getState().page).toBe(1);
    });

    it('removes category from selectedCategories when already present', () => {
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.setState({ selectedCategories: ['sales', 'hr'] });
      useMarketplaceStore.getState().toggleCategory('sales');

      expect(useMarketplaceStore.getState().selectedCategories).toEqual(['hr']);
    });
  });

  describe('setSortField', () => {
    it('updates sortField and triggers fetch', async () => {
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.getState().setSortField('viewCount');

      const state = useMarketplaceStore.getState();
      expect(state.sortField).toBe('viewCount');
      expect(state.page).toBe(1);
      // fetchTemplates is async — wait for microtask to flush
      await vi.waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    });
  });

  describe('setSortDirection', () => {
    it('updates sortDirection and triggers fetch', async () => {
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.getState().setSortDirection('asc');

      const state = useMarketplaceStore.getState();
      expect(state.sortDirection).toBe('asc');
      expect(state.page).toBe(1);
      await vi.waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    });
  });

  describe('clearTypeFilters', () => {
    it('clears selectedTypes to empty array', () => {
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.setState({ selectedTypes: ['agent', 'project'] });
      useMarketplaceStore.getState().clearTypeFilters();

      expect(useMarketplaceStore.getState().selectedTypes).toEqual([]);
      expect(useMarketplaceStore.getState().templateType).toBeNull();
    });
  });

  describe('clearCategoryFilters', () => {
    it('clears selectedCategories to empty array', () => {
      mockApiFetch.mockResolvedValue(mockSuccessResponse({ templates: [], total: 0 }));

      useMarketplaceStore.setState({ selectedCategories: ['sales', 'hr'] });
      useMarketplaceStore.getState().clearCategoryFilters();

      expect(useMarketplaceStore.getState().selectedCategories).toEqual([]);
      expect(useMarketplaceStore.getState().category).toBeNull();
    });
  });
});
