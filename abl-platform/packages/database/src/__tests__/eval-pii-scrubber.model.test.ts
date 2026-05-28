import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  clearCollections,
  isMongoReady,
  setupTestMongo,
  teardownTestMongo,
} from './helpers/setup-mongo.js';
import { EvalPersona } from '../models/eval-persona.model.js';
import { EvalScenario } from '../models/eval-scenario.model.js';
import { Tenant } from '../models/tenant.model.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

async function createTenant(tenantId: string, scrubPiiOnStore: boolean) {
  await Tenant.create({
    _id: tenantId,
    name: tenantId,
    slug: tenantId,
    ownerId: 'owner-1',
    settings: {
      evalRetention: {
        scrubPiiOnStore,
      },
    },
  });
}

describe('eval definition PII scrubbing', () => {
  it('scrubs persona systemPrompt and scenario initialMessage when tenant flag is enabled', async ({
    skip,
  }) => {
    if (!isMongoReady()) return skip();
    await createTenant('tenant-scrub', true);

    const persona = await EvalPersona.create({
      tenantId: 'tenant-scrub',
      projectId: 'project-1',
      name: 'Persona',
      createdBy: 'user-1',
      systemPrompt: 'Reach me at eva@example.com or 555-123-4567.',
    });
    const scenario = await EvalScenario.create({
      tenantId: 'tenant-scrub',
      projectId: 'project-1',
      name: 'Scenario',
      createdBy: 'user-1',
      initialMessage: 'My SSN is 123-45-6789 and card is 4111 1111 1111 1111.',
    });

    expect(persona.systemPrompt).toBe('Reach me at [REDACTED_EMAIL] or [REDACTED_PHONE].');
    expect(scenario.initialMessage).toBe('My SSN is [REDACTED_SSN] and card is [REDACTED_CARD].');
  });

  it('preserves persona and scenario text verbatim when tenant flag is disabled', async ({
    skip,
  }) => {
    if (!isMongoReady()) return skip();
    await createTenant('tenant-plain', false);

    const personaPrompt = 'Reach me at eva@example.com or 555-123-4567.';
    const scenarioMessage = 'My SSN is 123-45-6789 and card is 4111 1111 1111 1111.';
    const persona = await EvalPersona.create({
      tenantId: 'tenant-plain',
      projectId: 'project-1',
      name: 'Persona',
      createdBy: 'user-1',
      systemPrompt: personaPrompt,
    });
    const scenario = await EvalScenario.create({
      tenantId: 'tenant-plain',
      projectId: 'project-1',
      name: 'Scenario',
      createdBy: 'user-1',
      initialMessage: scenarioMessage,
    });

    expect(persona.systemPrompt).toBe(personaPrompt);
    expect(scenario.initialMessage).toBe(scenarioMessage);
  });

  it('scrubs findOneAndUpdate writes for flagged tenants', async ({ skip }) => {
    if (!isMongoReady()) return skip();
    await createTenant('tenant-update-scrub', true);
    const persona = await EvalPersona.create({
      tenantId: 'tenant-update-scrub',
      projectId: 'project-1',
      name: 'Persona',
      createdBy: 'user-1',
      systemPrompt: 'Clean prompt',
    });

    const updated = await EvalPersona.findOneAndUpdate(
      { tenantId: 'tenant-update-scrub', _id: persona._id },
      { $set: { systemPrompt: 'Email owner@example.com.' } },
      { new: true },
    );

    expect(updated?.systemPrompt).toBe('Email [REDACTED_EMAIL].');
  });
});
