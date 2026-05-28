/**
 * HTTP Async Channels API Client
 *
 * Functions for webhook subscription management against the runtime API.
 */

import { apiFetch } from '../lib/api-client';
import { getRuntimeUrl } from '../config/runtime';

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `Request failed (${response.status})`);
  }
  return response.json();
}

// =============================================================================
// TYPES
// =============================================================================

export interface WebhookSubscription {
  id: string;
  channelConnectionId: string;
  callbackUrl: string;
  events: string[];
  status: 'active' | 'paused' | 'deactivated';
  description: string | null;
  failureCount: number;
  lastDeliveryAt: string | null;
  agentId: string | null;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSubscriptionInput {
  callback_url: string;
  project_id: string;
  agent_id?: string;
  deployment_id?: string;
  events?: string[];
  description?: string;
}

export interface CreateSubscriptionResponse {
  subscription_id: string;
  callback_url: string;
  events: string[];
  secret: string;
  status: string;
  created_at: string;
  _note: string;
}

export interface WebhookDelivery {
  id: string;
  eventType: string;
  status: string;
  httpStatus: number | null;
  attempts: number;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface SendTestResponse {
  message_id: string;
  session_key: string;
  status: string;
  _note: string;
}

// =============================================================================
// API
// =============================================================================

const BASE = `${getRuntimeUrl()}/api/v1/channels/http-async`;

export async function fetchSubscriptions(
  projectId: string,
): Promise<{ subscriptions: WebhookSubscription[] }> {
  const response = await apiFetch(`${BASE}/subscriptions?project_id=${projectId}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<CreateSubscriptionResponse> {
  const response = await apiFetch(`${BASE}/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse(response);
}

export async function updateSubscription(
  id: string,
  input: { callback_url?: string; events?: string[]; status?: string },
): Promise<WebhookSubscription> {
  const response = await apiFetch(`${BASE}/subscriptions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse(response);
}

export async function regenerateSecret(id: string): Promise<{ secret: string }> {
  const response = await apiFetch(`${BASE}/subscriptions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ regenerate_secret: true }),
  });
  return handleResponse(response);
}

export async function deleteSubscription(id: string): Promise<{ success: boolean }> {
  const response = await apiFetch(`${BASE}/subscriptions/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function sendTestMessage(input: {
  subscription_id: string;
  message: string;
}): Promise<SendTestResponse> {
  const response = await apiFetch(`${BASE}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return handleResponse(response);
}

export async function fetchDeliveries(
  subscriptionId: string,
  limit = 20,
): Promise<{ deliveries: WebhookDelivery[] }> {
  const response = await apiFetch(
    `${BASE}/subscriptions/${subscriptionId}/deliveries?limit=${limit}`,
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );
  return handleResponse(response);
}
