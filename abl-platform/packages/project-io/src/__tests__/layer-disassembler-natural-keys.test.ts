import { describe, expect, it, vi } from 'vitest';
import {
  ChannelsDisassembler,
  PromptsDisassembler,
  VocabularyDisassembler,
} from '../import/layer-disassemblers/index.js';
import type { DisassembleContext } from '../import/layer-disassemblers/types.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

const OWNERSHIP = {
  projectId: 'project-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
};

function makeCtx(
  files: Map<string, string>,
  existingRecordIds: DisassembleContext['existingRecordIds'],
): DisassembleContext {
  return {
    files,
    projectId: OWNERSHIP.projectId,
    tenantId: OWNERSHIP.tenantId,
    userId: OWNERSHIP.userId,
    conflictStrategy: 'merge',
    existingRecordIds,
  };
}

describe('layer disassembler natural-key merge coverage', () => {
  it('supersedes matching prompt items and their versions while preserving unrelated prompts', async () => {
    const disassembler = new PromptsDisassembler();
    const result = await disassembler.disassemble(
      makeCtx(
        new Map([
          [
            'prompts/customer_care.prompt.json',
            JSON.stringify({
              promptId: 'imported-customer-care',
              name: 'Customer Care',
              description: 'Support tone',
              tags: ['support'],
              status: 'active',
              nextVersionNumber: 2,
              versions: [
                {
                  versionId: 'imported-customer-care-v1',
                  versionNumber: 1,
                  template: 'Hello {{name}}',
                  variables: ['name'],
                  status: 'active',
                  sourceHash: 'hash-1',
                },
              ],
            }),
          ],
        ]),
        new Map([
          [
            'prompt_library_items',
            [
              { _id: 'existing-customer-care', name: 'Customer Care' },
              { _id: 'existing-collections', name: 'Collections' },
            ],
          ],
          [
            'prompt_library_versions',
            [
              { _id: 'existing-customer-care-v1', promptId: 'existing-customer-care' },
              { _id: 'existing-collections-v1', promptId: 'existing-collections' },
            ],
          ],
        ]),
      ),
    );

    expect(result.superseded).toEqual([
      {
        layer: 'prompts',
        collection: 'prompt_library_items',
        recordId: 'existing-customer-care',
      },
      {
        layer: 'prompts',
        collection: 'prompt_library_versions',
        recordId: 'existing-customer-care-v1',
      },
    ]);
  });

  it('supersedes matching channel connections, dependent webhooks, and imported widget singleton', async () => {
    const disassembler = new ChannelsDisassembler();
    const result = await disassembler.disassemble(
      makeCtx(
        new Map([
          [
            'channels/web.channel.json',
            JSON.stringify({
              _exportedId: 'exported-web-channel',
              displayName: 'Web Chat',
              channelType: 'web',
              externalIdentifier: 'web',
            }),
          ],
          [
            'channels/webhooks/webhook.webhook.json',
            JSON.stringify({
              channelConnectionId: 'exported-web-channel',
              description: 'Inbound web events',
              eventType: 'message.created',
            }),
          ],
          ['channels/widgets/widget-config.json', JSON.stringify({ theme: 'light' })],
        ]),
        new Map([
          [
            'channel_connections',
            [
              { _id: 'existing-web-channel', displayName: 'Web Chat' },
              { _id: 'existing-slack-channel', displayName: 'Slack' },
            ],
          ],
          [
            'webhook_subscriptions',
            [
              { _id: 'existing-web-webhook', channelConnectionId: 'existing-web-channel' },
              { _id: 'existing-slack-webhook', channelConnectionId: 'existing-slack-channel' },
            ],
          ],
          ['widget_configs', [{ _id: 'existing-widget-config' }]],
        ]),
      ),
    );

    expect(result.superseded).toEqual([
      {
        layer: 'channels',
        collection: 'channel_connections',
        recordId: 'existing-web-channel',
      },
      {
        layer: 'channels',
        collection: 'webhook_subscriptions',
        recordId: 'existing-web-webhook',
      },
      {
        layer: 'channels',
        collection: 'widget_configs',
        recordId: 'existing-widget-config',
      },
    ]);
  });

  it('supersedes only matching vocabulary records by singleton and compound natural keys', async () => {
    const disassembler = new VocabularyDisassembler();
    const result = await disassembler.disassemble(
      makeCtx(
        new Map([
          [
            'vocabulary/domain-vocabulary.json',
            JSON.stringify([{ projectKnowledgeBaseId: 'kb-main', terms: ['balance'] }]),
          ],
          ['vocabulary/lookup-tables/cities.lookup.json', JSON.stringify([{ key: 'nyc' }])],
          [
            'vocabulary/schemas/customer.schema.json',
            JSON.stringify({ knowledgeBaseId: 'kb-main', name: 'Customer' }),
          ],
          ['vocabulary/facts.json', JSON.stringify([{ key: 'routing', value: 'enabled' }])],
        ]),
        new Map([
          [
            'domain_vocabularies',
            [
              { _id: 'existing-main-vocab', projectKnowledgeBaseId: 'kb-main' },
              { _id: 'existing-other-vocab', projectKnowledgeBaseId: 'kb-other' },
            ],
          ],
          [
            'lookup_entries',
            [
              { _id: 'existing-cities-nyc', tableName: 'cities', key: 'nyc' },
              { _id: 'existing-cities-sfo', tableName: 'cities', key: 'sfo' },
            ],
          ],
          [
            'canonical_schemas',
            [
              { _id: 'existing-customer-schema', knowledgeBaseId: 'kb-main' },
              { _id: 'existing-other-schema', knowledgeBaseId: 'kb-other' },
            ],
          ],
          [
            'facts',
            [
              { _id: 'existing-routing-fact', scope: 'project', key: 'routing' },
              { _id: 'existing-other-fact', scope: 'project', key: 'other' },
            ],
          ],
        ]),
      ),
    );

    expect(result.superseded).toEqual([
      {
        layer: 'vocabulary',
        collection: 'domain_vocabularies',
        recordId: 'existing-main-vocab',
      },
      {
        layer: 'vocabulary',
        collection: 'lookup_entries',
        recordId: 'existing-cities-nyc',
      },
      {
        layer: 'vocabulary',
        collection: 'canonical_schemas',
        recordId: 'existing-customer-schema',
      },
      {
        layer: 'vocabulary',
        collection: 'facts',
        recordId: 'existing-routing-fact',
      },
    ]);
  });
});
