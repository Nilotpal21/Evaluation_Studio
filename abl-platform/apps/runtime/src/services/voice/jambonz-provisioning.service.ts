import { createLogger } from '@abl/compiler/platform';
import { getConfig } from '../../config/index.js';

const log = createLogger('jambonz-provisioning');

export interface JambonzConfig {
  baseApiUrl?: string;
  accountSid?: string;
  apiKey?: string;
  voipCarrierSid?: string;
  serviceProviderId?: string;
  serviceProviderApiKey?: string;
  sbcAddress?: string;
}

export interface CreateApplicationInput {
  name: string;
  webhookUrl: string;
  asrVendor?: string;
  asrLanguage?: string;
  asrRegion?: string;
  ttsVendor?: string;
  ttsLanguage?: string;
  ttsVoice?: string;
  ttsRegion?: string;
  fallbackAsrVendor?: string;
  fallbackAsrLanguage?: string;
  fallbackAsrRegion?: string;
  fallbackTtsVendor?: string;
  fallbackTtsLanguage?: string;
  fallbackTtsVoice?: string;
  fallbackTtsRegion?: string;
}

export interface AddPhoneNumberInput {
  phoneNumber: string;
  applicationSid: string;
  voipCarrierSid?: string;
}

export interface SpeechCredentialInput {
  vendor: string;
  apiKey?: string; // plaintext primary credential — often API key, sometimes service JSON or access key id
  label: string; // tenant-scoped: 't:{tenantId}'
  useForStt: boolean;
  useForTts: boolean;
  modelId?: string;
  secretAccessKey?: string;
  awsRegion?: string;
  roleArn?: string;
  region?: string;
  clientId?: string;
  clientKey?: string;
  clientSecret?: string;
  secret?: string;
  nuanceSttUri?: string;
  nuanceTtsUri?: string;
  customSttEndpoint?: string;
  customSttEndpointUrl?: string;
  sttApiKey?: string;
  sttRegion?: string;
  instanceId?: string;
  rivaServerUri?: string;
  cobaltServerUri?: string;
  sttModelId?: string;
  engineVersion?: string;
  serviceVersion?: string;
  speechmaticsSttUri?: string;
  userId?: string;
  voiceEngine?: string;
  houndifyServerUri?: string;
  authToken?: string;
  customTtsUrl?: string;
  customTtsStreamingUrl?: string;
  customSttUrl?: string | null;
  apiUri?: string;
  options?: Record<string, unknown>;
}

export interface CreateVoipCarrierInput {
  name: string;
  accountSid?: string;
}

export interface AddSipGatewayInput {
  voipCarrierSid: string;
  ipv4: string;
  port?: number;
  netmask?: number;
  protocol?: string;
  inbound?: boolean;
  outbound?: boolean;
}

/** Raw response from Jambonz supportedLanguagesAndVoices endpoint */
interface JambonzSpeechOptionsRaw {
  tts?: Array<{ value: string; name: string; voices?: Array<{ value: string; name: string }> }>;
  stt?: Array<{ value: string; name: string }>;
}

/** Normalized speech options returned to callers */
export interface JambonzSpeechOptions {
  tts: Array<{ code: string; name: string; voices: Array<{ value: string; name: string }> }>;
  stt: Array<{ code: string; name: string }>;
}

export interface JambonzSpeechCredentialRecord {
  speech_credential_sid: string;
  vendor?: string;
  label?: string;
}

export interface JambonzSpeechCredentialTestStatus {
  status: 'ok' | 'fail' | 'not tested' | string;
  reason?: string;
}

export interface JambonzSpeechCredentialTestResult {
  tts: JambonzSpeechCredentialTestStatus;
  stt: JambonzSpeechCredentialTestStatus;
}

export interface SpeechOptionsLookupInput {
  label?: string;
}

export class JambonzProvisioningService {
  constructor(private readonly cfg: JambonzConfig) {}

  private assertConfigured(): void {
    if (!this.cfg.baseApiUrl || !this.cfg.accountSid || !this.cfg.apiKey) {
      throw new Error('Jambonz not configured: missing baseApiUrl, accountSid, or apiKey');
    }
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.cfg.apiKey}`,
    };
  }

  private async jambonzFetch<T>(path: string, options: RequestInit): Promise<T> {
    const url = `${this.cfg.baseApiUrl}${path}`;
    const res = await fetch(url, { ...options, headers: this.headers() });
    if (!res.ok) {
      const body = await res.text().catch((e) => {
        log.debug('Could not read error response body', { err: e });
        return '';
      });
      throw new Error(`Jambonz API error ${res.status} ${path}: ${body}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private assertSpConfigured(): void {
    if (!this.cfg.baseApiUrl || !this.cfg.serviceProviderId || !this.cfg.serviceProviderApiKey) {
      throw new Error(
        'Jambonz Service Provider not configured: missing baseApiUrl, serviceProviderId, or serviceProviderApiKey. ' +
          'BYOC SIP requires JAMBONZ_SERVICE_PROVIDER_ID and JAMBONZ_SERVICE_PROVIDER_API_KEY.',
      );
    }
  }

