/**
 * Module Store
 *
 * Manages module catalog, dependencies, releases, and publish/import state with Zustand.
 */

import { create } from 'zustand';
import { mutate } from 'swr';
import {
  listCatalog,
  listDependencies,
  listReleases,
  fetchModulePointers,
  publishRelease as apiPublishRelease,
  confirmImport,
  removeDependency as apiRemoveDependency,
  type CatalogEntry,
  type ModuleContract,
  type ModuleDependency,
  type ModuleRelease,
  type ImportPreview,
  type PromotePointer,
} from '../api/modules';

// =============================================================================
// TYPES — Re-exported from API layer (single source of truth)
// =============================================================================
// The store assigns API response data directly without transformation,
// so store types must match the API response shapes exactly.
// Re-exports preserve backward-compatible names for any future consumers.

export type { CatalogEntry, ModuleContract, ModuleDependency, ModuleRelease };
export type ModuleCatalogEntry = CatalogEntry;
export type ModuleEnvironmentPointer = PromotePointer;
export type ImportPreviewResult = ImportPreview;

// =============================================================================
// STORE
// =============================================================================

interface ModuleState {
  // Catalog
  catalogModules: ModuleCatalogEntry[];
  catalogLoading: boolean;

  // Dependencies (for current consumer project)
  dependencies: ModuleDependency[];
  dependenciesLoading: boolean;

  // Releases (for current module project)
  releases: ModuleRelease[];
  releasesLoading: boolean;
  pointers: ModuleEnvironmentPointer[];

  // Publish state
  publishDialogOpen: boolean;
  publishInProgress: boolean;

  // Import state
  importDialogOpen: boolean;
  importPreview: ImportPreviewResult | null;

  // Actions
  loadCatalog: (projectId: string) => Promise<void>;
  loadDependencies: (projectId: string) => Promise<void>;
  loadReleases: (moduleProjectId: string) => Promise<void>;
  publishRelease: (
    projectId: string,
    params: { version: string; releaseNotes?: string; promoteToEnvironment?: string },
  ) => Promise<void>;
  importModule: (
    projectId: string,
    params: {
      moduleProjectId: string;
      selector: { type: 'version' | 'environment'; value: string };
      alias: string;
      resolvedReleaseId: string;
      configOverrides?: Record<string, string>;
    },
  ) => Promise<void>;
  removeDependency: (projectId: string, dependencyId: string) => Promise<void>;
  setPublishDialogOpen: (open: boolean) => void;
  setImportDialogOpen: (open: boolean) => void;
  setImportPreview: (preview: ImportPreviewResult | null) => void;
  reset: () => void;
}

const initialState = {
  catalogModules: [],
  catalogLoading: false,
  dependencies: [],
  dependenciesLoading: false,
  releases: [],
  releasesLoading: false,
  pointers: [],
  publishDialogOpen: false,
  publishInProgress: false,
  importDialogOpen: false,
  importPreview: null,
};

export const useModuleStore = create<ModuleState>((set) => ({
  ...initialState,

  loadCatalog: async (projectId) => {
    set({ catalogLoading: true });
    try {
      const json = await listCatalog(projectId);
      set({ catalogModules: json.data ?? [], catalogLoading: false });
    } catch (err) {
      console.error('[Module Store] Failed to load catalog:', err);
      set({ catalogLoading: false });
    }
  },

  loadDependencies: async (projectId) => {
    set({ dependenciesLoading: true });
    try {
      const json = await listDependencies(projectId);
      set({ dependencies: json.data ?? [], dependenciesLoading: false });
    } catch (err) {
      console.error('[Module Store] Failed to load dependencies:', err);
      set({ dependenciesLoading: false });
    }
  },

  loadReleases: async (moduleProjectId) => {
    set({ releasesLoading: true });
    try {
      const [releasesJson, pointersJson] = await Promise.all([
        listReleases(moduleProjectId),
        fetchModulePointers(moduleProjectId).catch(() => ({ data: [] as PromotePointer[] })),
      ]);
      set({
        releases: releasesJson.data ?? [],
        pointers: pointersJson.data ?? [],
        releasesLoading: false,
      });
    } catch (err) {
      console.error('[Module Store] Failed to load releases:', err);
      set({ releasesLoading: false });
    }
  },

  publishRelease: async (projectId, params) => {
    set({ publishInProgress: true });
    try {
      await apiPublishRelease(projectId, params);
      set({
        publishInProgress: false,
        publishDialogOpen: false,
      });
      // Invalidate SWR caches for releases and catalog
      void mutate(
        (key: unknown) =>
          typeof key === 'string' &&
          (key.includes('/module/releases') || key.includes('/module-catalog')),
        undefined,
        { revalidate: true },
      );
    } catch (err) {
      console.error('[Module Store] Failed to publish release:', err);
      set({ publishInProgress: false });
      throw err;
    }
  },

  importModule: async (projectId, params) => {
    try {
      const json = await confirmImport(projectId, params);
      set((state) => ({
        dependencies: [...state.dependencies, json.data],
        importDialogOpen: false,
        importPreview: null,
      }));
      // Invalidate SWR caches for dependencies and topology
      void mutate(
        (key: unknown) =>
          typeof key === 'string' &&
          (key.includes('/module-dependencies') || key.includes('/topology')),
        undefined,
        { revalidate: true },
      );
    } catch (err) {
      console.error('[Module Store] Failed to import module:', err);
      throw err;
    }
  },

  removeDependency: async (projectId, dependencyId) => {
    try {
      await apiRemoveDependency(projectId, dependencyId);
      set((state) => ({
        dependencies: state.dependencies.filter((d) => d.id !== dependencyId),
      }));
      // Invalidate SWR caches for dependencies and topology
      void mutate(
        (key: unknown) =>
          typeof key === 'string' &&
          (key.includes('/module-dependencies') || key.includes('/topology')),
        undefined,
        { revalidate: true },
      );
    } catch (err) {
      console.error('[Module Store] Failed to remove dependency:', err);
      throw err;
    }
  },

  setPublishDialogOpen: (publishDialogOpen) => set({ publishDialogOpen }),

  setImportDialogOpen: (importDialogOpen) => set({ importDialogOpen }),

  setImportPreview: (importPreview) => set({ importPreview }),

  reset: () => set(initialState),
}));
