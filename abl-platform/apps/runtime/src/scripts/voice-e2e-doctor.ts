import mongoose from 'mongoose';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenvConfig({
  path: path.resolve(__dirname, '../..', '.env'),
});
dotenvConfig({
  path: path.resolve(__dirname, '../../../..', '.env'),
  override: false,
});

process.env.MONGODB_MANAGED = 'true';

const RUNTIME_BASE_URL = (
  process.env.VOICE_E2E_RUNTIME_BASE_URL ||
  process.env.RUNTIME_PUBLIC_BASE_URL ||
  process.env.RUNTIME_BASE_URL ||
  'http://localhost:3112'
).replace(/\/+$/, '');
const PUBLIC_BASE_URL = (
  process.env.VOICE_E2E_PUBLIC_BASE_URL ||
  process.env.RUNTIME_PUBLIC_BASE_URL ||
  ''
).replace(/\/+$/, '');
const DEV_LOGIN_EMAIL = process.env.VOICE_E2E_DEV_LOGIN_EMAIL || 'dev@kore.ai';
const DEV_LOGIN_NAME = process.env.VOICE_E2E_DEV_LOGIN_NAME || 'Voice E2E';
const MONGODB_URL =
  process.env.MONGODB_URL || process.env.DATABASE_URL || 'mongodb://localhost:27017/abl_platform';

const PROJECT_A_SLUG = process.env.VOICE_E2E_CALLER_PROJECT_SLUG || 'voice-e2e-project-a';
const PROJECT_B_SLUG = process.env.VOICE_E2E_PROJECT_SLUG || 'voice-e2e-project-b';
const PROJECT_A_NAME = process.env.VOICE_E2E_CALLER_PROJECT_NAME || 'Voice E2E Project A';
const PROJECT_B_NAME = process.env.VOICE_E2E_PROJECT_NAME || 'Voice E2E Project B';
const PROJECT_A_PHONE = process.env.VOICE_E2E_PROJECT_A_NUMBER || '';
const PROJECT_B_PHONE = process.env.VOICE_E2E_PROJECT_B_NUMBER || '';
const CREATE_CHANNELS = /^(1|true|yes|on)$/i.test(
  process.env.VOICE_E2E_BOOTSTRAP_CREATE_CHANNELS || '',
);
const RECREATE_CHANNELS = /^(1|true|yes|on)$/i.test(
  process.env.VOICE_E2E_BOOTSTRAP_RECREATE_CHANNELS || '',
);
const REUSE_EXISTING_NUMBERS = /^(1|true|yes|on)$/i.test(
  process.env.VOICE_E2E_BOOTSTRAP_REUSE_EXISTING_NUMBERS || '',
);

const SUPERVISOR_AGENT_DSL = `
AGENT: supervisor

GOAL: "Handle friendly phone conversations and answer clearly."
`.trimStart();

type JsonResponse<T> = {
  status: number;
  body: T;
  text: string;
};

type DevLoginResponse = {
  accessToken?: string;
  user?: {
    id: string;
    email: string;
    name?: string;
  };
  tenantId?: string;
  error?: string;
};

type ServiceInstancesResponse = {
  success?: boolean;
  instances?: Array<{
    id?: string;
    _id?: string;
    displayName?: string;
    serviceType?: string;
    isDefault?: boolean;
    isActive?: boolean;
    config?: Record<string, unknown>;
  }>;
  error?: string;
};

type AgentsResponse = {
  success?: boolean;
  agents?: Array<{
    id: string;
    name: string;
    agentPath?: string;
  }>;
  error?: string;
};

type TenantModelsResponse = {
  success?: boolean;
  models?: Array<{
    id?: string;
    displayName?: string;
    isDefault?: boolean;
    isActive?: boolean;
    inferenceEnabled?: boolean;
    _count?: {
      connections?: number;
    };
  }>;
  error?: string;
};

type ImportResponse = {
  success?: boolean;
  applied?: {
    created: number;
    updated: number;
    deleted: number;
    toolsCreated: number;
    toolsUpdated: number;
    toolsDeleted: number;
  };
  error?: string;
};

type ChannelConnectionsResponse = {
  success?: boolean;
  connections?: Array<{
    id: string;
    channelType: string;
    status: string;
    displayName?: string | null;
    config?: Record<string, unknown>;
  }>;
  error?: string;
};

