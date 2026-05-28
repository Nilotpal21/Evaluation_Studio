import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  ProjectConfigVariable,
  ProjectLLMConfig,
  ProjectRuntimeConfig,
  PromptLibraryItem,
  PromptLibraryVersion,
  computeSourceHash,
} from '@agent-platform/database/models';
import {
  PromptLibraryService,
  resetPromptLibraryService,
} from '../services/prompt-library/prompt-library-service.js';
import { compileProjectWorkingCopy } from '../services/project-working-copy-compiler.js';

const TENANT_ID = 'wc-compile-tenant';
const PROJECT_ID = 'wc-compile-project';
const USER_ID = 'wc-compile-user';

const AGENT_DSL = `AGENT: booking_agent
GOAL: "Help users book hotels"

USE BEHAVIOR_PROFILE: whatsapp_mode
`;

const SIMPLE_AGENT_DSL = `AGENT: booking_agent
GOAL: "Help users book hotels"
`;

const PROFILE_DSL = `BEHAVIOR_PROFILE: whatsapp_mode
PRIORITY: 10
WHEN: channel.name == "whatsapp"
INSTRUCTIONS: "Use short messages."
`;

let mongod: MongoMemoryServer;
let promptLibraryService: PromptLibraryService;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create({
    binary: { version: process.env.MONGOMS_VERSION || '7.0.20' },
    instance: { launchTimeout: 30_000 },
  });
  await mongoose.connect(mongod.getUri());
  promptLibraryService = new PromptLibraryService();
});

afterEach(async () => {
  await ProjectConfigVariable.deleteMany({});
  await ProjectLLMConfig.deleteMany({});
  await ProjectRuntimeConfig.deleteMany({});
  await PromptLibraryItem.deleteMany({});
  await PromptLibraryVersion.deleteMany({});
  resetPromptLibraryService();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('compileProjectWorkingCopy', () => {
  test('compiles successfully with unresolved tool (failOnErrors: false allows graceful degradation)', async () => {
    const agentWithMissingToolDsl = `AGENT: booking_agent
GOAL: "Help users book hotels"

TOOLS:
  missing_tool(query: string) -> object
`;

    // With failOnErrors: false, tool resolution skips missing tools gracefully.
    // The agent compiles but missing tools won't have runtime implementations.
    const result = await compileProjectWorkingCopy({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      entryAgentName: 'booking_agent',
      agents: [
        {
          name: 'booking_agent',
          dslContent: agentWithMissingToolDsl,
          dslValidationStatus: 'valid',
          dslDiagnostics: [],
        },
      ],
    });
    expect(result.resolved).toBeDefined();
    expect(result.resolved.entryAgent).toBe('booking_agent');
  });

  test('fails closed when compilation returns semantic errors', async () => {
    const agentWithMissingHandoffDsl = `AGENT: Supervisor
GOAL: "Route users to the selected agent"

FLOW:
  choose:
    REASONING: false
    RESPOND: "Choose an agent"
      ACTIONS:
        - BUTTON: "Agent A" -> agent_a
    ON_ACTION:
      agent_a:
        HANDOFF: Missing_Agent
`;

    await expect(
      compileProjectWorkingCopy({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        entryAgentName: 'Supervisor',
        agents: [
          {
            name: 'Supervisor',
            dslContent: agentWithMissingHandoffDsl,
            dslValidationStatus: 'valid',
            dslDiagnostics: [],
          },
        ],
      }),
    ).rejects.toThrow('Working-copy compilation failed');
  });

  test('fails closed before compile when a working-copy agent is unvalidated', async () => {
    await expect(
      compileProjectWorkingCopy({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        entryAgentName: 'booking_agent',
        agents: [
          {
            name: 'booking_agent',
            dslContent: AGENT_DSL,
            dslValidationStatus: null,
            dslDiagnostics: [],
          },
        ],
      }),
    ).rejects.toThrow('Project DSL has validation errors');
  });

  test('fails closed before compile when persisted runtime config is invalid', async () => {
    await ProjectRuntimeConfig.create({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      extraction: {
        nlu_provider: 'advanced',
      },
    });

    await expect(
      compileProjectWorkingCopy({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        entryAgentName: 'booking_agent',
        agents: [
          {
            name: 'booking_agent',
            dslContent: SIMPLE_AGENT_DSL,
            dslValidationStatus: 'valid',
            dslDiagnostics: [],
          },
        ],
      }),
    ).rejects.toThrow('Project DSL has validation errors');
  });

  test('fails closed before compile when persisted model policy config is invalid', async () => {
    await ProjectLLMConfig.create({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      operationTierOverrides: {
        response_gen: 'voice',
      },
    });

    await expect(
      compileProjectWorkingCopy({
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        entryAgentName: 'booking_agent',
        agents: [
          {
            name: 'booking_agent',
            dslContent: SIMPLE_AGENT_DSL,
            dslValidationStatus: 'valid',
            dslDiagnostics: [],
          },
        ],
      }),
    ).rejects.toThrow('Project DSL has validation errors');
  });

  test('materializes config-backed behavior profiles and prompt-library refs before compile', async () => {
    const prompt = await promptLibraryService.createPrompt({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      name: 'booking-system',
      createdBy: USER_ID,
    });

    const version = await promptLibraryService.createVersion(String(prompt._id), {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      template: 'You are {{role}}. Help the user complete a booking.',
      variables: ['role'],
      createdBy: USER_ID,
    });

    const promoted = await promptLibraryService.promoteVersion(
      String(prompt._id),
      String(version._id),
      {
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
      },
    );

    await ProjectConfigVariable.create({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      key: 'profile:whatsapp_mode',
      value: PROFILE_DSL,
      description: 'WhatsApp behavior profile',
      createdBy: USER_ID,
    });

    const result = await compileProjectWorkingCopy({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      entryAgentName: 'booking_agent',
      agents: [
        {
          name: 'booking_agent',
          dslContent: AGENT_DSL,
          dslValidationStatus: 'valid',
          dslDiagnostics: [],
          systemPromptLibraryRef: {
            promptId: String(prompt._id),
            versionId: String(version._id),
          },
        },
      ],
    });

    expect(result.warnings).toEqual([]);
    expect(result.configVariables).toMatchObject({
      'profile:whatsapp_mode': PROFILE_DSL,
    });

    const agentIR = result.resolved.agents.booking_agent;
    expect(agentIR).toBeDefined();
    expect(agentIR.behavior_profiles).toHaveLength(1);
    expect(agentIR.behavior_profiles?.[0]?.name).toBe('whatsapp_mode');
    expect(agentIR.identity.system_prompt).toMatchObject({
      template: 'You are {{role}}. Help the user complete a booking.',
      custom: true,
      libraryRef: {
        promptId: String(prompt._id),
        versionId: String(promoted.version._id),
        resolvedHash: computeSourceHash('You are {{role}}. Help the user complete a booking.', [
          'role',
        ]),
      },
    });
  });
});
