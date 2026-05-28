/**
 * Voice API Client
 *
 * Functions for voice channel provisioning against the runtime API.
 */

import { apiFetch, handleResponse } from '../lib/api-client';
import { getRuntimeUrl } from '../config/runtime';

// =============================================================================
// TYPES
// =============================================================================

export interface TwilioPhoneNumber {
  sid: string;
  phoneNumber: string;
  friendlyName: string;
}

export interface AvailablePhoneNumber {
  phoneNumber: string;
  friendlyName: string;
  region: string;
  isoCountry: string;
}

// =============================================================================
// API
// =============================================================================

export async function listTwilioPhoneNumbers(): Promise<TwilioPhoneNumber[]> {
  const response = await apiFetch(`${getRuntimeUrl()}/api/v1/voice/twilio/phone-numbers`, {
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await handleResponse<{ phoneNumbers?: TwilioPhoneNumber[] }>(response);
  return data.phoneNumbers ?? [];
}

export async function searchAvailableNumbers(params: {
  countryCode?: string;
  numberType?: 'local' | 'tollFree';
  areaCode?: string;
}): Promise<AvailablePhoneNumber[]> {
  const query = new URLSearchParams();
  if (params.countryCode) query.set('countryCode', params.countryCode);
  if (params.numberType) query.set('numberType', params.numberType);
  if (params.areaCode) query.set('areaCode', params.areaCode);

  const response = await apiFetch(
    `${getRuntimeUrl()}/api/v1/voice/twilio/available-numbers?${query.toString()}`,
    { headers: { 'Content-Type': 'application/json' } },
  );
  const data = await handleResponse<{ numbers?: AvailablePhoneNumber[] }>(response);
  return data.numbers ?? [];
}

export async function purchasePhoneNumber(phoneNumber: string): Promise<TwilioPhoneNumber> {
  const response = await apiFetch(`${getRuntimeUrl()}/api/v1/voice/twilio/purchase-number`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber }),
  });
  const data = await handleResponse<{ phoneNumber?: TwilioPhoneNumber }>(response);
  if (!data.phoneNumber) throw new Error('No phone number in response');
  return data.phoneNumber;
}

export async function fetchSbcAddresses(projectId: string): Promise<string[]> {
  try {
    const res = await apiFetch(
      `${getRuntimeUrl()}/api/projects/${projectId}/channel-connections/sbc-address`,
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.sbcAddresses ?? [];
  } catch {
    return [];
  }
}
