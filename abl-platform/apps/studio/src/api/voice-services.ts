/**
 * Voice Services API Client
 *
 * Functions for managing tenant-level S2S (Speech-to-Speech) service instances.
 */

import { apiFetch, handleResponse } from '../lib/api-client';
import { getRuntimeUrl } from '../config/runtime';
import { type S2SProviderType } from '@agent-platform/config/constants/voice-providers';

// =============================================================================
// TYPES
// =============================================================================

export type S2SProvider = S2SProviderType;
export type ListedS2SProvider = S2SProviderType | `s2s:${string}`;

export interface VoiceServiceInstance {
  id: string;
  displayName: string;
  serviceType: ListedS2SProvider;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateVoiceServiceInput {
  displayName: string;
  serviceType: S2SProvider;
  apiKey: string;
  config?: Record<string, unknown>;
  isDefault?: boolean;
}

export interface UpdateVoiceServiceInput {
  displayName?: string;
  apiKey?: string;
  config?: Record<string, unknown>;
  isDefault?: boolean;
  isActive?: boolean;
}

// =============================================================================
// API
// =============================================================================

/**
 * List all S2S service instances for the current tenant
 */
export async function listVoiceServices(tenantId: string): Promise<VoiceServiceInstance[]> {
  const response = await apiFetch(`${getRuntimeUrl()}/api/tenants/${tenantId}/service-instances`, {
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await handleResponse<{ success: boolean; instances: VoiceServiceInstance[] }>(
    response,
  );

  // Preserve forward compatibility for newer runtime-backed `s2s:*` providers
  // even before Studio's registry has explicit first-class metadata for them.
  return (data.instances || []).filter((instance) => instance.serviceType.startsWith('s2s:'));
}

/**
 * Get a specific S2S service instance by ID
 */
export async function getVoiceService(
  tenantId: string,
  instanceId: string,
): Promise<VoiceServiceInstance> {
  const response = await apiFetch(
    `${getRuntimeUrl()}/api/tenants/${tenantId}/service-instances/${instanceId}`,
    { headers: { 'Content-Type': 'application/json' } },
  );
  const data = await handleResponse<{ success: boolean; instance: VoiceServiceInstance }>(response);
  if (!data.instance) throw new Error('No service instance in response');
  return data.instance;
}

/**
 * Create a new S2S service instance
 */
export async function createVoiceService(
  tenantId: string,
  input: CreateVoiceServiceInput,
): Promise<VoiceServiceInstance> {
  const response = await apiFetch(`${getRuntimeUrl()}/api/tenants/${tenantId}/service-instances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = await handleResponse<{ success: boolean; instance: VoiceServiceInstance }>(response);
  if (!data.instance) throw new Error('No service instance in response');
  return data.instance;
}

/**
 * Update an existing S2S service instance
 */
export async function updateVoiceService(
  tenantId: string,
  instanceId: string,
  input: UpdateVoiceServiceInput,
): Promise<VoiceServiceInstance> {
  const response = await apiFetch(
    `${getRuntimeUrl()}/api/tenants/${tenantId}/service-instances/${instanceId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  const data = await handleResponse<{ success: boolean; instance: VoiceServiceInstance }>(response);
  if (!data.instance) throw new Error('No service instance in response');
  return data.instance;
}

/**
 * Delete an S2S service instance
 */
export async function deleteVoiceService(tenantId: string, instanceId: string): Promise<void> {
  const response = await apiFetch(
    `${getRuntimeUrl()}/api/tenants/${tenantId}/service-instances/${instanceId}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    },
  );
  await handleResponse<{ success: boolean; deleted: string }>(response);
}