  private spHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.cfg.serviceProviderApiKey}`,
    };
  }

  private async jambonzSpFetch<T>(path: string, options: RequestInit): Promise<T> {
    const url = `${this.cfg.baseApiUrl}${path}`;
    const res = await fetch(url, { ...options, headers: this.spHeaders() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Jambonz SP API error ${res.status} ${path}: ${body}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  async createApplication(input: CreateApplicationInput): Promise<string> {
    this.assertConfigured();
    const payload: Record<string, unknown> = {
      name: input.name,
      account_sid: this.cfg.accountSid,
      call_hook: { url: input.webhookUrl, method: 'POST' },
      call_status_hook: { url: input.webhookUrl, method: 'POST' },
    };
    if (input.asrVendor) payload.speech_recognizer_vendor = input.asrVendor;
    if (input.asrLanguage) payload.speech_recognizer_language = input.asrLanguage;
    if (input.asrRegion) payload.speech_recognizer_label = input.asrRegion;
    if (input.ttsVendor) payload.speech_synthesis_vendor = input.ttsVendor;
    if (input.ttsLanguage) payload.speech_synthesis_language = input.ttsLanguage;
    if (input.ttsVoice) payload.speech_synthesis_voice = input.ttsVoice;
    if (input.ttsRegion) payload.speech_synthesis_label = input.ttsRegion;
    if (input.fallbackAsrVendor) {
      payload.fallback_speech_recognizer_vendor = input.fallbackAsrVendor;
      payload.fallback_speech_recognizer_language = input.fallbackAsrLanguage ?? null;
      payload.fallback_speech_recognizer_label = input.fallbackAsrRegion ?? null;
    }
    if (input.fallbackTtsVendor) {
      payload.fallback_speech_synthesis_vendor = input.fallbackTtsVendor;
      payload.fallback_speech_synthesis_language = input.fallbackTtsLanguage ?? null;
      payload.fallback_speech_synthesis_voice = input.fallbackTtsVoice ?? null;
      payload.fallback_speech_synthesis_label = input.fallbackTtsRegion ?? null;
    }
    const hasFallback = Boolean(input.fallbackAsrVendor || input.fallbackTtsVendor);
    payload.use_for_fallback_speech = hasFallback ? 1 : 0;

    const result = await this.jambonzFetch<{ sid: string }>('/Applications', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    log.info('Jambonz application created', { sid: result.sid, name: input.name });
    return result.sid;
  }

  async updateApplication(applicationSid: string, input: CreateApplicationInput): Promise<void> {
    this.assertConfigured();
    const existing = await this.jambonzFetch<Record<string, unknown>>(
      `/Applications/${applicationSid}`,
      { method: 'GET' },
    );
    const payload: Record<string, unknown> = {
      name: input.name,
      call_hook: existing.call_hook,
      call_status_hook: existing.call_status_hook,
    };
    if (input.asrVendor !== undefined) payload.speech_recognizer_vendor = input.asrVendor;
    if (input.asrLanguage !== undefined) payload.speech_recognizer_language = input.asrLanguage;
    if (input.asrRegion !== undefined) payload.speech_recognizer_label = input.asrRegion;
    if (input.ttsVendor !== undefined) payload.speech_synthesis_vendor = input.ttsVendor;
    if (input.ttsLanguage !== undefined) payload.speech_synthesis_language = input.ttsLanguage;
    if (input.ttsVoice !== undefined) payload.speech_synthesis_voice = input.ttsVoice;
    if (input.ttsRegion !== undefined) payload.speech_synthesis_label = input.ttsRegion;
    await this.jambonzFetch(`/Applications/${applicationSid}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    log.info('Jambonz application updated', { applicationSid });
  }

  async deleteApplication(applicationSid: string): Promise<void> {
    this.assertConfigured();
    await this.jambonzFetch(`/Applications/${applicationSid}`, { method: 'DELETE' });
    log.info('Jambonz application deleted', { applicationSid });
  }

  // ── Account ──────────────────────────────────────────────────────────────────

  async getAccount(): Promise<{
    sip_realm: string;
    account_sid: string;
    device_calling_application_sid: string | null;
    registration_hook: { url: string; method: string } | null;
  }> {
    this.assertConfigured();
    return this.jambonzFetch<{
      sip_realm: string;
      account_sid: string;
      device_calling_application_sid: string | null;
      registration_hook: { url: string; method: string } | null;
    }>(`/Accounts/${this.cfg.accountSid}`, { method: 'GET' });
  }

  async listApplications(): Promise<Array<{ application_sid: string; name: string }>> {
    this.assertConfigured();
    return this.jambonzFetch<Array<{ application_sid: string; name: string }>>('/Applications', {
      method: 'GET',
    });
  }

  async addPhoneNumber(input: AddPhoneNumberInput): Promise<string> {
    this.assertConfigured();
    const payload = {
      account_sid: this.cfg.accountSid,
      application_sid: input.applicationSid,
      number: input.phoneNumber,
      voip_carrier_sid: input.voipCarrierSid ?? this.cfg.voipCarrierSid,
    };
    const result = await this.jambonzFetch<{ sid: string }>('/PhoneNumbers', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    log.info('Jambonz phone number registered', {
      phoneNumber: input.phoneNumber,
      sid: result.sid,
    });
    return result.sid;
  }

  async deletePhoneNumber(phoneNumberSid: string): Promise<void> {
    this.assertConfigured();
    await this.jambonzFetch(`/PhoneNumbers/${phoneNumberSid}`, { method: 'DELETE' });
    log.info('Jambonz phone number deleted', { phoneNumberSid });
  }

  /**
   * Look up a phone number record by its number string.
   * Strips leading '+' for comparison since Jambonz stores numbers without it.
   * Returns the phone number record including application_sid, or null if not found.
   */
  async findPhoneNumberByNumber(
    number: string,
  ): Promise<{ phone_number_sid: string; number: string; application_sid: string | null } | null> {
    this.assertConfigured();
    const normalized = number.replace(/^\+/, '');
    const numbers = await this.jambonzFetch<
      Array<{ phone_number_sid: string; number: string; application_sid: string | null }>
    >('/PhoneNumbers', { method: 'GET' });
    return numbers.find((n) => n.number === normalized || n.number === number) ?? null;
  }

  /**
   * Fetch an application by SID, returning its call_hook URL.
   */
  async getApplication(applicationSid: string): Promise<{
    application_sid: string;
    name: string;
    call_hook: { url: string; method: string };
  }> {
    this.assertConfigured();
    return this.jambonzFetch<{
      application_sid: string;
      name: string;
      call_hook: { url: string; method: string };
    }>(`/Applications/${applicationSid}`, { method: 'GET' });
  }

  // ── Speech Credentials ──────────────────────────────────────────────────────

  async createSpeechCredential(input: SpeechCredentialInput): Promise<string> {
    this.assertConfigured();
    const payload: Record<string, unknown> = {
      vendor: input.vendor,
      label: input.label,
      use_for_stt: input.useForStt ? 1 : 0,
      use_for_tts: input.useForTts ? 1 : 0,
    };
    // Vendor-specific credential fields
    if (input.vendor.startsWith('custom:')) {
      if (input.authToken !== undefined) payload.auth_token = input.authToken;
      payload.custom_stt_url = input.customSttUrl ?? null;
      if (input.customTtsUrl !== undefined) payload.custom_tts_url = input.customTtsUrl;
      if (input.customTtsStreamingUrl !== undefined) {
        payload.custom_tts_streaming_url = input.customTtsStreamingUrl;
      }
      if (input.apiUri !== undefined) payload.api_uri = input.apiUri;
      if (input.options !== undefined) payload.options = input.options;
    } else if (input.vendor === 'google') {
      payload.service_key = input.apiKey;
    } else if (input.vendor === 'aws') {
      if (input.apiKey !== undefined) payload.access_key_id = input.apiKey;
      if (input.secretAccessKey !== undefined) payload.secret_access_key = input.secretAccessKey;
      if (input.awsRegion !== undefined) payload.aws_region = input.awsRegion;
      if (input.roleArn !== undefined) payload.role_arn = input.roleArn;
    } else if (input.vendor === 'microsoft') {
      if (input.apiKey !== undefined) payload.api_key = input.apiKey;
      if (input.region !== undefined) payload.region = input.region;
      if (input.customSttEndpoint !== undefined)
        payload.custom_stt_endpoint = input.customSttEndpoint;
      if (input.customSttEndpointUrl !== undefined) {
        payload.custom_stt_endpoint_url = input.customSttEndpointUrl;
      }
      if (input.customSttEndpoint !== undefined || input.customSttEndpointUrl !== undefined) {
        payload.use_custom_stt = true;
      }
    } else if (input.vendor === 'nuance') {
      if (input.clientId !== undefined) payload.client_id = input.clientId;
      if (input.secret !== undefined) payload.secret = input.secret;
      if (input.nuanceSttUri !== undefined) payload.nuance_stt_uri = input.nuanceSttUri;
      if (input.nuanceTtsUri !== undefined) payload.nuance_tts_uri = input.nuanceTtsUri;
    } else if (input.vendor === 'gladia') {
      if (input.apiKey !== undefined) payload.api_key = input.apiKey;
      if (input.region !== undefined) payload.region = input.region;
    } else if (input.vendor === 'ibm') {
      if (input.sttApiKey !== undefined) payload.stt_api_key = input.sttApiKey;
      if (input.sttRegion !== undefined) payload.stt_region = input.sttRegion;
      if (input.instanceId !== undefined) payload.instance_id = input.instanceId;
    } else if (input.vendor === 'nvidia') {
      if (input.rivaServerUri !== undefined) payload.riva_server_uri = input.rivaServerUri;
    } else if (input.vendor === 'cobalt') {
      if (input.cobaltServerUri !== undefined) payload.cobalt_server_uri = input.cobaltServerUri;
    } else if (input.vendor === 'assemblyai') {
      if (input.apiKey !== undefined) payload.api_key = input.apiKey;
      if (input.serviceVersion !== undefined) payload.service_version = input.serviceVersion;
    } else if (input.vendor === 'houndify') {
      if (input.clientId !== undefined) payload.client_id = input.clientId;
      if (input.clientKey !== undefined) payload.client_key = input.clientKey;
      if (input.userId !== undefined) payload.user_id = input.userId;
      if (input.houndifyServerUri !== undefined)
        payload.houndify_server_uri = input.houndifyServerUri;
    } else if (input.vendor === 'playht') {
      if (input.apiKey !== undefined) payload.api_key = input.apiKey;
      if (input.userId !== undefined) payload.user_id = input.userId;
      if (input.voiceEngine !== undefined) payload.voice_engine = input.voiceEngine;
    } else if (input.vendor === 'cartesia') {
      if (input.apiKey !== undefined) payload.api_key = input.apiKey;
      if (input.sttModelId !== undefined) payload.stt_model_id = input.sttModelId;
    } else if (input.vendor === 'speechmatics') {
      if (input.apiKey !== undefined) payload.api_key = input.apiKey;
      if (input.speechmaticsSttUri !== undefined) {
        payload.speechmatics_stt_uri = input.speechmaticsSttUri;
      }
    } else if (input.vendor === 'verbio') {
      if (input.clientId !== undefined) payload.client_id = input.clientId;
      if (input.clientSecret !== undefined) payload.client_secret = input.clientSecret;
      if (input.engineVersion !== undefined) payload.engine_version = input.engineVersion;
    } else {
      payload.api_key = input.apiKey;
    }
    if (input.modelId) payload.model_id = input.modelId;
    if (input.options !== undefined) payload.options = input.options;

    const result = await this.jambonzFetch<{ sid: string }>(
      `/Accounts/${this.cfg.accountSid}/SpeechCredentials`,
      { method: 'POST', body: JSON.stringify(payload) },
    );
    log.info('Jambonz speech credential created', {
      sid: result.sid,
      vendor: input.vendor,
      label: input.label,
    });
    return result.sid;
  }

  /**
   * Update a speech credential in Jambonz.
   *
   * Jambonz PUT /SpeechCredentials/:sid only supports updating:
   * use_for_tts, use_for_stt, model_id, options, and vendor-specific URIs.
   * It CANNOT update api_key, label, or vendor.
   *
   * For api_key changes, callers must delete + re-create instead.
   */
  async updateSpeechCredential(
    sid: string,
    input: { useForStt?: boolean; useForTts?: boolean; modelId?: string },
  ): Promise<void> {
    this.assertConfigured();
    const payload: Record<string, unknown> = {};
    if (input.useForStt !== undefined) payload.use_for_stt = input.useForStt ? 1 : 0;
    if (input.useForTts !== undefined) payload.use_for_tts = input.useForTts ? 1 : 0;
    if (input.modelId !== undefined) payload.model_id = input.modelId;
    await this.jambonzFetch(`/Accounts/${this.cfg.accountSid}/SpeechCredentials/${sid}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    log.info('Jambonz speech credential updated', { sid });
  }

  async deleteSpeechCredential(sid: string): Promise<void> {
    this.assertConfigured();
    await this.jambonzFetch(`/Accounts/${this.cfg.accountSid}/SpeechCredentials/${sid}`, {
      method: 'DELETE',
    });
    log.info('Jambonz speech credential deleted', { sid });
  }

  async findSpeechCredentialByVendorAndLabel(
    vendor: string,
    label: string,
  ): Promise<string | null> {
    this.assertConfigured();
    const records = await this.jambonzFetch<JambonzSpeechCredentialRecord[]>(
      `/Accounts/${this.cfg.accountSid}/SpeechCredentials`,
      { method: 'GET' },
    );
    const match = records.find((record) => record.vendor === vendor && record.label === label);
    return match?.speech_credential_sid ?? null;
  }

  async testSpeechCredential(sid: string): Promise<JambonzSpeechCredentialTestResult> {
    this.assertConfigured();
    return this.jambonzFetch<JambonzSpeechCredentialTestResult>(
      `/Accounts/${this.cfg.accountSid}/SpeechCredentials/${encodeURIComponent(sid)}/test`,
      { method: 'GET' },
    );
  }

  // ── Speech Options (Languages & Voices) ───────────────────────────────────

  async getSupportedLanguagesAndVoices(
    vendor: string,
    input: SpeechOptionsLookupInput = {},
  ): Promise<JambonzSpeechOptions> {
    this.assertConfigured();
    const params = [`vendor=${encodeURIComponent(vendor)}`];
    if (input.label) params.push(`label=${encodeURIComponent(input.label)}`);

    const result = await this.jambonzFetch<JambonzSpeechOptionsRaw>(
      `/Accounts/${this.cfg.accountSid}/SpeechCredentials/speech/supportedLanguagesAndVoices?${params.join('&')}`,
      { method: 'GET' },
    );
    log.debug('Fetched supported languages and voices', {
      vendor,
      label: input.label,
      ttsCount: result.tts?.length,
      sttCount: result.stt?.length,
    });
    return {
      tts: (result.tts ?? []).map((entry) => ({
        code: entry.value,
        name: entry.name,
        voices: (entry.voices ?? []).map((v) => ({ value: v.value, name: v.name })),
      })),
      stt: (result.stt ?? []).map((entry) => ({
        code: entry.value,
        name: entry.name,
      })),
    };
  }

  // ── VoIP Carriers (BYOC SIP) ──────────────────────────────────────────────

  async createVoipCarrier(input: CreateVoipCarrierInput): Promise<string> {
    this.assertSpConfigured();
    const payload = {
      name: input.name,
      account_sid: input.accountSid ?? this.cfg.accountSid,
      e164_leading_plus: false,
      requires_register: false,
      dtmf_type: 'rfc2833',
      is_active: true,
    };
    const result = await this.jambonzSpFetch<{ sid: string }>(
      `/ServiceProviders/${this.cfg.serviceProviderId}/VoipCarriers`,
      { method: 'POST', body: JSON.stringify(payload) },
    );
    log.info('Jambonz VoIP carrier created', { sid: result.sid, name: input.name });
    return result.sid;
  }

  async deleteVoipCarrier(carrierSid: string): Promise<void> {
    this.assertSpConfigured();
    await this.jambonzSpFetch(`/VoipCarriers/${carrierSid}`, { method: 'DELETE' });
    log.info('Jambonz VoIP carrier deleted', { carrierSid });
  }

  // ── SIP Gateways (BYOC SIP) ──────────────────────────────────────────────

  async addSipGateway(input: AddSipGatewayInput): Promise<string> {
    this.assertSpConfigured();
    const payload = {
      voip_carrier_sid: input.voipCarrierSid,
      ipv4: input.ipv4,
      netmask: input.netmask ?? 32,
      port: input.port ?? 5060,
      protocol: input.protocol ?? 'udp',
      inbound: input.inbound ?? true,
      outbound: input.outbound ?? false,
      is_active: true,
    };
    const result = await this.jambonzSpFetch<{ sid: string }>('/SipGateways', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    log.info('Jambonz SIP gateway added', { sid: result.sid, ipv4: input.ipv4 });
    return result.sid;
  }

  async deleteSipGateway(gatewaySid: string): Promise<void> {
    this.assertSpConfigured();
    await this.jambonzSpFetch(`/SipGateways/${gatewaySid}`, { method: 'DELETE' });
    log.info('Jambonz SIP gateway deleted', { gatewaySid });
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────
let _instance: JambonzProvisioningService | null = null;

export function getJambonzProvisioningService(): JambonzProvisioningService {
  if (!_instance) {
    const voiceConfig = getConfig().voice ?? {};
    _instance = new JambonzProvisioningService(voiceConfig.jambonz ?? {});
  }
  return _instance;
}