type ChannelConnectionCreateResponse = {
  success?: boolean;
  connection?: {
    id: string;
    channelType: string;
    status: string;
    config?: Record<string, unknown>;
  };
  error?: string;
};

type TwilioPhoneNumbersResponse = {
  phoneNumbers?: Array<{
    sid: string;
    phoneNumber: string;
    friendlyName?: string;
  }>;
  error?: string;
};

type TwilioAvailableNumbersResponse = {
  numbers?: Array<{
    phoneNumber: string;
    friendlyName?: string;
    region?: string;
    isoCountry?: string;
  }>;
  error?: string;
};

type TwilioPurchaseNumberResponse = {
  phoneNumber?: {
    sid: string;
    phoneNumber: string;
    friendlyName?: string;
  };
  error?: string;
};

type TwilioOwnedNumber = {
  sid: string;
  phoneNumber: string;
  trunkSid: string | null;
};

interface DoctorCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

interface ProjectBootstrapBase {
  projectId: string;
  slug: string;
  name: string;
  created: boolean;
  supervisorReady: boolean;
}

interface ProjectBootstrapResult {
  projectId: string;
  slug: string;
  name: string;
  created: boolean;
  supervisorReady: boolean;
  voiceChannel?: {
    id: string;
    phoneNumber?: string;
    status: string;
    created: boolean;
    numberSource?: 'requested' | 'existing' | 'purchased';
  };
}

function ok(label: string, detail?: string): DoctorCheck {
  return { label, ok: true, detail };
}

