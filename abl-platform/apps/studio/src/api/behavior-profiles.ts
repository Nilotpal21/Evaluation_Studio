import { apiFetch, handleResponse } from '../lib/api-client';
import type { ConversationBehaviorData } from '../store/agent-detail-store';

export interface BehaviorProfileSummary {
  name: string;
  priority: number;
  whenExpression: string;
  dslContent: string;
  overrideCategories: string[];
  usedByAgents: string[];
  updatedAt: string;
  parseErrors?: string[];
}

export interface BehaviorProfileDetail {
  name: string;
  priority: number;
  whenExpression: string;
  conversationBehavior?: ConversationBehaviorData;
  overrideCategories: string[];
  usedByAgents: string[];
  dslContent: string;
  updatedAt?: string;
  parseErrors: string[];
}

interface ListBehaviorProfilesResponse {
  success: true;
  profiles: BehaviorProfileSummary[];
}

interface BehaviorProfileResponse {
  success: true;
  profile: BehaviorProfileDetail;
}

interface SaveBehaviorProfileBody {
  mode: 'raw' | 'structured';
  dslContent?: string;
  baseDslContent?: string;
  name?: string;
  priority?: number;
  whenExpression?: string;
  conversationBehavior?: ConversationBehaviorData;
}

function encodeProfileName(name: string): string {
  return encodeURIComponent(name);
}

export async function listBehaviorProfiles(projectId: string): Promise<BehaviorProfileSummary[]> {
  const response = await apiFetch(`/api/projects/${projectId}/behavior-profiles`);
  const data = await handleResponse<ListBehaviorProfilesResponse>(response);
  return data.profiles;
}

export async function getBehaviorProfile(
  projectId: string,
  profileName: string,
): Promise<BehaviorProfileDetail> {
  const response = await apiFetch(
    `/api/projects/${projectId}/behavior-profiles/${encodeProfileName(profileName)}`,
  );
  const data = await handleResponse<BehaviorProfileResponse>(response);
  return data.profile;
}

export async function createBehaviorProfile(
  projectId: string,
  body: SaveBehaviorProfileBody,
): Promise<BehaviorProfileDetail> {
  const response = await apiFetch(`/api/projects/${projectId}/behavior-profiles`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await handleResponse<BehaviorProfileResponse>(response);
  return data.profile;
}

export async function updateBehaviorProfile(
  projectId: string,
  profileName: string,
  body: SaveBehaviorProfileBody,
): Promise<BehaviorProfileDetail> {
  const response = await apiFetch(
    `/api/projects/${projectId}/behavior-profiles/${encodeProfileName(profileName)}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  const data = await handleResponse<BehaviorProfileResponse>(response);
  return data.profile;
}

export async function deleteBehaviorProfile(projectId: string, profileName: string): Promise<void> {
  const response = await apiFetch(
    `/api/projects/${projectId}/behavior-profiles/${encodeProfileName(profileName)}`,
    {
      method: 'DELETE',
    },
  );
  await handleResponse<{ success: boolean }>(response);
}
