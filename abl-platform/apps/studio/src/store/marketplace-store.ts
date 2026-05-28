/**
 * Marketplace Store
 *
 * Manages Template Store marketplace state: browse, filters, detail, categories, featured.
 * API calls route through the Studio proxy (/api/template-store/* -> template-store service).
 */

import { create } from 'zustand';
import { apiFetch } from '@/lib/api-client';
import {
  installProjectTemplate as apiInstallProjectTemplate,
  previewAgentInstall as apiPreviewAgentInstall,
  applyAgentInstall as apiApplyAgentInstall,
} from '@/api/template-install';
import type {
  AppliedCounts,
  ProvisioningReport,
  AgentPreviewResponse,
} from '@/api/template-install';

// ─── Types (mirrored from template models for client-side use) ──────────────

export interface TemplateMedia {
  type: 'image' | 'video';
  url: string;
  thumbnailUrl?: string;
  caption: string;
  order: number;
}

export interface TemplatePrerequisites {
  envVars: string[];
  connectors: string[];
  mcpServers: string[];
  authProfiles: string[];
  models: string[];
}

export interface DemoConversationMessage {
  role: string;
  content: string;
}

export interface MarketplaceTemplate {
  _id: string;
  slug: string;
  name: string;
  shortDescription: string;
  longDescription: string;
  type: string;
  typeMetadata: Record<string, unknown> | null;
  detailSections: string[];
  category: string;
  subcategory: string | null;
  tags: string[];
  complexity: string;
  publisherId: string;
  publisherTenantId: string;
  publisherName: string;
  publisherVerified: boolean;
  installCount: number;
  viewCount: number;
  ratingAverage: number;
  ratingCount: number;
  featuredOrder: number | null;
  publishedAt: string | null;
  media: TemplateMedia[];
  prerequisites: TemplatePrerequisites;
  reviewStatus: string;
  demoConversation: DemoConversationMessage[];
  iconUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceTemplateVersion {
  _id: string;
  templateId: string;
  version: string;
  changelog: string;
  manifest: Record<string, unknown> | null;
  customizationSchema: Record<string, unknown> | null;
  status: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceCategory {
  name: string;
  count: number;
}

// ─── Store ──────────────────────────────────────────────────────────────────

// ─── Sort types ─────────────────────────────────────────────────────────────

export type SortField = 'name' | 'installCount' | 'viewCount';
export type SortDirection = 'asc' | 'desc';

interface MarketplaceState {
  // Browse state
  templates: MarketplaceTemplate[];
  total: number;
  loading: boolean;
  error: string | null;

  // Filters — multi-select
  query: string;
  selectedCategories: string[];
  selectedTypes: string[];
  selectedPublishers: string[];
  complexity: 'starter' | 'standard' | 'advanced' | null;
  sortField: SortField;
  sortDirection: SortDirection;
  page: number;

  // Backward-compat aliases (derived from multi-select state)
  /** @deprecated Use selectedCategories instead */
  category: string | null;
  /** @deprecated Use selectedTypes instead */
  templateType: 'agent' | 'project' | null;
  /** @deprecated Use sortField + sortDirection instead */
  sort: 'popular' | 'rating' | 'newest' | 'updated';

  // Detail state
  selectedTemplate: MarketplaceTemplate | null;
  selectedVersion: MarketplaceTemplateVersion | null;
  detailLoading: boolean;
  detailError: string | null;

  // Categories
  categories: MarketplaceCategory[];

  // Featured
  featured: MarketplaceTemplate[];

  // Install state
  installLoading: boolean;
  installError: string | null;
  installResult: {
    project?: { id: string; name: string; slug: string };
    applied?: AppliedCounts;
    entryAgentName?: string | null;
    provisioningRequired?: ProvisioningReport;
  } | null;

  // Agent install flow state
  agentPreview: {
    preview: AgentPreviewResponse['preview'];
    previewDigest: string | null;
    warnings: string[];
  } | null;
  agentPreviewLoading: boolean;
  agentPreviewError: string | null;

  // User's projects (for agent install project selector)
  userProjects: Array<{ id: string; name: string; slug: string; agentCount: number }>;
  userProjectsLoading: boolean;

  // Actions
  fetchTemplates: () => Promise<void>;
  fetchTemplateDetail: (slug: string) => Promise<void>;
  fetchCategories: () => Promise<void>;
  fetchFeatured: () => Promise<void>;
  setQuery: (q: string) => void;

  // New multi-select actions
  toggleType: (type: string) => void;
  toggleCategory: (cat: string) => void;
  togglePublisher: (id: string) => void;
  clearPublisherFilters: () => void;
  setSortField: (field: SortField) => void;
  setSortDirection: (dir: SortDirection) => void;
  clearTypeFilters: () => void;
  clearCategoryFilters: () => void;

  // Backward-compat adapter actions (call new multi-select functions internally)
  /** @deprecated Use toggleCategory / clearCategoryFilters instead */
  setCategory: (cat: string | null) => void;
  /** @deprecated Use toggleType / clearTypeFilters instead */
  setTemplateType: (type: 'agent' | 'project' | null) => void;
  setComplexity: (c: 'starter' | 'standard' | 'advanced' | null) => void;
  /** @deprecated Use setSortField + setSortDirection instead */
  setSort: (s: 'popular' | 'rating' | 'newest' | 'updated') => void;
  setPage: (p: number) => void;
  resetFilters: () => void;

  // Install actions
  installProjectTemplate: (input: {
    templateSlug: string;
    version: string;
    projectName: string;
    description?: string;
  }) => Promise<void>;
  previewAgentInstall: (projectId: string, templateSlug: string, version: string) => Promise<void>;
  applyAgentInstall: (
    projectId: string,
    templateSlug: string,
    version: string,
    previewDigest?: string | null,
  ) => Promise<void>;
  fetchUserProjects: () => Promise<void>;
  resetInstallState: () => void;
}

let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Map sortField to the API's sort param value */
function sortFieldToApiSort(field: SortField): string {
  switch (field) {
    case 'installCount':
      return 'popular';
    case 'viewCount':
      return 'newest';
    case 'name':
      return 'newest'; // API doesn't support name sort — fallback; client-side sort applied
    default:
      return 'popular';
  }
}

/** Derive backward-compat `category` from selectedCategories */
function deriveCategory(cats: string[]): string | null {
  return cats.length > 0 ? cats[0] : null;
}

/** Derive backward-compat `templateType` from selectedTypes */
function deriveTemplateType(types: string[]): 'agent' | 'project' | null {
  if (types.length === 1 && (types[0] === 'agent' || types[0] === 'project')) {
    return types[0];
  }
  return null;
}

/** Derive backward-compat `sort` from sortField */
function deriveSortLegacy(field: SortField): 'popular' | 'rating' | 'newest' | 'updated' {
  switch (field) {
    case 'installCount':
      return 'popular';
    case 'viewCount':
      return 'newest';
    case 'name':
      return 'newest';
    default:
      return 'popular';
  }
}

export const useMarketplaceStore = create<MarketplaceState>()((set, get) => ({
  // Browse state
  templates: [],
  total: 0,
  loading: false,
  error: null,

  // Filters — multi-select (new canonical state)
  query: '',
  selectedCategories: [],
  selectedTypes: [],
  selectedPublishers: [],
  complexity: null,
  sortField: 'installCount',
  sortDirection: 'desc',
  page: 1,

  // Backward-compat aliases (derived defaults)
  category: null,
  templateType: null,
  sort: 'popular',

  // Detail state
  selectedTemplate: null,
  selectedVersion: null,
  detailLoading: false,
  detailError: null,

  // Categories
  categories: [],

  // Featured
  featured: [],

  // Install state
  installLoading: false,
  installError: null,
  installResult: null,

  // Agent install flow state
  agentPreview: null,
  agentPreviewLoading: false,
  agentPreviewError: null,

  // User's projects
  userProjects: [],
  userProjectsLoading: false,

  // Actions
  fetchTemplates: async () => {
    const state = get();
    set({ loading: true, error: null });
    try {
      const params = new URLSearchParams();
      params.set('page', String(state.page));
      params.set('limit', '20');
      params.set('sort', sortFieldToApiSort(state.sortField));
      if (state.query) params.set('q', state.query);

      // Multi-select type: send only when exactly one type selected
      if (state.selectedTypes.length === 1) {
        params.set('type', state.selectedTypes[0]);
      }

      // Multi-select categories: send the first one (API accepts single category)
      if (state.selectedCategories.length > 0) {
        params.set('category', state.selectedCategories[0]);
      }

      if (state.complexity) params.set('complexity', state.complexity);

      // Publisher filter: send publisherTenantId when exactly one publisher selected
      if (state.selectedPublishers.length === 1) {
        params.set('publisherTenantId', state.selectedPublishers[0]);
      }

      // Pass tenantId for tenant-scoped browse (shows workspace templates alongside global).
      // The tenantId is persisted in localStorage even across full-page navigations.
      // This is needed because the marketplace is a standalone route group where the
      // in-memory accessToken is lost, so the proxy can't forward auth headers.
      try {
        const { tenantId: authTenantId } = (
          await import('../store/auth-store')
        ).useAuthStore.getState();
        if (authTenantId) {
          params.set('tenantId', authTenantId);
        }
      } catch {
        // auth store not available — public browse only
      }

      const res = await apiFetch(`/api/template-store/marketplace/templates?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message =
          body?.error?.message ?? body?.error ?? `Failed to load templates (${res.status})`;
        set({
          loading: false,
          error: typeof message === 'string' ? message : String(message),
        });
        return;
      }
      const data = await res.json();
      const payload = data.data ?? data;
      let templates: MarketplaceTemplate[] = payload.templates ?? [];

      // Client-side sort by name if sortField is 'name'
      if (state.sortField === 'name') {
        templates = [...templates].sort((a, b) => {
          const cmp = a.name.localeCompare(b.name);
          return state.sortDirection === 'asc' ? cmp : -cmp;
        });
      }

      set({
        templates,
        total: payload.total ?? 0,
        loading: false,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  fetchTemplateDetail: async (slug: string) => {
    set({ detailLoading: true, detailError: null, selectedTemplate: null, selectedVersion: null });
    try {
      const res = await apiFetch(
        `/api/template-store/marketplace/templates/${encodeURIComponent(slug)}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message =
          body?.error?.message ?? body?.error ?? `Failed to load template details (${res.status})`;
        set({
          detailLoading: false,
          detailError: typeof message === 'string' ? message : String(message),
        });
        return;
      }
      const data = await res.json();
      const payload = data.data ?? data;
      set({
        selectedTemplate: payload.template ?? null,
        selectedVersion: payload.version ?? null,
        detailLoading: false,
      });
    } catch (err) {
      set({
        detailLoading: false,
        detailError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  fetchCategories: async () => {
    try {
      const state = get();
      const params = new URLSearchParams();
      // Send type filter only when exactly one type selected
      if (state.selectedTypes.length === 1) {
        params.set('type', state.selectedTypes[0]);
      }

      const url = params.toString()
        ? `/api/template-store/marketplace/categories?${params.toString()}`
        : '/api/template-store/marketplace/categories';

      const res = await apiFetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const payload = data.data ?? data;
      set({ categories: payload.categories ?? [] });
    } catch (err) {
      console.warn(
        '[marketplace] Failed to fetch categories:',
        err instanceof Error ? err.message : String(err),
      );
    }
  },

  fetchFeatured: async () => {
    try {
      const res = await apiFetch('/api/template-store/marketplace/featured');
      if (!res.ok) return;
      const data = await res.json();
      const payload = data.data ?? data;
      set({ featured: payload.templates ?? payload ?? [] });
    } catch (err) {
      console.warn(
        '[marketplace] Failed to fetch featured:',
        err instanceof Error ? err.message : String(err),
      );
    }
  },

  setQuery: (q: string) => {
    set({ query: q, page: 1 });
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      get().fetchTemplates();
    }, 300);
  },

  // ── New multi-select actions ──────────────────────────────────────────────

  toggleType: (type: string) => {
    const current = get().selectedTypes;
    const next = current.includes(type) ? current.filter((t) => t !== type) : [...current, type];
    set({
      selectedTypes: next,
      templateType: deriveTemplateType(next),
      page: 1,
    });
    get().fetchTemplates();
  },

  toggleCategory: (cat: string) => {
    const current = get().selectedCategories;
    const next = current.includes(cat) ? current.filter((c) => c !== cat) : [...current, cat];
    set({
      selectedCategories: next,
      category: deriveCategory(next),
      page: 1,
    });
    get().fetchTemplates();
  },

  togglePublisher: (id: string) => {
    const current = get().selectedPublishers;
    const next = current.includes(id) ? current.filter((p) => p !== id) : [...current, id];
    set({ selectedPublishers: next, page: 1 });
    get().fetchTemplates();
  },

  clearPublisherFilters: () => {
    set({ selectedPublishers: [], page: 1 });
    get().fetchTemplates();
  },

  setSortField: (field: SortField) => {
    set({
      sortField: field,
      sort: deriveSortLegacy(field),
      page: 1,
    });
    get().fetchTemplates();
  },

  setSortDirection: (dir: SortDirection) => {
    set({ sortDirection: dir, page: 1 });
    get().fetchTemplates();
  },

  clearTypeFilters: () => {
    set({
      selectedTypes: [],
      templateType: null,
      page: 1,
    });
    get().fetchTemplates();
  },

  clearCategoryFilters: () => {
    set({
      selectedCategories: [],
      category: null,
      page: 1,
    });
    get().fetchTemplates();
  },

  // ── Backward-compat adapter actions ───────────────────────────────────────

  setCategory: (cat: string | null) => {
    const next = cat ? [cat] : [];
    set({
      selectedCategories: next,
      category: cat,
      page: 1,
    });
    get().fetchTemplates();
  },

  setTemplateType: (type: 'agent' | 'project' | null) => {
    const next = type ? [type] : [];
    set({
      selectedTypes: next,
      templateType: type,
      page: 1,
    });
    get().fetchTemplates();
  },

  setComplexity: (c: 'starter' | 'standard' | 'advanced' | null) => {
    set({ complexity: c, page: 1 });
    get().fetchTemplates();
  },

  setSort: (s: 'popular' | 'rating' | 'newest' | 'updated') => {
    // Map legacy sort values to new sortField
    let field: SortField;
    switch (s) {
      case 'popular':
        field = 'installCount';
        break;
      case 'newest':
      case 'updated':
        field = 'viewCount';
        break;
      case 'rating':
        field = 'installCount'; // no rating sort field — fallback to installs
        break;
      default:
        field = 'installCount';
    }
    set({
      sort: s,
      sortField: field,
      sortDirection: 'desc',
      page: 1,
    });
    get().fetchTemplates();
  },

  setPage: (p: number) => {
    set({ page: p });
    get().fetchTemplates();
  },

  resetFilters: () => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    set({
      query: '',
      selectedCategories: [],
      selectedTypes: [],
      selectedPublishers: [],
      category: null,
      templateType: null,
      complexity: null,
      sortField: 'installCount',
      sortDirection: 'desc',
      sort: 'popular',
      page: 1,
    });
    get().fetchTemplates();
  },

  // Install actions
  installProjectTemplate: async (input) => {
    set({ installLoading: true, installError: null, installResult: null });
    try {
      const result = await apiInstallProjectTemplate(input);
      set({
        installLoading: false,
        installResult: {
          project: result.project,
          applied: result.applied,
          entryAgentName: result.entryAgentName,
          provisioningRequired: result.provisioningRequired,
        },
      });
    } catch (err) {
      set({
        installLoading: false,
        installError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  previewAgentInstall: async (projectId, templateSlug, version) => {
    set({ agentPreviewLoading: true, agentPreviewError: null, agentPreview: null });
    try {
      const result = await apiPreviewAgentInstall(projectId, { templateSlug, version });
      set({
        agentPreviewLoading: false,
        agentPreview: {
          preview: result.preview,
          previewDigest: result.previewDigest,
          warnings: result.warnings,
        },
      });
    } catch (err) {
      set({
        agentPreviewLoading: false,
        agentPreviewError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  applyAgentInstall: async (projectId, templateSlug, version, previewDigest) => {
    set({ installLoading: true, installError: null, installResult: null });
    try {
      const result = await apiApplyAgentInstall(projectId, {
        templateSlug,
        version,
        previewDigest,
      });
      set({
        installLoading: false,
        installResult: {
          applied: result.applied,
          entryAgentName: result.entryAgentName,
          provisioningRequired: result.provisioningRequired,
        },
      });
    } catch (err) {
      set({
        installLoading: false,
        installError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  fetchUserProjects: async () => {
    set({ userProjectsLoading: true });
    try {
      const res = await apiFetch('/api/projects', { cache: 'no-store' });
      if (!res.ok) {
        set({ userProjectsLoading: false });
        return;
      }
      const data = await res.json();
      const projects = data.projects ?? data.data?.projects ?? [];
      set({
        userProjects: projects.map(
          (p: { id: string; name: string; slug: string; agentCount?: number }) => ({
            id: p.id,
            name: p.name,
            slug: p.slug,
            agentCount: p.agentCount ?? 0,
          }),
        ),
        userProjectsLoading: false,
      });
    } catch {
      set({ userProjectsLoading: false });
    }
  },

  resetInstallState: () => {
    set({
      installLoading: false,
      installError: null,
      installResult: null,
      agentPreview: null,
      agentPreviewLoading: false,
      agentPreviewError: null,
    });
  },
}));

// ─── Selectors ──────────────────────────────────────────────────────────────

export const selectTemplates = (s: MarketplaceState) => s.templates;
export const selectMarketplaceTotal = (s: MarketplaceState) => s.total;
export const selectMarketplaceLoading = (s: MarketplaceState) => s.loading;
export const selectMarketplaceError = (s: MarketplaceState) => s.error;
export const selectCategories = (s: MarketplaceState) => s.categories;
export const selectFeatured = (s: MarketplaceState) => s.featured;
export const selectSelectedTemplate = (s: MarketplaceState) => s.selectedTemplate;
export const selectSelectedVersion = (s: MarketplaceState) => s.selectedVersion;
export const selectDetailLoading = (s: MarketplaceState) => s.detailLoading;
export const selectDetailError = (s: MarketplaceState) => s.detailError;
export const selectMarketplaceQuery = (s: MarketplaceState) => s.query;
/** @deprecated Use selectSelectedCategories instead */
export const selectMarketplaceCategory = (s: MarketplaceState) => s.category;
/** @deprecated Use selectSelectedTypes instead */
export const selectMarketplaceType = (s: MarketplaceState) => s.templateType;
export const selectMarketplaceComplexity = (s: MarketplaceState) => s.complexity;
/** @deprecated Use selectSortField + selectSortDirection instead */
export const selectMarketplaceSort = (s: MarketplaceState) => s.sort;
export const selectMarketplacePage = (s: MarketplaceState) => s.page;
export const selectInstallLoading = (s: MarketplaceState) => s.installLoading;
export const selectInstallError = (s: MarketplaceState) => s.installError;
export const selectInstallResult = (s: MarketplaceState) => s.installResult;
export const selectAgentPreview = (s: MarketplaceState) => s.agentPreview;
export const selectAgentPreviewLoading = (s: MarketplaceState) => s.agentPreviewLoading;
export const selectAgentPreviewError = (s: MarketplaceState) => s.agentPreviewError;
export const selectUserProjects = (s: MarketplaceState) => s.userProjects;
export const selectUserProjectsLoading = (s: MarketplaceState) => s.userProjectsLoading;

// New multi-select selectors
export const selectSelectedTypes = (s: MarketplaceState) => s.selectedTypes;
export const selectSelectedCategories = (s: MarketplaceState) => s.selectedCategories;
export const selectSelectedPublishers = (s: MarketplaceState) => s.selectedPublishers;
export const selectSortField = (s: MarketplaceState) => s.sortField;
export const selectSortDirection = (s: MarketplaceState) => s.sortDirection;
