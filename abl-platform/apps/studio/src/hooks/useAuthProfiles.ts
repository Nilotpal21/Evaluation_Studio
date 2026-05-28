/**
 * useAuthProfiles Hook
 *
 * SWR-based hook for fetching and managing the auth profiles list.
 * Supports filtering, sorting, and cursor-based pagination.
 */

'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import type {
  AuthProfileSummary,
  AuthProfileDetail,
  ListAuthProfilesParams,
} from '../api/auth-profiles';

// =============================================================================
// KEY BUILDER (exported for testing)
// =============================================================================

export function buildAuthProfilesKey(
  projectId: string | null,
  params: ListAuthProfilesParams = {},
): string | null {
  if (!projectId) return null;
  const base = `/api/projects/${encodeURIComponent(projectId)}/auth-profiles`;
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) searchParams.append(key, String(v));
    } else {
      searchParams.set(key, String(value));
    }
  }
  const qs = searchParams.toString();
  return qs ? `${base}?${qs}` : base;
}

// =============================================================================
// TYPES
// =============================================================================

interface ListResponse {
  success: boolean;
  data: AuthProfileSummary[];
  pagination: { nextCursor: string | null; total: number };
}

interface UseAuthProfilesReturn {
  profiles: AuthProfileSummary[];
  total: number;
  nextCursor: string | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

// =============================================================================
// LIST HOOK
// =============================================================================

export function useAuthProfiles(
  projectId: string | null,
  params: ListAuthProfilesParams = {},
): UseAuthProfilesReturn {
  const paramsKey = JSON.stringify(params);
  const key = useMemo(
    () => buildAuthProfilesKey(projectId, JSON.parse(paramsKey)),
    [projectId, paramsKey],
  );

  const { data, error, isLoading, mutate } = useSWR<ListResponse>(key, {
    keepPreviousData: true,
  });

  return {
    profiles: data?.data ?? [],
    total: data?.pagination?.total ?? 0,
    nextCursor: data?.pagination?.nextCursor ?? null,
    isLoading,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}

// =============================================================================
// WORKSPACE LIST HOOK
// =============================================================================

import {
  fetchWorkspaceAuthProfiles,
  type AuthType,
  type AuthProfileStatus,
} from '../api/auth-profiles';

export function buildWorkspaceAuthProfilesKey(
  isAuthenticated: boolean,
  params: { search?: string; authType?: AuthType | ''; status?: AuthProfileStatus | '' },
): string | null {
  if (!isAuthenticated) return null;
  const searchParams = new URLSearchParams();
  if (params.search) searchParams.set('search', params.search);
  if (params.authType) searchParams.set('authType', params.authType);
  if (params.status) searchParams.set('status', params.status);
  const qs = searchParams.toString();
  const base = '/api/admin/auth-profiles';
  return qs ? `${base}?${qs}` : base;
}

export function useWorkspaceAuthProfiles(
  isAuthenticated: boolean,
  params: { search?: string; authType?: AuthType | ''; status?: AuthProfileStatus | '' },
): UseAuthProfilesReturn {
  const paramsKey = JSON.stringify(params);
  const key = useMemo(
    () => buildWorkspaceAuthProfilesKey(isAuthenticated, JSON.parse(paramsKey)),
    [isAuthenticated, paramsKey],
  );

  const { data, error, isLoading, mutate } = useSWR<ListResponse>(
    key,
    () =>
      fetchWorkspaceAuthProfiles({
        search: params.search || undefined,
        authType: params.authType || undefined,
        status: params.status || undefined,
      }),
    { keepPreviousData: true },
  );

  return {
    profiles: data?.data ?? [],
    total: data?.pagination?.total ?? 0,
    nextCursor: data?.pagination?.nextCursor ?? null,
    isLoading,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}

// =============================================================================
// SINGLE PROFILE HOOK
// =============================================================================

interface UseAuthProfileReturn {
  profile: AuthProfileDetail | null;
  isLoading: boolean;
  error: string | null;
  /** HTTP status from the last failed fetch (e.g. 404 when the profile was deleted). */
  errorStatus: number | null;
  refresh: () => void;
}

export function useAuthProfile(
  projectId: string | null,
  profileId: string | null,
): UseAuthProfileReturn {
  const key =
    projectId && profileId
      ? `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/${encodeURIComponent(profileId)}`
      : null;

  const { data, error, isLoading, mutate } = useSWR<{ success: boolean; data: AuthProfileDetail }>(
    key,
    {
      // Don't retry or revalidate on focus for a profile that's permanently gone.
      // Without this, SWR keeps re-fetching after a profile is deleted (consumer
      // closes the slideover async), producing a continuous 404 loop in the
      // network tab on every tab focus or component re-render.
      shouldRetryOnError: (err: unknown) =>
        !(err && typeof err === 'object' && (err as { statusCode?: number }).statusCode === 404),
      revalidateOnFocus: false,
    },
  );

  const errorStatus =
    error &&
    typeof error === 'object' &&
    typeof (error as { statusCode?: number }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : null;

  return {
    profile: data?.data ?? null,
    isLoading,
    error: error ? String(error) : null,
    errorStatus,
    refresh: () => mutate(),
  };
}