function fail(label: string, detail?: string): DoctorCheck {
  return { label, ok: false, detail };
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<JsonResponse<T>> {
  const response = await fetch(url, options);
  const text = await response.text();
  const body = text.length > 0 ? (JSON.parse(text) as T) : ({} as T);
  return {
    status: response.status,
    body,
    text,
  };
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function devLogin(): Promise<{
  token: string;
  userId: string;
  tenantId: string;
  email: string;
}> {
  const response = await fetchJson<DevLoginResponse>(`${RUNTIME_BASE_URL}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: DEV_LOGIN_EMAIL,
      name: DEV_LOGIN_NAME,
    }),
  });

  if (response.status !== 200 || !response.body.accessToken || !response.body.user?.id) {
    throw new Error(`dev-login failed (${response.status}): ${response.text}`);
  }
  if (!response.body.tenantId) {
    throw new Error(
      `dev-login succeeded for ${DEV_LOGIN_EMAIL}, but no tenantId was returned. Join a tenant first.`,
    );
  }

  return {
    token: response.body.accessToken,
    userId: response.body.user.id,
    tenantId: response.body.tenantId,
    email: response.body.user.email,
  };
}

async function listServiceInstances(
  token: string,
  tenantId: string,
  serviceType: 'deepgram' | 'elevenlabs' | 'twilio',
): Promise<ServiceInstancesResponse['instances']> {
  const response = await fetchJson<ServiceInstancesResponse>(
    `${RUNTIME_BASE_URL}/api/tenants/${encodeURIComponent(tenantId)}/service-instances?serviceType=${encodeURIComponent(serviceType)}&isActive=true`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (response.status !== 200 || !response.body.success) {
    throw new Error(
      `Failed to list ${serviceType} service instances (${response.status}): ${response.text}`,
    );
  }

  return response.body.instances || [];
}

async function listAgents(token: string, projectId: string): Promise<AgentsResponse['agents']> {
  const response = await fetchJson<AgentsResponse>(
    `${RUNTIME_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/agents`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (response.status !== 200 || !response.body.success) {
    throw new Error(`Failed to list agents (${response.status}): ${response.text}`);
  }

  return response.body.agents || [];
}

async function listTenantModelsForInference(
  token: string,
  tenantId: string,
): Promise<NonNullable<TenantModelsResponse['models']>> {
  const response = await fetchJson<TenantModelsResponse>(
    `${RUNTIME_BASE_URL}/api/tenants/${encodeURIComponent(tenantId)}/models?isActive=true&limit=100`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (response.status !== 200 || !response.body.success || !Array.isArray(response.body.models)) {
    throw new Error(`Failed to list tenant models (${response.status}): ${response.text}`);
  }

  return response.body.models || [];
}

async function importSupervisorAgent(token: string, projectId: string): Promise<void> {
  const response = await fetchJson<ImportResponse>(
    `${RUNTIME_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/project-io/import`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        files: {
          'agents/supervisor.agent.abl': SUPERVISOR_AGENT_DSL,
        },
      }),
    },
  );

  if (response.status !== 200 || !response.body.success) {
    throw new Error(`Failed to import supervisor agent (${response.status}): ${response.text}`);
  }
}

async function listChannelConnections(
  token: string,
  projectId: string,
): Promise<ChannelConnectionsResponse['connections']> {
  const response = await fetchJson<ChannelConnectionsResponse>(
    `${RUNTIME_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/channel-connections`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (response.status !== 200 || !response.body.success) {
    throw new Error(`Failed to list channel connections (${response.status}): ${response.text}`);
  }

  return response.body.connections || [];
}

async function createVoicePipelineChannel(
  token: string,
  projectId: string,
  displayName: string,
  phoneNumber: string,
): Promise<ChannelConnectionCreateResponse['connection']> {
  const response = await fetchJson<ChannelConnectionCreateResponse>(
    `${RUNTIME_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/channel-connections`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        channel_type: 'voice_pipeline',
        display_name: displayName,
        external_identifier: phoneNumber,
        config: {
          phoneNumber,
          asrVendor: 'deepgram',
          ttsVendor: 'elevenlabs',
        },
      }),
    },
  );

  if (response.status !== 201 || !response.body.success || !response.body.connection) {
    throw new Error(`Failed to create voice channel (${response.status}): ${response.text}`);
  }

  return response.body.connection;
}

async function deleteChannelConnection(
  token: string,
  projectId: string,
  connectionId: string,
): Promise<void> {
  const response = await fetchJson<{ success?: boolean; error?: string }>(
    `${RUNTIME_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/channel-connections/${encodeURIComponent(connectionId)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (response.status !== 200 || !response.body.success) {
    throw new Error(`Failed to delete voice channel (${response.status}): ${response.text}`);
  }
}

async function listTwilioPhoneNumbers(
  token: string,
): Promise<NonNullable<TwilioPhoneNumbersResponse['phoneNumbers']>> {
  const response = await fetchJson<TwilioPhoneNumbersResponse>(
    `${RUNTIME_BASE_URL}/api/v1/voice/twilio/phone-numbers`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (response.status !== 200 || !Array.isArray(response.body.phoneNumbers)) {
    throw new Error(`Failed to list Twilio phone numbers (${response.status}): ${response.text}`);
  }

  return response.body.phoneNumbers || [];
}

async function searchAvailableTwilioNumbers(
  token: string,
): Promise<NonNullable<TwilioAvailableNumbersResponse['numbers']>> {
  const countryCode = process.env.VOICE_E2E_TWILIO_COUNTRY_CODE || 'US';
  const numberType = process.env.VOICE_E2E_TWILIO_NUMBER_TYPE || 'local';
  const areaCode = process.env.VOICE_E2E_TWILIO_AREA_CODE;
  const params = new URLSearchParams({
    countryCode,
    numberType,
  });
  if (areaCode) {
    params.set('areaCode', areaCode);
  }

  const response = await fetchJson<TwilioAvailableNumbersResponse>(
    `${RUNTIME_BASE_URL}/api/v1/voice/twilio/available-numbers?${params.toString()}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  );

  if (response.status !== 200 || !Array.isArray(response.body.numbers)) {
    throw new Error(
      `Failed to search available Twilio numbers (${response.status}): ${response.text}`,
    );
  }

  return response.body.numbers || [];
}

async function purchaseTwilioPhoneNumber(
  token: string,
  phoneNumber: string,
): Promise<NonNullable<TwilioPurchaseNumberResponse['phoneNumber']>> {
  const response = await fetchJson<TwilioPurchaseNumberResponse>(
    `${RUNTIME_BASE_URL}/api/v1/voice/twilio/purchase-number`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ phoneNumber }),
    },
  );

  if (response.status !== 200 || !response.body.phoneNumber) {
    throw new Error(`Failed to purchase Twilio number (${response.status}): ${response.text}`);
  }

  return response.body.phoneNumber;
}

async function createTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
  const authToken = process.env.TWILIO_AUTH_TOKEN || '';
  if (!accountSid || !authToken) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required for Twilio bootstrap');
  }

  const twilioModule = await import('twilio');
  return twilioModule.default(accountSid, authToken);
}

async function listOwnedTwilioNumbersDetailed(): Promise<TwilioOwnedNumber[]> {
  const client = await createTwilioClient();
  const numbers = await client.incomingPhoneNumbers.list({ limit: 500 });

  return numbers.map((number) => ({
    sid: String(number.sid),
    phoneNumber: normalizePhoneNumber(String(number.phoneNumber)),
    trunkSid:
      typeof number.trunkSid === 'string' && number.trunkSid.trim().length > 0
        ? number.trunkSid
        : null,
  }));
}

async function ensureTwilioNumberAssignedToTrunk(
  phoneNumber: string,
  ownedNumbers: TwilioOwnedNumber[],
): Promise<void> {
  const expectedTrunkSid = process.env.TWILIO_TRUNK_SID || '';
  if (!expectedTrunkSid) {
    throw new Error(
      `TWILIO_TRUNK_SID is required to auto-assign ${phoneNumber} for inbound voice routing`,
    );
  }

  const normalizedPhoneNumber = normalizePhoneNumber(phoneNumber);
  const existing = ownedNumbers.find((entry) => entry.phoneNumber === normalizedPhoneNumber);
  if (!existing) {
    throw new Error(`Twilio number ${phoneNumber} is not owned by the current account`);
  }
  if (existing.trunkSid === expectedTrunkSid) {
    return;
  }

  const client = await createTwilioClient();
  const updated = await client.incomingPhoneNumbers(existing.sid).update({
    trunkSid: expectedTrunkSid,
  });
  existing.trunkSid =
    typeof updated.trunkSid === 'string' && updated.trunkSid.trim().length > 0
      ? updated.trunkSid
      : expectedTrunkSid;
}

async function listAssignedVoicePhoneNumbers(tenantId: string): Promise<Set<string>> {
  const { ChannelConnection } = await import('@agent-platform/database/models');
  const docs = await ChannelConnection.find({
    tenantId,
    status: 'active',
  })
    .select({ channelType: 1, config: 1 })
    .lean()
    .exec();

  const assignedNumbers = new Set<string>();
  for (const doc of docs) {
    const config = doc?.config as Record<string, unknown> | undefined;
    const phoneNumber = typeof config?.phoneNumber === 'string' ? config.phoneNumber.trim() : '';
    if (phoneNumber) {
      assignedNumbers.add(phoneNumber);
    }
  }
  return assignedNumbers;
}

function normalizePhoneNumber(phoneNumber: string): string {
  return phoneNumber.trim();
}

async function resolvePhoneNumberForProject(input: {
  token: string;
  projectName: string;
  requestedPhoneNumber: string;
  assignedNumbers: Set<string>;
  reservedNumbers: Set<string>;
  ownedTwilioNumbers: TwilioOwnedNumber[];
}): Promise<{ phoneNumber: string; source: 'requested' | 'existing' | 'purchased' }> {
  const requestedPhoneNumber = normalizePhoneNumber(input.requestedPhoneNumber);
  if (requestedPhoneNumber) {
    await ensureTwilioNumberAssignedToTrunk(requestedPhoneNumber, input.ownedTwilioNumbers);
    input.reservedNumbers.add(requestedPhoneNumber);
    return {
      phoneNumber: requestedPhoneNumber,
      source: 'requested',
    };
  }

  if (REUSE_EXISTING_NUMBERS) {
    for (const number of input.ownedTwilioNumbers) {
      const candidate = normalizePhoneNumber(number.phoneNumber);
      if (!candidate) {
        continue;
      }
      if (input.assignedNumbers.has(candidate) || input.reservedNumbers.has(candidate)) {
        continue;
      }
      await ensureTwilioNumberAssignedToTrunk(candidate, input.ownedTwilioNumbers);
      input.reservedNumbers.add(candidate);
      return {
        phoneNumber: candidate,
        source: 'existing',
      };
    }
  }

  const availableNumbers = await searchAvailableTwilioNumbers(input.token);
  const available = availableNumbers.find((number) => {
    const candidate = normalizePhoneNumber(number.phoneNumber);
    return (
      candidate && !input.assignedNumbers.has(candidate) && !input.reservedNumbers.has(candidate)
    );
  });

  if (!available?.phoneNumber) {
    throw new Error(
      `No reusable or purchasable Twilio number was found for ${input.projectName}. Check Twilio inventory or set VOICE_E2E_PROJECT_A_NUMBER / VOICE_E2E_PROJECT_B_NUMBER explicitly.`,
    );
  }

  const purchased = await purchaseTwilioPhoneNumber(input.token, available.phoneNumber);
  const purchasedPhoneNumber = normalizePhoneNumber(purchased.phoneNumber);
  input.ownedTwilioNumbers.push({
    sid: purchased.sid,
    phoneNumber: purchasedPhoneNumber,
    trunkSid: null,
  });
  await ensureTwilioNumberAssignedToTrunk(purchasedPhoneNumber, input.ownedTwilioNumbers);
  input.reservedNumbers.add(purchasedPhoneNumber);
  return {
    phoneNumber: purchasedPhoneNumber,
    source: 'purchased',
  };
}

async function findOrCreateProject(input: {
  tenantId: string;
  ownerId: string;
  slug: string;
  name: string;
}): Promise<{ id: string; created: boolean }> {
  const { Project } = await import('@agent-platform/database/models');
  const existing = await Project.findOne({
    tenantId: input.tenantId,
    slug: input.slug,
  })
    .lean()
    .exec();

  if (existing?._id) {
    return { id: String(existing._id), created: false };
  }

  const created = await Project.create({
    name: input.name,
    slug: input.slug,
    ownerId: input.ownerId,
    tenantId: input.tenantId,
    entryAgentName: 'supervisor',
  });

  return { id: String(created._id), created: true };
}

async function ensureEntryAgent(projectId: string, tenantId: string): Promise<void> {
  const { Project } = await import('@agent-platform/database/models');
  await Project.findOneAndUpdate(
    { _id: projectId, tenantId },
    {
      $set: {
        entryAgentName: 'supervisor',
      },
    },
  ).exec();
}

async function bootstrapProjectBase(input: {
  token: string;
  tenantId: string;
  userId: string;
  slug: string;
  name: string;
}): Promise<ProjectBootstrapBase> {
  const project = await findOrCreateProject({
    tenantId: input.tenantId,
    ownerId: input.userId,
    slug: input.slug,
    name: input.name,
  });

  await ensureEntryAgent(project.id, input.tenantId);

  const agents = await listAgents(input.token, project.id);
  const hasSupervisor = agents?.some((agent) => agent.name === 'supervisor') ?? false;
  if (!hasSupervisor) {
    await importSupervisorAgent(input.token, project.id);
  }

  return {
    projectId: project.id,
    slug: input.slug,
    name: input.name,
    created: project.created,
    supervisorReady: true,
  };
}

async function ensureVoiceChannel(input: {
  token: string;
  tenantId: string;
  project: ProjectBootstrapBase;
  requestedPhoneNumber: string;
  assignedNumbers: Set<string>;
  reservedNumbers: Set<string>;
  ownedTwilioNumbers: TwilioOwnedNumber[];
}): Promise<ProjectBootstrapResult> {
  const connections = await listChannelConnections(input.token, input.project.projectId);
  const activeVoiceConnection = connections?.find(
    (connection) => connection.channelType === 'voice_pipeline' && connection.status === 'active',
  );

  if (activeVoiceConnection && !(CREATE_CHANNELS && RECREATE_CHANNELS)) {
    const activePhoneNumber =
      typeof activeVoiceConnection.config?.phoneNumber === 'string'
        ? activeVoiceConnection.config.phoneNumber
        : undefined;
    if (activePhoneNumber) {
      await ensureTwilioNumberAssignedToTrunk(activePhoneNumber, input.ownedTwilioNumbers);
    }

    return {
      ...input.project,
      voiceChannel: {
        id: activeVoiceConnection.id,
        phoneNumber: activePhoneNumber,
        status: activeVoiceConnection.status,
        created: false,
      },
    };
  }

  if (!CREATE_CHANNELS) {
    return {
      ...input.project,
    };
  }

  if (activeVoiceConnection && RECREATE_CHANNELS) {
    await deleteChannelConnection(input.token, input.project.projectId, activeVoiceConnection.id);
  }

  const allocation = await resolvePhoneNumberForProject({
    token: input.token,
    projectName: input.project.name,
    requestedPhoneNumber: input.requestedPhoneNumber,
    assignedNumbers: input.assignedNumbers,
    reservedNumbers: input.reservedNumbers,
    ownedTwilioNumbers: input.ownedTwilioNumbers,
  });

  const createdConnection = await createVoicePipelineChannel(
    input.token,
    input.project.projectId,
    `${input.project.name} Voice`,
    allocation.phoneNumber,
  );
  if (!createdConnection) {
    throw new Error(
      `Voice channel creation returned no connection for project ${input.project.projectId}`,
    );
  }

  input.assignedNumbers.add(allocation.phoneNumber);
  return {
    ...input.project,
    voiceChannel: {
      id: createdConnection.id,
      phoneNumber:
        typeof createdConnection.config?.phoneNumber === 'string'
          ? createdConnection.config.phoneNumber
          : allocation.phoneNumber,
      status: createdConnection.status,
      created: true,
      numberSource: allocation.source,
    },
  };
}

function printChecks(title: string, checks: DoctorCheck[]): void {
  console.log(`\n${title}`);
  for (const check of checks) {
    const prefix = check.ok ? '[OK]' : '[MISSING]';
    console.log(`- ${prefix} ${check.label}${check.detail ? `: ${check.detail}` : ''}`);
  }
}

function printProjectSummary(result: ProjectBootstrapResult): void {
  console.log(`- ${result.name} (${result.slug})`);
  console.log(`  projectId=${result.projectId}`);
  console.log(`  project=${result.created ? 'created' : 'found'}`);
  console.log(`  supervisor=${result.supervisorReady ? 'ready' : 'missing'}`);
  if (result.voiceChannel) {
    console.log(
      `  voiceChannel=${result.voiceChannel.created ? 'created' : 'found'} (${result.voiceChannel.id}) phone=${result.voiceChannel.phoneNumber || 'n/a'} status=${result.voiceChannel.status}${result.voiceChannel.numberSource ? ` source=${result.voiceChannel.numberSource}` : ''}`,
    );
  } else {
    console.log('  voiceChannel=missing');
  }
}

async function main(): Promise<void> {
  const envChecks: DoctorCheck[] = [];
  envChecks.push(
    process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
      ? ok('Twilio runtime env', 'TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN present')
      : fail('Twilio runtime env', 'Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in runtime env'),
  );
  envChecks.push(
    process.env.TWILIO_TRUNK_SID
      ? ok('Twilio SIP trunk env', 'TWILIO_TRUNK_SID present')
      : fail(
          'Twilio SIP trunk env',
          'Set TWILIO_TRUNK_SID in runtime env for inbound voice routing',
        ),
  );
  envChecks.push(
    process.env.JAMBONZ_BASE_API_URL &&
      process.env.JAMBONZ_ACCOUNT_SID &&
      process.env.JAMBONZ_API_KEY
      ? ok('Jambonz runtime env', 'JAMBONZ_BASE_API_URL + ACCOUNT_SID + API_KEY present')
      : fail(
          'Jambonz runtime env',
          'Set JAMBONZ_BASE_API_URL, JAMBONZ_ACCOUNT_SID, and JAMBONZ_API_KEY in runtime env',
        ),
  );
  envChecks.push(
    process.env.DEEPGRAM_API_KEY
      ? ok('Deepgram env', 'DEEPGRAM_API_KEY present')
      : fail('Deepgram env', 'Set DEEPGRAM_API_KEY in runtime env or tenant service instances'),
  );
  envChecks.push(
    process.env.ELEVENLABS_API_KEY
      ? ok('ElevenLabs env', 'ELEVENLABS_API_KEY present')
      : fail('ElevenLabs env', 'Set ELEVENLABS_API_KEY in runtime env or tenant service instances'),
  );
  envChecks.push(
    PUBLIC_BASE_URL
      ? ok('Public runtime URL', PUBLIC_BASE_URL)
      : ok(
          'Public runtime URL',
          'Not set. Live test can still fall back to Twilio <Say>, but fixture audio URLs work better with a public URL.',
        ),
  );
  envChecks.push(
    MONGODB_URL
      ? ok('MongoDB URL', 'MONGODB_URL resolved for local bootstrap')
      : fail('MongoDB URL'),
  );

  console.log('Voice E2E Doctor');
  console.log(`runtime=${RUNTIME_BASE_URL}`);
  console.log(`devLogin=${DEV_LOGIN_EMAIL}`);
  printChecks('Environment', envChecks);
  const envFailures = envChecks.filter((check) => !check.ok);

  let login:
    | {
        token: string;
        userId: string;
        tenantId: string;
        email: string;
      }
    | undefined;

  const runtimeChecks: DoctorCheck[] = [];
  try {
    login = await devLogin();
    runtimeChecks.push(ok('Runtime dev-login', `${login.email} tenant=${login.tenantId}`));
  } catch (err) {
    runtimeChecks.push(fail('Runtime dev-login', err instanceof Error ? err.message : String(err)));
    printChecks('Runtime', runtimeChecks);
    process.exitCode = 1;
    return;
  }

  let twilioNumbers: NonNullable<TwilioPhoneNumbersResponse['phoneNumbers']> = [];
  let ownedTwilioNumbers: TwilioOwnedNumber[] = [];
  try {
    twilioNumbers = await listTwilioPhoneNumbers(login.token);
    runtimeChecks.push(
      ok('Twilio numbers reachable', `${twilioNumbers.length} number(s) available`),
    );
    ownedTwilioNumbers = await listOwnedTwilioNumbersDetailed();
  } catch (err) {
    runtimeChecks.push(
      fail('Twilio numbers reachable', err instanceof Error ? err.message : String(err)),
    );
  }

  for (const serviceType of ['deepgram', 'elevenlabs', 'twilio'] as const) {
    try {
      const instances = await listServiceInstances(login.token, login.tenantId, serviceType);
      runtimeChecks.push(
        instances && instances.length > 0
          ? ok(`${serviceType} tenant service instance`, `${instances.length} active instance(s)`)
          : serviceType === 'twilio'
            ? ok(
                `${serviceType} tenant service instance`,
                `No active tenant-scoped Twilio instance found for ${login.tenantId}. Runtime-level Twilio env vars are enough for this live telephony test.`,
              )
            : fail(
                `${serviceType} tenant service instance`,
                `No active ${serviceType} service instance found for tenant ${login.tenantId}`,
              ),
      );
    } catch (err) {
      runtimeChecks.push(
        fail(
          `${serviceType} tenant service instance`,
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }

  try {
    const tenantModels = await listTenantModelsForInference(login.token, login.tenantId);
    const activeInferenceModels = tenantModels.filter(
      (model) =>
        model.isActive === true &&
        model.inferenceEnabled === true &&
        model.isDefault === true &&
        (model._count?.connections || 0) > 0,
    );
    runtimeChecks.push(
      activeInferenceModels.length > 0
        ? ok(
            'Tenant model for inference',
            `${activeInferenceModels.length} active default model(s) with connection(s)`,
          )
        : fail(
            'Tenant model for inference',
            `No active default tenant model with an enabled inference connection was found for tenant ${login.tenantId}`,
          ),
    );
  } catch (err) {
    runtimeChecks.push(
      fail('Tenant model for inference', err instanceof Error ? err.message : String(err)),
    );
  }

  printChecks('Runtime', runtimeChecks);
  const runtimeFailures = runtimeChecks.filter((check) => !check.ok);

  await mongoose.connect(MONGODB_URL);

  let assignedVoicePhoneNumbers = new Set<string>();
  let projectA: ProjectBootstrapResult | undefined;
  let projectB: ProjectBootstrapResult | undefined;
  try {
    assignedVoicePhoneNumbers = await listAssignedVoicePhoneNumbers(login.tenantId);

    const projectABase = await bootstrapProjectBase({
      token: login.token,
      tenantId: login.tenantId,
      userId: login.userId,
      slug: PROJECT_A_SLUG,
      name: PROJECT_A_NAME,
    });

    const projectBBase = await bootstrapProjectBase({
      token: login.token,
      tenantId: login.tenantId,
      userId: login.userId,
      slug: PROJECT_B_SLUG,
      name: PROJECT_B_NAME,
    });

    const reservedNumbers = new Set<string>();
    projectA = await ensureVoiceChannel({
      token: login.token,
      tenantId: login.tenantId,
      project: projectABase,
      requestedPhoneNumber: PROJECT_A_PHONE,
      assignedNumbers: assignedVoicePhoneNumbers,
      reservedNumbers,
      ownedTwilioNumbers,
    });

    if (projectA.voiceChannel?.phoneNumber) {
      reservedNumbers.add(projectA.voiceChannel.phoneNumber);
      assignedVoicePhoneNumbers.add(projectA.voiceChannel.phoneNumber);
    }

    projectB = await ensureVoiceChannel({
      token: login.token,
      tenantId: login.tenantId,
      project: projectBBase,
      requestedPhoneNumber: PROJECT_B_PHONE,
      assignedNumbers: assignedVoicePhoneNumbers,
      reservedNumbers,
      ownedTwilioNumbers,
    });
  } finally {
    await mongoose.disconnect();
  }

  console.log('\nProjects');
  printProjectSummary(projectA);
  printProjectSummary(projectB);

  const nextSteps: string[] = [];
  if (!projectA.voiceChannel) {
    nextSteps.push(
      `Project A has no active voice_pipeline channel. ${
        CREATE_CHANNELS
          ? 'Automatic number allocation did not complete. Check Twilio inventory/permissions or create one manually.'
          : 'Set VOICE_E2E_BOOTSTRAP_CREATE_CHANNELS=true to auto-create one, or create one manually.'
      }`,
    );
  }
  if (!projectB.voiceChannel) {
    nextSteps.push(
      `Project B has no active voice_pipeline channel. ${
        CREATE_CHANNELS
          ? 'Automatic number allocation did not complete. Check Twilio inventory/permissions or create one manually.'
          : 'Set VOICE_E2E_BOOTSTRAP_CREATE_CHANNELS=true to auto-create one, or create one manually.'
      }`,
    );
  }
  if ((twilioNumbers?.length || 0) < 2) {
    nextSteps.push(
      'Fewer than two Twilio numbers are visible. Dual-call voice E2E is easiest with two numbers.',
    );
  }

  console.log('\nSuggested env for the live test');
  console.log(`VOICE_E2E_RUNTIME_BASE_URL=${RUNTIME_BASE_URL}`);
  console.log(`VOICE_E2E_DEV_LOGIN_EMAIL=${DEV_LOGIN_EMAIL}`);
  console.log(`VOICE_E2E_PROJECT_ID=${projectB.projectId}`);
  console.log(`VOICE_E2E_CALLER_PROJECT_ID=${projectA.projectId}`);
  console.log(`VOICE_E2E_CALLER_VOICE_PROJECT_ID=${projectA.projectId}`);
  if (projectB.voiceChannel?.phoneNumber) {
    console.log(`VOICE_E2E_TO_NUMBER=${projectB.voiceChannel.phoneNumber}`);
  }
  if (projectA.voiceChannel?.phoneNumber) {
    console.log(`VOICE_E2E_CALLER_TO_NUMBER=${projectA.voiceChannel.phoneNumber}`);
  }
  if (PUBLIC_BASE_URL) {
    console.log(`VOICE_E2E_PUBLIC_BASE_URL=${PUBLIC_BASE_URL}`);
  }

  if (nextSteps.length > 0) {
    console.log('\nNeeds attention');
    for (const step of nextSteps) {
      console.log(`- ${step}`);
    }
  }

  if (envFailures.length > 0 || runtimeFailures.length > 0 || nextSteps.length > 0) {
    process.exitCode = 1;
    return;
  }

  console.log('\nReady');
  console.log(
    'The shared voice E2E projects, supervisor agents, and active voice channels are present. You can run the live voice E2E now.',
  );
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  try {
    await mongoose.disconnect();
  } catch {
    // best effort
  }
  process.exitCode = 1;
});
