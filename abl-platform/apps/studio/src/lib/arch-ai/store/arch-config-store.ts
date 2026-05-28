/**
 * Arch Config Store
 *
 * Client-side Zustand store for Arch AI assistant configuration status.
 * Fetches from `/api/arch/status` on mount and `/api/arch/config` when
 * admin opens settings.
 *
 * No persist middleware -- config should always be fetched fresh from the server.
 */

import { create } from 'zustand';
import { apiFetch } from '@/lib/api-client';
import type { HyperParameter } from '@/components/admin/HyperParameterForm';

export type { HyperParameter };

// =============================================================================
// TYPES
// =============================================================================

export interface ArchStatus {
  configured: boolean;
  model: string | null;
  provider: string | null;
  source: 'tenant' | 'platform' | 'none';
  resolutionPath?:
    | 'platform'
    | 'auto_platform'
    | 'model_hub'
    | 'auto_model_hub'
    | 'direct_api_key'
    | 'auth_profile'
    | 'none';
  requestedSource?: 'platform' | 'model_hub' | 'direct_api_key' | 'auth_profile' | 'auto';
  usedFallback?: boolean;
  lastValidatedAt: string | null;
  error: string | null;
}

export interface ArchConfigData {
  modelId: string;
  provider: string;
  tenantModelId: string | null;
  authProfileId?: string | null;
  usePlatformCredits: boolean;
  maxTokensChat: number;
  maxTokensGenerate: number;
  temperature: number;
  rateLimitRpm: number;
  rateLimitRph: number;
  authType: string;
  customHeaders: Record<string, string> | null;
  hyperParameters: Record<string, unknown>;
  lastValidatedAt: string | null;
  _v: number;
  hasApiKey: boolean;
  hasEndpoint: boolean;
}

export interface ModelOption {
  modelId: string;
  displayName: string;
  provider: string;
  tier: 'fast' | 'balanced' | 'powerful';
  supportsTools: boolean;
  recommended: boolean;
  contextWindow: number;
  maxOutputTokens?: number;
  capabilities?: string[];
  hyperParameters?: HyperParameter[];
}

export interface KeyValidationResult {
  valid: boolean | null;
  message: string;
}

interface ArchConfigState {
  status: ArchStatus | null;
  config: ArchConfigData | null;
  models: { recommended: ModelOption[]; other: ModelOption[] } | null;
  isLoading: boolean;
  error: string | null;
  keyValidation: KeyValidationResult | null;
  isValidatingKey: boolean;

  fetchStatus: () => Promise<void>;
  fetchConfig: () => Promise<void>;
  fetchModels: () => Promise<void>;
  updateConfig: (
    updates: Partial<ArchConfigData> & { apiKey?: string; endpoint?: string },
  ) => Promise<boolean>;
  validateApiKey: (provider: string, apiKey: string) => Promise<KeyValidationResult>;
}

// =============================================================================
// STORE
// =============================================================================

export const useArchConfigStore = create<ArchConfigState>((set) => ({
  status: null,
  config: null,
  models: null,
  isLoading: false,
  error: null,
  keyValidation: null,
  isValidatingKey: false,

  fetchStatus: async () => {
    try {
      const res = await apiFetch('/api/arch/status');
      if (!res.ok) throw new Error('Failed to fetch Arch status');
      const json = await res.json();
      // The status route wraps in { success, data }
      set({ status: json.data ?? json, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch status';
      set({ error: message });
    }
  },

  fetchConfig: async () => {
    set({ isLoading: true });
    try {
      const res = await apiFetch('/api/arch/config');
      if (!res.ok) throw new Error('Failed to fetch Arch config');
      const { data } = await res.json();
      set({
        config: data
          ? {
              modelId: data.modelId,
              provider: data.provider,
              tenantModelId: data.tenantModelId ?? null,
              authProfileId: data.authProfileId ?? null,
              usePlatformCredits: data.usePlatformCredits,
              maxTokensChat: data.maxTokensChat,
              maxTokensGenerate: data.maxTokensGenerate,
              temperature: data.temperature,
              rateLimitRpm: data.rateLimitRpm,
              rateLimitRph: data.rateLimitRph,
              authType: data.authType ?? 'api_key',
              customHeaders: data.customHeaders ?? null,
              hyperParameters: data.hyperParameters ?? {},
              lastValidatedAt: data.lastValidatedAt ?? null,
              _v: data._v ?? 1,
              hasApiKey: Boolean(data.hasApiKey),
              hasEndpoint: Boolean(data.hasEndpoint),
            }
          : null,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch config';
      set({ isLoading: false, error: message });
    }
  },

  fetchModels: async () => {
    try {
      const res = await apiFetch('/api/arch/models');
      if (!res.ok) throw new Error('Failed to fetch models');
      const { data } = await res.json();
      set({ models: data, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch models';
      set({ error: message });
    }
  },

  updateConfig: async (updates) => {
    set({ isLoading: true });
    try {
      const res = await apiFetch('/api/arch/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error('Failed to update config');
      set({ isLoading: false, error: null });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update config';
      set({ isLoading: false, error: message });
      return false;
    }
  },

  validateApiKey: async (provider: string, apiKey: string) => {
    set({ isValidatingKey: true, keyValidation: null });
    try {
      const res = await apiFetch('/api/arch/validate-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey }),
      });
      if (!res.ok) throw new Error('Validation request failed');
      const { data } = await res.json();
      const result: KeyValidationResult = { valid: data.valid, message: data.message };
      set({ keyValidation: result, isValidatingKey: false });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Validation failed';
      const result: KeyValidationResult = { valid: null, message };
      set({ keyValidation: result, isValidatingKey: false });
      return result;
    }
  },
}));
